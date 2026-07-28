import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MEMORY_DAILY_LIMIT,
  DEFAULT_MEMORY_IDLE_MINUTES,
  buildMaintenancePrompt,
  formatShiftSummary,
  maintenanceSkipReason,
  normalizeMemoryConfig,
  type MaintenanceCandidateInput,
} from './agent-maintenance.ts';

test('normalizeMemoryConfig defaults to disabled with sane thresholds', () => {
  assert.deepEqual(normalizeMemoryConfig(null), { enabled: false, idleMinutes: DEFAULT_MEMORY_IDLE_MINUTES, dailyLimit: DEFAULT_MEMORY_DAILY_LIMIT });
  assert.deepEqual(normalizeMemoryConfig({}), { enabled: false, idleMinutes: DEFAULT_MEMORY_IDLE_MINUTES, dailyLimit: DEFAULT_MEMORY_DAILY_LIMIT });
  assert.equal(normalizeMemoryConfig({ enabled: 'true' }).enabled, false);
  assert.deepEqual(normalizeMemoryConfig({ enabled: true, idleMinutes: 30, dailyLimit: 5 }), { enabled: true, idleMinutes: 30, dailyLimit: 5 });
});

test('normalizeMemoryConfig clamps out-of-range values', () => {
  const config = normalizeMemoryConfig({ enabled: true, idleMinutes: 100_000, dailyLimit: 99 });
  assert.equal(config.idleMinutes, 1440);
  assert.equal(config.dailyLimit, 24);
  const invalid = normalizeMemoryConfig({ enabled: true, idleMinutes: 0, dailyLimit: -3 });
  assert.equal(invalid.idleMinutes, DEFAULT_MEMORY_IDLE_MINUTES);
  assert.equal(invalid.dailyLimit, DEFAULT_MEMORY_DAILY_LIMIT);
});

function candidate(overrides: Partial<MaintenanceCandidateInput>): MaintenanceCandidateInput {
  const now = new Date('2026-07-28T12:00:00Z');
  return {
    now,
    config: { enabled: true, idleMinutes: 15, dailyLimit: 3 },
    hasActiveTaskRuns: false,
    lastWorkCompletedAt: new Date('2026-07-28T11:30:00Z'),
    lastMaintenanceAttemptAt: null,
    lastMaintenanceSuccessAt: null,
    maintenanceRunsToday: 0,
    ...overrides,
  };
}

test('maintenance triggers when the agent is idle with new completed work', () => {
  assert.equal(maintenanceSkipReason(candidate({})), null);
});

test('maintenance skips when memory is disabled or work is active', () => {
  assert.equal(maintenanceSkipReason(candidate({ config: { enabled: false, idleMinutes: 15, dailyLimit: 3 } })), 'memory_disabled');
  assert.equal(maintenanceSkipReason(candidate({ hasActiveTaskRuns: true })), 'agent_has_active_task_runs');
  assert.equal(maintenanceSkipReason(candidate({ lastWorkCompletedAt: null })), 'no_completed_work');
});

test('maintenance skips until the idle threshold has passed', () => {
  assert.equal(
    maintenanceSkipReason(candidate({ lastWorkCompletedAt: new Date('2026-07-28T11:50:00Z') })),
    'not_idle_yet',
  );
});

test('maintenance skips when there is no new work since the last consolidation', () => {
  assert.equal(
    maintenanceSkipReason(candidate({
      lastWorkCompletedAt: new Date('2026-07-28T11:30:00Z'),
      lastMaintenanceSuccessAt: new Date('2026-07-28T11:40:00Z'),
    })),
    'no_new_work_since_last_consolidation',
  );
});

test('failed maintenance attempts back off by the idle threshold instead of hot-looping', () => {
  assert.equal(
    maintenanceSkipReason(candidate({ lastMaintenanceAttemptAt: new Date('2026-07-28T11:55:00Z') })),
    'maintenance_recently_attempted',
  );
  assert.equal(
    maintenanceSkipReason(candidate({ lastMaintenanceAttemptAt: new Date('2026-07-28T11:30:00Z') })),
    null,
  );
});

test('maintenance respects the daily limit', () => {
  assert.equal(maintenanceSkipReason(candidate({ maintenanceRunsToday: 3 })), 'daily_limit_reached');
  assert.equal(maintenanceSkipReason(candidate({ maintenanceRunsToday: 2 })), null);
});

test('shift summary lists work, corrections, and work products', () => {
  const summary = formatShiftSummary(
    [
      { kind: 'dispatch', cardTitle: 'Build ingest pipeline', status: 'success', completedAt: new Date('2026-07-28T10:00:00Z') },
      { kind: 'review', cardTitle: 'Fix flaky tests', status: 'failed', completedAt: new Date('2026-07-28T11:00:00Z'), error: 'timeout after 300s' },
    ],
    [{ cardTitle: 'Build ingest pipeline', action: 'review_rejected', detail: 'Missing retry handling on the upload path.' }],
    [{ title: 'Ingest pipeline PR', pullRequestUrl: 'https://github.com/x/y/pull/1' }],
    new Date('2026-07-28T00:00:00Z'),
  );
  assert.match(summary, /since 2026-07-28T00:00:00/);
  assert.match(summary, /\[dispatch\] Card "Build ingest pipeline" — success/);
  assert.match(summary, /\[review\] Card "Fix flaky tests" — failed: timeout after 300s/);
  assert.match(summary, /review_rejected — Missing retry handling/);
  assert.match(summary, /https:\/\/github\.com\/x\/y\/pull\/1/);
});

test('shift summary marks empty sections explicitly', () => {
  const summary = formatShiftSummary([], [], [], null);
  assert.match(summary, /since the beginning/);
  assert.equal((summary.match(/- none recorded/g) ?? []).length, 3);
});

test('maintenance prompt keeps the two memory layers and forbids new work', () => {
  const prompt = buildMaintenancePrompt({ name: 'Ribel', role: 'engineer' }, 'SUMMARY');
  assert.match(prompt, /^SUMMARY/);
  assert.match(prompt, /Professional know-how/);
  assert.match(prompt, /Project- or company-specific facts/);
  assert.match(prompt, /label each of these with the company or project/);
  assert.match(prompt, /review feedback and corrections above top priority/);
  assert.match(prompt, /Do not start new project work/);
  assert.match(prompt, /do not call the MegaCorps webhook or API/);
});
