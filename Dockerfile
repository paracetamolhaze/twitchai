# Backend: Node service plus the two binaries the media pipeline spawns.
#
# streamlink and ffmpeg are runtime dependencies as real as anything in package.json — the media
# pipeline spawns them by name — but they were previously whatever the host happened to provide,
# which is why the stack could not be reproduced off Railway. Pinning them here is the point of
# containerising this at all.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Only the manifests first, so a source-only change reuses the cached install layer.
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
RUN npm run build:backend

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# python3-minimal covers streamlink; ffmpeg brings its own codecs. --no-install-recommends keeps
# the image from pulling a desktop's worth of optional packages.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3-minimal python3-pip ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages streamlink \
  && apt-get purge -y python3-pip \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations

# Never run the stream capture as root: streamlink and ffmpeg parse untrusted remote media.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]
