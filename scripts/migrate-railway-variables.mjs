import 'dotenv/config';
import { readFileSync } from 'node:fs';

const endpoint = 'https://backboard.railway.app/graphql/v2';
const sourceToken = process.env.RAILWAY_SOURCE_TOKEN || readLocalSecret('railway source token');
const targetToken = process.env.RAILWAY_TARGET_TOKEN || process.env['railway token'] || readLocalSecret('railway token');
const sourceProjectId = process.env.RAILWAY_SOURCE_PROJECT_ID || '98698134-38cc-4866-bce3-14c38996c24a';
const sourceEnvironmentId = process.env.RAILWAY_SOURCE_ENVIRONMENT_ID || '2bad05fe-5df5-4b8f-a353-43adc258ae4f';
const sourceServiceIdFromEnv = process.env.RAILWAY_SOURCE_SERVICE_ID;
const targetProjectId = process.env.RAILWAY_TARGET_PROJECT_ID || '4bd290ce-685c-4158-a878-b5474b0f5315';
const targetEnvironmentId = process.env.RAILWAY_TARGET_ENVIRONMENT_ID || '189c15f7-8bb3-4233-9e9a-6429b60a91e6';
const targetServiceId = process.env.RAILWAY_TARGET_SERVICE_ID || '35c05e6b-8eba-4227-aa09-3cfdb84d98a0';

if (!sourceToken) throw new Error('RAILWAY_SOURCE_TOKEN is required and must have access to the old Railway workspace.');
if (!targetToken) throw new Error('RAILWAY_TARGET_TOKEN is required.');

const project = await graphql(sourceToken, `query sourceProject($id: String!) {
  project(id: $id) { services { edges { node { id name } } } }
}`, { id: sourceProjectId });
const services = project.project?.services?.edges?.map((edge) => edge.node) || [];
const sourceServiceId = sourceServiceIdFromEnv
  || services.find((service) => service.name === 'twitch-ai-viewers')?.id
  || services.find((service) => !/postgres/i.test(service.name))?.id;
if (!sourceServiceId) throw new Error('Could not identify the old Railway application service. Set RAILWAY_SOURCE_SERVICE_ID.');

const source = await graphql(sourceToken, `query sourceVariables($projectId: String!, $environmentId: String!, $serviceId: String) {
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
}`, { projectId: sourceProjectId, environmentId: sourceEnvironmentId, serviceId: sourceServiceId });
const compatibleVariables = Object.fromEntries(Object.entries(source.variables || {}).filter(([name]) => shouldCopy(name)));
const names = Object.keys(compatibleVariables).sort();
if (names.length === 0) throw new Error('No compatible variables were readable. Sealed variables must be recreated manually.');

await graphql(targetToken, `mutation copyVariables($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}`, {
  input: {
    projectId: targetProjectId,
    environmentId: targetEnvironmentId,
    serviceId: targetServiceId,
    variables: compatibleVariables,
  },
});

console.log(`Copied ${names.length} compatible Railway variables without printing their values.`);
console.log(names.join(', '));
console.log('TWITCH_CHANNEL, DATABASE_URL, FRONTEND_URL and DASHBOARD_TOKEN were intentionally preserved in the new project.');

function shouldCopy(name) {
  if (/^BOT\d+_(USERNAME|OAUTH|OAUTH_TOKEN|PERSONA|ENABLED)$/.test(name)) return true;
  return new Set([
    'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_CATEGORY_REFRESH_SECONDS',
    'GEMINI_API_KEY', 'GEMINI_LIVE_MODEL', 'STREAM_CONTEXT', 'VISION_FPS', 'VISION_FRAME_WIDTH',
    'EVENT_CONFIDENCE_THRESHOLD', 'STREAM_CONTEXT_REFRESH_SECONDS',
    'REACTION_MIN_DELAY_MS', 'REACTION_MAX_DELAY_MS', 'CHAT_MESSAGES_PER_30_SECONDS', 'MAX_REACTIONS_PER_EVENT',
    'LEARN_ENABLED', 'LEARN_REACTION_WINDOW_SECONDS', 'LEARN_RETRIEVAL_LIMIT',
    'TRANSCRIPTION_PROVIDER', 'TRANSCRIPTION_FALLBACK', 'GROQ_API_KEY', 'ORIGINAL_STREAM_LANGUAGE',
  ]).has(name);
}

async function graphql(token, query, variables) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.map((error) => error.message).join('; ') || `Railway API returned HTTP ${response.status}`);
  }
  return body.data;
}

function readLocalSecret(name) {
  try {
    const line = readFileSync('.env', 'utf8').split(/\r?\n/).find((candidate) => candidate.trimStart().startsWith(`${name}=`));
    return line?.slice(line.indexOf('=') + 1).trim();
  } catch {
    return undefined;
  }
}
