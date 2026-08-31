import assert from 'node:assert/strict';
import test from 'node:test';
import { giteaAgentUsername, giteaAuthenticatedCloneUrl, giteaCloneUrl, giteaCloneUrlForAgent, giteaConfigFromEnv, giteaSlug, giteaWebhookCallbackUrl } from './gitea.ts';
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
