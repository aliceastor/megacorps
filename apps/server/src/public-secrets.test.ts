import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { agents, companies, companyMemberships, projects, users } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { registerRoutes } from './routes.ts';
import { signSession } from './auth.ts';

test('viewer lists redact repository credentials and project edits preserve the placeholder', async (t) => {
  const company = { id: randomUUID(), name: 'Fixture', slug: 'fixture' };
  const viewer = { id: randomUUID(), email: 'viewer@example.test', role: 'viewer' };
  const operator = { id: randomUUID(), email: 'operator@example.test', role: 'operator' };
  const agent = { id: randomUUID(), companyId: company.id, name: 'Worker', giteaToken: 'synthetic-agent-secret-938413', apiToken: 'synthetic-api-secret-381749' };
  const project = { id: randomUUID(), companyId: company.id, name: 'Project', publishToken: 'synthetic-publish-secret-839714', autoMergeAfterApproval: false };
  const state = memoryDb(t, [[companies, [company]], [users, [viewer, operator]], [agents, [agent]], [projects, [project]],
    [companyMemberships, [viewer, operator].map((user) => ({ userId: user.id, companyId: company.id, role: user.role, status: 'active' }))]]);
  const app = Fastify(); t.after(() => app.close()); await app.register(cookie); await registerRoutes(app);
  const headers = { cookie: `session=${await signSession(viewer)}` };
  const listedAgents = await app.inject({ method: 'GET', url: '/api/agents', headers });
  assert.equal(listedAgents.statusCode, 200); assert.ok(!listedAgents.body.includes(agent.giteaToken));
  assert.equal(listedAgents.json()[0].giteaToken, '[redacted]');
  const listedProjects = await app.inject({ method: 'GET', url: '/api/projects', headers });
  assert.equal(listedProjects.statusCode, 200); assert.ok(!listedProjects.body.includes(project.publishToken));
  assert.equal(listedProjects.json()[0].publishToken, '[redacted]');
  const edited = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, headers: { cookie: `session=${await signSession(operator)}` }, payload: { name: 'Renamed', publishToken: '[redacted]' } });
  assert.equal(edited.statusCode, 200, edited.body); assert.equal(edited.json().publishToken, '[redacted]');
  assert.equal(state.rows(projects)[0]!.publishToken, project.publishToken);
  const created = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: `session=${await signSession(operator)}` }, payload: { companyId: company.id, name: 'New', publishToken: project.publishToken } });
  assert.equal(created.statusCode, 201, created.body); assert.equal(created.json().publishToken, '[redacted]');
});
