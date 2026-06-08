import assert from 'node:assert/strict';
import test from 'node:test';
import { codexAppInternals } from './codex-app.ts';
import { getAdapter } from './registry.ts';

test('registry includes codex app adapter', () => {
  const adapter = getAdapter('codex-app');
  assert.equal(typeof adapter.dispatch, 'function');
});

test('codex app prompt injects MegaCorps soul and session policy', () => {
  const prompt = codexAppInternals.buildCodexPrompt({
    id: 'agent-1',
    name: 'Alice Astor',
    role: 'worker',
    title: 'Builder',
    soul: 'Direct, careful, and repo-focused.',
    adapterType: 'codex-app',
    runtimeId: 'runtime-1',
    hermesProfile: null,
    currentSessionId: 'thr_existing',
    adapterConfig: { megacorpsApiUrl: 'https://megacorps.example' },
  }, {
    id: 'card-1',
    taskRunId: 'run-1',
    title: 'Build',
    body: 'Do the work.',
  });

  assert.match(prompt, /=== Agent Soul ===\nDirect, careful, and repo-focused\./);
  assert.match(prompt, /Session policy: Direct Chat uses one thread per chat session/);
  assert.match(prompt, /https:\/\/megacorps\.example\/api\/webhook\/task-complete/);
  assert.match(prompt, /"taskRunId": "run-1"/);
});

test('codex app turn params include thread, text input, cwd, model, and sandbox', () => {
  const params = codexAppInternals.turnStartParams({
    hermesProfile: null,
    currentSessionId: null,
    adapterConfig: {
      codexModel: 'gpt-5.4',
      codexCwd: '/workspace/project',
      codexSandbox: 'workspace-write',
    },
  }, 'thr_123', 'hello');

  assert.equal(params.threadId, 'thr_123');
  assert.equal(params.model, 'gpt-5.4');
  assert.equal(params.cwd, '/workspace/project');
  assert.equal(params.sandbox, 'workspace-write');
  assert.deepEqual(params.input, [{ type: 'text', text: 'hello' }]);
});

test('codex app env fallback follows adapter fallback policy', () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    ADAPTER_ENV_FALLBACK_ENABLED: process.env.ADAPTER_ENV_FALLBACK_ENABLED,
    CODEX_APP_MODEL: process.env.CODEX_APP_MODEL,
  };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.ADAPTER_ENV_FALLBACK_ENABLED;
    process.env.CODEX_APP_MODEL = 'gpt-env';
    assert.equal(codexAppInternals.turnStartParams({ hermesProfile: null, currentSessionId: null, adapterConfig: {} }, 'thr_123', 'hello').model, undefined);

    process.env.ADAPTER_ENV_FALLBACK_ENABLED = 'true';
    assert.equal(codexAppInternals.turnStartParams({ hermesProfile: null, currentSessionId: null, adapterConfig: {} }, 'thr_123', 'hello').model, 'gpt-env');
  } finally {
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.ADAPTER_ENV_FALLBACK_ENABLED === undefined) delete process.env.ADAPTER_ENV_FALLBACK_ENABLED; else process.env.ADAPTER_ENV_FALLBACK_ENABLED = previous.ADAPTER_ENV_FALLBACK_ENABLED;
    if (previous.CODEX_APP_MODEL === undefined) delete process.env.CODEX_APP_MODEL; else process.env.CODEX_APP_MODEL = previous.CODEX_APP_MODEL;
  }
});
