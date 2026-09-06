import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { agents, companies, companyMemberships, departments, positions, users, activityLog } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { signSession } from './auth.ts';

async function fixture(t: TestContext) {
  const company = { id: randomUUID(), name: 'Organization', slug: 'org' }, foreign = { id: randomUUID(), name: 'Foreign', slug: 'foreign' };
  const user = { id: randomUUID(), email: 'org@example.test', role: 'admin' };
  const rows = ['a', 'b', 'c'].map(slug => ({ id: randomUUID(), companyId: company.id, name: slug, slug, role: 'custom role', soul: 'Synthetic role prompt', bossId: null as string | null, positionId: null as string | null, departmentId: null as string | null, runtimeId: null, adapterType: 'a2a', adapterConfig: { bearerToken: 'synthetic-credential-sentinel', agentPath: '/custom' }, capabilities: ['research', 'writing'], memoryConfig: { enabled: true }, hermesProfile: 'profile', budgetPerTask: '12.0000', budgetMonthly: '300.0000' }));
  const foreignAgent = { ...rows[0], id: randomUUID(), companyId: foreign.id };
  const foreignDepartment = { id: randomUUID(), companyId: foreign.id }, foreignPosition = { id: randomUUID(), companyId: foreign.id };
  const state = memoryDb(t, [[companies, [company, foreign]], [users, [user]], [companyMemberships, [{ userId: user.id, companyId: company.id, role: 'admin', status: 'active' }]], [agents, [...rows, foreignAgent]], [departments, [foreignDepartment]], [positions, [foreignPosition]]]);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const headers = { cookie: `session=${await signSession(user)}` };
  const update = (id: string, payload: object) => app.inject({ method: 'PUT', url: `/api/agents/${id}`, headers, payload });
  return { company, rows, state, update, foreignAgent, foreignDepartment, foreignPosition };
}

test('agent update rejects self-manager without mutating agent or audit', async t => {
  const f = await fixture(t), a = f.rows[0]!;
  const before = structuredClone(a);
  const response = await f.update(a.id, { bossId: a.id, name: 'Rejected rename' });
  assert.equal(response.statusCode, 400, response.body); assert.match(response.json().error, /self|cycle/);
  assert.deepEqual(a, before); assert.equal(f.state.rows(activityLog).length, 0);
});

test('agent update rejects a transitive reporting cycle without mutation', async t => {
  const f = await fixture(t), [a,b,c] = f.rows;
  b!.bossId = a!.id; c!.bossId = b!.id;
  const response = await f.update(a!.id, { bossId: c!.id });
  assert.equal(response.statusCode, 400, response.body); assert.match(response.json().error, /cycle/); assert.equal(a!.bossId, null);
});

for (const field of ['bossId', 'positionId', 'departmentId'] as const) test(`agent update rejects cross-company ${field} without mutation`, async t => {
  const f=await fixture(t), a=f.rows[0]!;
  const id = field==='bossId' ? f.foreignAgent.id : field==='positionId' ? f.foreignPosition.id : f.foreignDepartment.id;
  const before=structuredClone(a), response=await f.update(a.id,{[field]:id});
  assert.equal(response.statusCode,400,response.body); assert.deepEqual(a,before); assert.equal(f.state.rows(activityLog).length,0);
});

test('numeric Rank inversion is valid and relationship-only update preserves advanced data', async t => {
  const f=await fixture(t), [a,b]=f.rows;
  const high={id:randomUUID(),companyId:f.company.id,rank:10},low={id:randomUUID(),companyId:f.company.id,rank:100};
  f.state.rows(positions).push(high,low); a!.positionId=high.id; b!.positionId=low.id;
  const before=structuredClone(a!);
  const response=await f.update(a!.id,{bossId:b!.id});
  assert.equal(response.statusCode,200,response.body); assert.deepEqual(a,{...before,bossId:b!.id});
});

test('valid repair of a legacy cyclic graph is accepted even with another disconnected cycle', async t => {
  const f=await fixture(t), [a,b,c]=f.rows;
  a!.bossId=b!.id; b!.bossId=a!.id; c!.bossId=c!.id;
  const response=await f.update(a!.id,{bossId:null});
  assert.equal(response.statusCode,200,response.body); assert.equal(a!.bossId,null); assert.equal(b!.bossId,a!.id);
});

test('agent update accepts explicit nullable profile and budget clears', async t => {
  const f=await fixture(t), a=f.rows[0]!;
  const response=await f.update(a.id,{hermesProfile:null,budgetPerTask:null,budgetMonthly:null});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(a.hermesProfile,null); assert.equal(a.budgetPerTask,null); assert.equal(a.budgetMonthly,null);
  assert.deepEqual(a.capabilities,['research','writing']);
});

test('agent runtime admission failure keeps its existing client error status', async t => {
  const previous=process.env.ADAPTER_ENV_FALLBACK_ENABLED;
  process.env.ADAPTER_ENV_FALLBACK_ENABLED='false';
  t.after(()=>{if(previous===undefined)delete process.env.ADAPTER_ENV_FALLBACK_ENABLED;else process.env.ADAPTER_ENV_FALLBACK_ENABLED=previous;});
  const f=await fixture(t), a=f.rows[0]!;
  const response=await f.update(a.id,{adapterType:'hermes-ssh',runtimeId:null});
  assert.equal(response.statusCode,400,response.body); assert.equal(response.json().error,'agent_runtime_required');
  assert.equal(a.adapterType,'a2a');
});
