import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const endpoint = 'https://backboard.railway.app/graphql/v2';
const inputPath = path.resolve(process.argv[2] || 'twitchaccs.txt');
const railwayToken = process.env.RAILWAY_TARGET_TOKEN
  || process.env.RAILWAY_API_TOKEN
  || readLocalSecret('railway token');
const targetProjectId = process.env.RAILWAY_TARGET_PROJECT_ID || '4bd290ce-685c-4158-a878-b5474b0f5315';
const targetEnvironmentId = process.env.RAILWAY_TARGET_ENVIRONMENT_ID || '189c15f7-8bb3-4233-9e9a-6429b60a91e6';
const targetServiceId = process.env.RAILWAY_TARGET_SERVICE_ID || '35c05e6b-8eba-4227-aa09-3cfdb84d98a0';
const personaIds = ['analyst', 'hype', 'dry-joker', 'friendly-regular'];
const maximumBotAccounts = 50;

if (!railwayToken) throw new Error('RAILWAY_TARGET_TOKEN is required.');

const groups = splitAccountGroups(readFileSync(inputPath, 'utf8'));
if (groups.length === 0) throw new Error('No account records were found.');

const validatedGroups = await Promise.all(groups.map(async (lines, groupIndex) => {
  const tokens = [...new Set(lines.flatMap((line, lineIndex) => extractTokenCandidate(line, {
    allowBareLegacyToken: lines.length === 3 && lineIndex === 2,
  })))];
  const identities = (await Promise.all(tokens.map(validateTwitchToken))).filter(Boolean);
  const selected = identities.sort((left, right) => scopeRank(right.scopes) - scopeRank(left.scopes))[0];
  return selected ? { ...selected, groupIndex } : undefined;
}));

const byLogin = new Map();
for (const identity of validatedGroups.filter(Boolean)) {
  const prior = byLogin.get(identity.login);
  if (!prior || scopeRank(identity.scopes) > scopeRank(prior.scopes)) byLogin.set(identity.login, identity);
}
const accounts = [...byLogin.values()].sort((left, right) => left.groupIndex - right.groupIndex);
if (accounts.length === 0) throw new Error('None of the supplied Twitch access tokens passed the official validation endpoint.');
if (accounts.length > maximumBotAccounts) throw new Error(`The backend supports at most ${maximumBotAccounts} BOTn accounts.`);

const variables = {};
for (const [index, account] of accounts.entries()) {
  const number = index + 1;
  const chatReady = hasIrcChatScopes(account.scopes);
  variables[`BOT${number}_USERNAME`] = account.login;
  variables[`BOT${number}_OAUTH_TOKEN`] = account.token;
  variables[`BOT${number}_OAUTH`] = '';
  variables[`BOT${number}_PERSONA`] = personaIds[index % personaIds.length];
  variables[`BOT${number}_ENABLED`] = String(chatReady);
}
for (let number = accounts.length + 1; number <= maximumBotAccounts; number += 1) {
  variables[`BOT${number}_USERNAME`] = '';
  variables[`BOT${number}_OAUTH_TOKEN`] = '';
  variables[`BOT${number}_OAUTH`] = '';
  variables[`BOT${number}_PERSONA`] = '';
  variables[`BOT${number}_ENABLED`] = 'false';
}

await graphql(railwayToken, `mutation importTwitchAccounts($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}`, {
  input: {
    projectId: targetProjectId,
    environmentId: targetEnvironmentId,
    serviceId: targetServiceId,
    variables,
  },
});

const modernCount = accounts.filter((account) => hasIrcChatScopes(account.scopes)).length;
const legacyCount = accounts.filter((account) => account.scopes.includes('chat_login')).length;
console.log(`Imported ${accounts.length} unique validated Twitch identities into Railway without printing credentials.`);
console.log(`Enabled ${modernCount} accounts with current chat:read + chat:edit scopes.`);
console.log(`Kept ${legacyCount} legacy chat_login accounts disabled until they are re-authorized with current Twitch chat scopes.`);
console.log(`Skipped ${groups.length - validatedGroups.filter(Boolean).length} records that had no valid access token.`);
console.log('Email addresses and passwords were intentionally not uploaded.');

function splitAccountGroups(text) {
  return text.trim().split(/\r?\n\s*\r?\n/)
    .map((group) => group.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    .filter((group) => group.length > 0);
}

function extractTokenCandidate(line, options) {
  const labelled = line.match(/^(?:oauth|token):(.+)$/i)?.[1]?.trim();
  if (labelled) return [labelled];
  return options.allowBareLegacyToken && /^[A-Za-z0-9_-]{20,80}$/.test(line) ? [line] : [];
}

async function validateTwitchToken(token) {
  try {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    if (typeof body.login !== 'string' || typeof body.user_id !== 'string') return undefined;
    return {
      login: body.login.toLowerCase(),
      token,
      scopes: Array.isArray(body.scopes) ? body.scopes.filter((scope) => typeof scope === 'string') : [],
    };
  } catch {
    return undefined;
  }
}

function hasIrcChatScopes(scopes) {
  return scopes.includes('chat:read') && scopes.includes('chat:edit');
}

function scopeRank(scopes) {
  if (hasIrcChatScopes(scopes)) return 3;
  if (scopes.includes('chat_login')) return 2;
  if (scopes.includes('user:read:chat') && scopes.includes('user:write:chat')) return 1;
  return 0;
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
