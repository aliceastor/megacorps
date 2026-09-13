import assert from 'node:assert/strict';
import test from 'node:test';
import { agentAuthority } from './agent-authority.ts';

const companyId = 'company';
const departmentId = 'engineering';
const agent = { id: 'agent', companyId, positionId: 'position', departmentId, isActive: true, deletedAt: null };
const position = { id: 'position', companyId, rank: 2, isCompanyBoss: false, isDepartmentHead: false, isActive: true, defaultDepartmentId: departmentId };

test('active structural Boss inherits every capability', () => {
  assert.deepEqual(agentAuthority(agent, { ...position, rank: 0, isCompanyBoss: true, defaultDepartmentId: null }), {
    boss: true, departmentHead: true, staff: true, active: true,
  });
});

test('formal department Head inherits staff capability for its current department', () => {
  assert.deepEqual(agentAuthority(agent, { ...position, rank: 1, isDepartmentHead: true }), {
    boss: false, departmentHead: true, staff: true, active: true,
  });
});

test('active department and company-leadership staff have staff capability', () => {
  assert.deepEqual(agentAuthority(agent, position), { boss: false, departmentHead: false, staff: true, active: true });
  assert.deepEqual(agentAuthority({ ...agent, departmentId: null }, { ...position, defaultDepartmentId: null }), {
    boss: false, departmentHead: false, staff: true, active: true,
  });
});

test('authority is inactive when assignment identity or lifecycle is invalid', () => {
  const none = { boss: false, departmentHead: false, staff: false, active: false };
  assert.deepEqual(agentAuthority({ ...agent, isActive: false }, position), none);
  assert.deepEqual(agentAuthority({ ...agent, deletedAt: new Date() }, position), none);
  assert.deepEqual(agentAuthority(agent, { ...position, isActive: false }), none);
  assert.deepEqual(agentAuthority(agent, null), none);
  assert.deepEqual(agentAuthority({ ...agent, positionId: 'other' }, position), none);
  assert.deepEqual(agentAuthority(agent, { ...position, companyId: 'other-company' }), none);
});

test('role flags and rank cannot independently fabricate Boss or Head authority', () => {
  assert.deepEqual(agentAuthority(agent, { ...position, rank: 1, isDepartmentHead: false }), {
    boss: false, departmentHead: false, staff: true, active: true,
  });
  assert.deepEqual(agentAuthority(agent, { ...position, rank: 2, isDepartmentHead: true }), {
    boss: false, departmentHead: false, staff: true, active: true,
  });
  assert.deepEqual(agentAuthority({ ...agent, departmentId: 'design' }, { ...position, rank: 1, isDepartmentHead: true }), {
    boss: false, departmentHead: false, staff: true, active: true,
  });
  assert.deepEqual(agentAuthority(agent, { ...position, rank: 1, isCompanyBoss: true }), {
    boss: false, departmentHead: false, staff: true, active: true,
  });
});
