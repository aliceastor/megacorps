import assert from 'node:assert/strict';
import test from 'node:test';
import { createGiteaAccessToken, ensureGiteaRepoWebhook, giteaAgentUsername, giteaAuthenticatedCloneUrl, giteaBranchContainsCommit, giteaCloneUrl, giteaCloneUrlForAgent, giteaConfigFromEnv, giteaPullRequest, giteaRequestUrl, giteaSlug, giteaWebhookCallbackUrl, isGiteaProvisioningRetryable } from './gitea.ts';
import { redactPromptForLog } from './prompt-logs.ts';

test('giteaSlug normalizes names to Gitea-safe slugs', () => {
  assert.equal(giteaSlug('Mega Corps'), 'mega-corps');
  assert.equal(giteaSlug('Tubelike 研究 v2!'), 'tubelike-v2');
  assert.equal(giteaSlug('---'), 'x');
  assert.equal(giteaAgentUsername('Alice_Builder'), 'agent-alice_builder');
});

test('clone URLs are built from the external base', () => {
  assert.equal(giteaCloneUrl('http://gitea.lan:3300/', 'mega-corps', 'website'), 'http://gitea.lan:3300/mega-corps/website.git');
  assert.equal(
    giteaAuthenticatedCloneUrl('http://gitea.lan:3300/mega-corps/website.git', 'agent-alice', 'tok123'),
    'http://agent-alice:tok123@gitea.lan:3300/mega-corps/website.git',
  );
});

test('giteaConfigFromEnv is null without GITEA_URL and trims trailing slashes', () => {
  assert.equal(giteaConfigFromEnv({} as NodeJS.ProcessEnv), null);
  const config = giteaConfigFromEnv({ GITEA_URL: 'http://gitea:3000/', GITEA_EXTERNAL_URL: 'http://nas.lan:3300/', GITEA_ADMIN_TOKEN: 't' } as NodeJS.ProcessEnv);
  assert.equal(config?.apiUrl, 'http://gitea:3000');
  assert.equal(config?.internalUrl, 'http://gitea:3000');
  assert.equal(config?.externalUrl, 'http://nas.lan:3300');
});

test('giteaConfigFromEnv prefers GITEA_INTERNAL_URL for agent clone origin', () => {
  const config = giteaConfigFromEnv({
    GITEA_URL: 'http://gitea:3000/',
    GITEA_INTERNAL_URL: 'http://gitea.internal:3000/',
    GITEA_EXTERNAL_URL: 'http://192.168.1.180:3300/',
  } as NodeJS.ProcessEnv);
  assert.equal(config?.apiUrl, 'http://gitea:3000');
  assert.equal(config?.internalUrl, 'http://gitea.internal:3000');
  assert.equal(config?.externalUrl, 'http://192.168.1.180:3300');
});

test('giteaCloneUrlForAgent rewrites stored UI clone URLs onto the internal origin', () => {
  const config = giteaConfigFromEnv({
    GITEA_URL: 'http://gitea:3000',
    GITEA_EXTERNAL_URL: 'http://192.168.1.180:3300',
  } as NodeJS.ProcessEnv);
  assert.equal(
    giteaCloneUrlForAgent('http://192.168.1.180:3300/mega-corps/website.git', config),
    'http://gitea:3000/mega-corps/website.git',
  );
  assert.equal(
    giteaCloneUrlForAgent('http://gitea:3000/mega-corps/website.git', config),
    'http://gitea:3000/mega-corps/website.git',
  );
  assert.equal(
    giteaCloneUrlForAgent('https://github.com/org/repo.git', config),
    'https://github.com/org/repo.git',
  );
  assert.equal(giteaCloneUrlForAgent('http://192.168.1.180:3300/mega-corps/website.git', null), 'http://192.168.1.180:3300/mega-corps/website.git');
});

test('giteaWebhookCallbackUrl uses the internal API chain so Gitea can reach MegaCorps', () => {
  assert.equal(
    giteaWebhookCallbackUrl({ INTERNAL_API_URL: 'http://megacorps-server:4000/', MEGACORPS_API_URL: 'http://192.168.1.180:4000', MEGACORPS_PUBLIC_URL: 'http://nas.lan:4000' } as NodeJS.ProcessEnv, 'tok'),
    'http://megacorps-server:4000/api/gitea/events?token=tok',
  );
  assert.equal(
    giteaWebhookCallbackUrl({ MEGACORPS_API_URL: 'http://192.168.1.180:4000' } as NodeJS.ProcessEnv, 'tok'),
    'http://192.168.1.180:4000/api/gitea/events?token=tok',
  );
  assert.equal(
    giteaWebhookCallbackUrl({} as NodeJS.ProcessEnv, 'tok'),
    'http://server:4000/api/gitea/events?token=tok',
  );
});

test('prompt logs redact git credentials in URLs and credential lines', () => {
  const prompt = [
    'Authenticated clone URL: http://agent-alice:supersecrettoken123@gitea.lan:3300/mega-corps/website.git',
    'Git credentials (yours alone; do not share): username agent-alice, token 4f3a2b1c9d8e7f6a5b4c.',
  ].join('\n');
  const redacted = redactPromptForLog(prompt);
  assert.doesNotMatch(redacted, /supersecrettoken123/);
  assert.doesNotMatch(redacted, /4f3a2b1c9d8e7f6a5b4c/);
  assert.match(redacted, /http:\/\/\[redacted\]@gitea\.lan:3300/);
});

test('giteaRequestUrl always prefixes /api/v1 and does not double it', () => {
  const config = giteaConfigFromEnv({ GITEA_URL: 'http://gitea:3000/' } as NodeJS.ProcessEnv)!;
  assert.equal(giteaRequestUrl(config, '/users/agent-alice/tokens'), 'http://gitea:3000/api/v1/users/agent-alice/tokens');
  const alreadyPrefixed = giteaConfigFromEnv({ GITEA_URL: 'http://gitea:3000/api/v1' } as NodeJS.ProcessEnv)!;
  assert.equal(giteaRequestUrl(alreadyPrefixed, '/orgs'), 'http://gitea:3000/api/v1/orgs');
});

test('createGiteaAccessToken uses Gitea 1.22 user token API with Basic admin auth', async () => {
  const calls: Array<{ url: string; method?: string; authorization?: string; body?: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify({ sha1: 'gitea-token-value', name: 'megacorps' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const config = giteaConfigFromEnv({
    GITEA_URL: 'http://gitea:3000',
    GITEA_ADMIN_TOKEN: 'gitea_admin_pat',
    GITEA_ADMIN_USERNAME: 'megacorps-admin',
    GITEA_ADMIN_PASSWORD: 's3cret',
  } as NodeJS.ProcessEnv)!;
  const token = await createGiteaAccessToken(config, 'agent-alice', fetchImpl);
  assert.equal(token, 'gitea-token-value');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://gitea:3000/api/v1/users/agent-alice/tokens');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.authorization, `Basic ${Buffer.from('megacorps-admin:s3cret').toString('base64')}`);
  assert.doesNotMatch(calls[0]?.url ?? '', /\/admin\/users\//);
  assert.match(calls[0]?.body ?? '', /write:repository/);
});

test('isGiteaProvisioningRetryable retries unavailability, not path 404s', () => {
  assert.equal(isGiteaProvisioningRetryable(new Error('gitea_unreachable: GET http://gitea:3000/api/v1/orgs failed: fetch failed')), true);
  assert.equal(isGiteaProvisioningRetryable(new Error('gitea_http_503: GET /orgs failed')), true);
  assert.equal(isGiteaProvisioningRetryable(new Error('gitea_http_429: GET /orgs failed')), true);
  assert.equal(isGiteaProvisioningRetryable(new Error('gitea_http_404: POST /admin/users/agent-alice/tokens failed: 404 page not found')), false);
  assert.equal(isGiteaProvisioningRetryable(new Error('gitea_http_401: GET /admin/users failed')), false);
  assert.equal(isGiteaProvisioningRetryable(new Error('gitea_admin_credentials_missing: set GITEA_ADMIN_TOKEN or GITEA_ADMIN_USERNAME/GITEA_ADMIN_PASSWORD')), false);
  assert.equal(isGiteaProvisioningRetryable(new Error('gitea_token_create_failed: Gitea did not return a token value')), false);
});

test('giteaCloneUrlForAgent rewrites onto a pinned bridge IP internal origin', () => {
  const config = giteaConfigFromEnv({
    GITEA_URL: 'http://gitea:3000',
    GITEA_INTERNAL_URL: 'http://172.16.22.6:3000',
    GITEA_EXTERNAL_URL: 'http://192.168.1.180:3300',
  } as NodeJS.ProcessEnv);
  assert.equal(
    giteaCloneUrlForAgent('http://192.168.1.180:3300/auroria/testing-new-system.git', config),
    'http://172.16.22.6:3000/auroria/testing-new-system.git',
  );
});

test('ensureGiteaRepoWebhook creates a hook subscribed to push and pull_request', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'GET') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 7 }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const config = giteaConfigFromEnv({ GITEA_URL: 'http://gitea:3000', GITEA_ADMIN_TOKEN: 'tok' } as NodeJS.ProcessEnv)!;
  await ensureGiteaRepoWebhook(config, 'mega-corps', 'website', 'http://server:4000/api/gitea/events?token=t', fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.method, 'POST');
  assert.equal(calls[1]?.url, 'http://gitea:3000/api/v1/repos/mega-corps/website/hooks');
  assert.deepEqual((calls[1]?.body as { events?: string[] })?.events, ['push', 'pull_request']);
});

test('ensureGiteaRepoWebhook patches a push-only hook instead of duplicating it', async () => {
  const target = 'http://server:4000/api/gitea/events?token=t';
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'GET') {
      return new Response(JSON.stringify([{ id: 42, events: ['push'], config: { url: target } }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 42 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const config = giteaConfigFromEnv({ GITEA_URL: 'http://gitea:3000', GITEA_ADMIN_TOKEN: 'tok' } as NodeJS.ProcessEnv)!;
  await ensureGiteaRepoWebhook(config, 'mega-corps', 'website', target, fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.method, 'PATCH');
  assert.equal(calls[1]?.url, 'http://gitea:3000/api/v1/repos/mega-corps/website/hooks/42');
  assert.deepEqual((calls[1]?.body as { events?: string[] })?.events, ['push', 'pull_request']);
});

test('ensureGiteaRepoWebhook leaves an already complete hook alone', async () => {
  const target = 'http://server:4000/api/gitea/events?token=t';
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return new Response(JSON.stringify([{ id: 42, events: ['push', 'pull_request'], config: { url: target } }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const config = giteaConfigFromEnv({ GITEA_URL: 'http://gitea:3000', GITEA_ADMIN_TOKEN: 'tok' } as NodeJS.ProcessEnv)!;
  await ensureGiteaRepoWebhook(config, 'mega-corps', 'website', target, fetchImpl);
  assert.deepEqual(calls, ['GET http://gitea:3000/api/v1/repos/mega-corps/website/hooks']);
});

test('giteaPullRequest returns the head SHA and null for a missing pull request', async () => {
  const config = giteaConfigFromEnv({ GITEA_URL: 'http://gitea:3000', GITEA_ADMIN_TOKEN: 'tok' } as NodeJS.ProcessEnv)!;
  const found = (async () => new Response(JSON.stringify({ number: 12, merged: false, head: { sha: 'abc123def456', ref: 'megacorps/card-1' }, base: { ref: 'main' } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  assert.equal((await giteaPullRequest(config, 'mega-corps', 'website', 12, found))?.head?.sha, 'abc123def456');
  const missing = (async () => new Response('not found', { status: 404 })) as typeof fetch;
  assert.equal(await giteaPullRequest(config, 'mega-corps', 'website', 99, missing), null);
});

test('giteaBranchContainsCommit matches full and short SHAs from the branch history', async () => {
  const config = giteaConfigFromEnv({ GITEA_URL: 'http://gitea:3000', GITEA_ADMIN_TOKEN: 'tok' } as NodeJS.ProcessEnv)!;
  let requested = '';
  const fetchImpl = (async (url: string | URL | Request) => {
    requested = String(url);
    return new Response(JSON.stringify([{ sha: 'aaaabbbbccccdddd' }, { sha: 'eeeeffff00001111' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  assert.equal(await giteaBranchContainsCommit(config, 'mega-corps', 'website', 'main', 'aaaabbbbccccdddd', { fetchImpl }), true);
  assert.match(requested, /\/repos\/mega-corps\/website\/commits\?sha=main&limit=100$/);
  assert.equal(await giteaBranchContainsCommit(config, 'mega-corps', 'website', 'main', 'aaaabbb', { fetchImpl }), true);
  assert.equal(await giteaBranchContainsCommit(config, 'mega-corps', 'website', 'main', '1234567890abcdef', { fetchImpl }), false);
});
