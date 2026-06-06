import assert from 'node:assert/strict';
import test from 'node:test';
import { adapterEnvFallbackEnabled, adapterRequiresRuntime, assertAdapterTargetAllowed, getAdapterStringConfig } from './config.ts';

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('production requires runtime for external adapters and ignores adapter env fallback by default', () => {
  withEnv({ NODE_ENV: 'production', ADAPTER_ENV_FALLBACK_ENABLED: undefined, HERMES_SSH_HOST: 'env-host' }, () => {
    assert.equal(adapterEnvFallbackEnabled(), false);
    assert.equal(adapterRequiresRuntime('hermes-ssh'), true);
    assert.equal(adapterRequiresRuntime('mock'), false);
    assert.throws(
      () => getAdapterStringConfig({ hermesProfile: 'alice', currentSessionId: null, adapterConfig: {} }, 'sshHost', 'HERMES_SSH_HOST'),
      /sshHost \(HERMES_SSH_HOST\) is required/,
    );
  });
});

test('adapter env fallback can be explicitly enabled for local debugging', () => {
  withEnv({ NODE_ENV: 'production', ADAPTER_ENV_FALLBACK_ENABLED: 'true', HERMES_SSH_HOST: 'env-host' }, () => {
    assert.equal(adapterEnvFallbackEnabled(), true);
    assert.equal(adapterRequiresRuntime('hermes-ssh'), false);
    assert.equal(
      getAdapterStringConfig({ hermesProfile: 'alice', currentSessionId: null, adapterConfig: {} }, 'sshHost', 'HERMES_SSH_HOST'),
      'env-host',
    );
  });
});

test('adapter egress guard blocks local and metadata targets', () => {
  withEnv({ ADAPTER_TARGET_ALLOWLIST: undefined }, () => {
    assert.throws(() => assertAdapterTargetAllowed('http://localhost:4000', 'WEBHOOK_ADAPTER_URL'), /blocked for adapter egress/);
    assert.throws(() => assertAdapterTargetAllowed('169.254.169.254', 'HERMES_SSH_HOST'), /blocked for adapter egress/);
    assert.equal(assertAdapterTargetAllowed('https://hermes.example.internal', 'HERMES_GATEWAY_URL'), 'https://hermes.example.internal');
  });
});

test('adapter target allowlist restricts configured hosts', () => {
  withEnv({ ADAPTER_TARGET_ALLOWLIST: 'hermes.example.internal,*.agents.example.com' }, () => {
    assert.equal(assertAdapterTargetAllowed('https://runner.agents.example.com/api', 'WEBHOOK_ADAPTER_URL'), 'https://runner.agents.example.com/api');
    assert.throws(() => assertAdapterTargetAllowed('https://untrusted.example.net/api', 'WEBHOOK_ADAPTER_URL'), /not in ADAPTER_TARGET_ALLOWLIST/);
  });
});
