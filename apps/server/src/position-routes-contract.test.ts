import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { signSession } from './auth.ts';
import { companies, companyMemberships, departments, positions, users } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';

test('position routes ignore the removed cross-department delegation payload key', async t => {
  const flags = ['DISPATCH_LOOP_ENABLED', 'TASK_RUN_WORKER_ENABLED', 'MAINTENANCE_SWEEP_ENABLED', 'LOG_RETENTION_ENABLED', 'PROVISIONING_SWEEP_ENABLED', 'RATE_LIMIT_ENABLED'];
  const previous = flags.map(key => process.env[key]);
  flags.forEach(key => { process.env[key] = 'false'; });
  t.after(() => flags.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  const user = { id: randomUUID(), email: 'positions@example.test', role: 'admin', status: 'active' };
  const company = { id: randomUUID(), name: 'Positions', slug: 'positions' };
  const department = { id: randomUUID(), companyId: company.id, name: 'Engineering', slug: 'engineering' };
  const legacy = { id: randomUUID(), companyId: company.id, name: 'Legacy', slug: 'legacy', rank: 2, defaultDepartmentId: department.id, canDelegateAcrossDepartments: true };
  const state = memoryDb(t, [[users, [user]], [companies, [company]], [companyMemberships, [{ companyId: company.id, userId: user.id, role: 'operator', status: 'active' }]], [departments, [department]], [positions, [legacy]]]);
  const { buildServer } = await import('./index.ts');
  const app = await buildServer(); t.after(() => app.close());
  const headers = { cookie: `session=${await signSession(user)}` };
  const listed = await app.inject({ method: 'GET', url: `/api/positions?companyId=${company.id}`, headers });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(Object.hasOwn(listed.json()[0], 'canDelegateAcrossDepartments'), false);
  const created = await app.inject({
    method: 'POST', url: '/api/positions', headers,
    payload: { companyId: company.id, name: 'Engineer', slug: 'engineer', rank: 2, defaultDepartmentId: department.id, canDelegateAcrossDepartments: true },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(Object.hasOwn(created.json(), 'canDelegateAcrossDepartments'), false);
  assert.notEqual(state.rows(positions).find(row => row.id !== legacy.id)?.canDelegateAcrossDepartments, true);
});
