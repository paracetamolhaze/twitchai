# Dashboard: Vite build served as static files.
#
# VITE_API_URL is baked in at build time — Vite substitutes import.meta.env during the build, so it
# cannot be changed by an environment variable on the running container. Pass it as a build arg;
# pointing the dashboard at a different backend means rebuilding this image.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget --spider -q http://127.0.0.1/ || exit 1
