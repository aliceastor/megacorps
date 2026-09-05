import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { db } from './db/client.ts';
import { activityLog, apiEvents, companies, companyMemberships, cronRuns, heartbeatRuns, kanbanCards, promptLogs, taskRuns, users } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { signSession } from './auth.ts';
import { registerRoutes } from './routes.ts';

async function fixture(t: any) {
  const user = { id: randomUUID(), email: 'logs@example.test', role: 'admin', status: 'active' };
  const company = { id: randomUUID(), name: 'Logs Co', slug: 'logs-co' };
  const foreignCompany = { id: randomUUID(), name: 'Foreign Logs', slug: 'foreign-logs' };
  const card = { id: randomUUID(), companyId: company.id, title: 'Synthetic card' };
  const prompt = { id: randomUUID(), companyId: company.id, cardId: card.id, source: 'dispatch', adapterType: 'codex-app', title: 'Large prompt', prompt: 'body must stay lazy', promptHash: 'hash', metadata: { contextMode: 'full_bootstrap' }, createdAt: new Date('2026-09-06T01:02:03.000Z') };
  const foreignPrompt = { ...prompt, id: randomUUID(), companyId: foreignCompany.id, cardId: null, prompt: 'foreign body' };
  const globalActivity = { id: randomUUID(), companyId: null, actorType: 'user', actorId: user.id, action: 'admin.synthetic', entityType: 'system', entityId: 'global', details: { private: true }, createdAt: new Date() };
  const cron = { id: randomUUID(), name: 'dispatch-heartbeat', source: 'loop', status: 'success', details: { body: 'lazy' }, createdAt: new Date('2026-09-06T01:02:03.000Z') };
  memoryDb(t, [[users, [user]], [companies, [company, foreignCompany]], [companyMemberships, [{ userId: user.id, companyId: company.id, role: 'admin', status: 'active' }]], [kanbanCards, [card]], [promptLogs, [prompt, foreignPrompt]], [activityLog, [globalActivity]], [apiEvents, []], [heartbeatRuns, []], [taskRuns, []], [cronRuns, [cron]]]);
  t.mock.method(db, 'execute', async () => []);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  return { app, company, prompt, foreignPrompt, globalActivity, user, cron, headers: { cookie: `session=${await signSession(user)}` } };
}

test('log list routes opt into summary envelopes while legacy arrays and detail reads remain compatible', async t => {
  const { app, prompt, headers } = await fixture(t);
  const legacy = await app.inject({ url: '/api/prompt-logs?limit=1', headers });
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.ok(Array.isArray(legacy.json()));
  assert.equal(legacy.json()[0].prompt, prompt.prompt);

  const summary = await app.inject({ url: '/api/prompt-logs?view=summary&limit=1', headers });
  assert.equal(summary.statusCode, 200, summary.body);
  assert.ok(Array.isArray(summary.json().items));
  assert.equal(summary.json().items[0].prompt, undefined);
  assert.equal(summary.json().items[0].contextMode, 'full_bootstrap');

  const detail = await app.inject({ url: `/api/prompt-logs/${prompt.id}`, headers });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().prompt, prompt.prompt);
});

test('detail IDs preserve per-company and global-admin authorization boundaries', async t => {
  const { app, foreignPrompt, globalActivity, user, headers } = await fixture(t);
  assert.equal((await app.inject({ url: `/api/prompt-logs/${foreignPrompt.id}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/activity/${globalActivity.id}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/admin/activity/${globalActivity.id}`, headers })).statusCode, 200);
  user.role = 'viewer';
  assert.equal((await app.inject({ url: `/api/admin/activity/${globalActivity.id}`, headers })).statusCode, 403);
});

test('scheduler history uses bounded summaries and lazy detail bodies', async t => {
  const { app, cron, headers } = await fixture(t);
  const summary = await app.inject({ url: '/api/cron/runs?view=summary&limit=1', headers });
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(summary.json().items[0].details, undefined);
  const detail = await app.inject({ url: `/api/cron/runs/${cron.id}`, headers });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().details, cron.details);
});

test('all bounded log lists reject malformed finite limits with useful 400s', async t => {
  const { app, headers } = await fixture(t);
  for (const path of ['/api/prompt-logs', '/api/system-logs', '/api/activity', '/api/heartbeat-runs', '/api/task-runs']) {
    for (const limit of ['NaN', 'Infinity', '-1', '0', '1.5']) {
      const response = await app.inject({ url: `${path}?view=summary&limit=${encodeURIComponent(limit)}`, headers });
      assert.equal(response.statusCode, 400, `${path} ${limit}: ${response.body}`);
      assert.equal(response.json().error, 'invalid_limit');
    }
    const cursor = await app.inject({ url: `${path}?view=summary&cursor=malformed`, headers });
    assert.equal(cursor.statusCode, 400, `${path}: ${cursor.body}`);
    assert.equal(cursor.json().error, 'invalid_cursor');
  }
});

test('all searchable log lists reject malformed or oversized search with invalid_search', async t => {
  const { app, headers } = await fixture(t);
  for (const path of ['/api/prompt-logs', '/api/system-logs', '/api/activity', '/api/admin/activity', '/api/heartbeat-runs', '/api/task-runs', '/api/cron/runs']) {
    for (const query of [`q=${'x'.repeat(201)}`, 'q=one&q=two']) {
      const response = await app.inject({ url: `${path}?view=summary&${query}`, headers });
      assert.equal(response.statusCode, 400, `${path} ${query}: ${response.body}`);
      assert.equal(response.json().error, 'invalid_search');
    }
  }
});
