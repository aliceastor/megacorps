import assert from 'node:assert/strict';
import test from 'node:test';
import { positionAssignment } from './position-assignment.ts';
test('position assignment locks department and leadership reporting but retains staff edges', () => {
  const boss = { id: 'boss-position', isCompanyBoss: true, defaultDepartmentId: 'bad' };
  const head = { id: 'head', isDepartmentHead: true, defaultDepartmentId: 'engineering' };
  const staff = { id: 'staff', defaultDepartmentId: 'engineering' };
  assert.deepEqual(positionAssignment(boss, 'old', 'boss-agent'), { departmentId: null, bossId: null });
  assert.deepEqual(positionAssignment(head, 'old', 'boss-agent'), { departmentId: 'engineering', bossId: 'boss-agent' });
  assert.deepEqual(positionAssignment(staff, 'ribel', 'boss-agent'), { departmentId: 'engineering', bossId: 'ribel' });
});

test('name-only edit of an unpositioned legacy Agent omits organization fields', async () => {
  const { positionEditPatch } = await import('./position-assignment.ts');
  assert.deepEqual(positionEditPatch({ positionId: null, departmentId: 'legacy', bossId: 'ribel' }, undefined, '', 'ribel', 'boss-agent'), {});
});
test('explicit position changes derive membership while retaining staff reporting', async () => {
  const { positionEditPatch } = await import('./position-assignment.ts');
  assert.deepEqual(positionEditPatch({ positionId: null, departmentId: 'legacy', bossId: 'ribel' }, { id: 'staff', defaultDepartmentId: 'engineering' }, 'staff', 'ribel', 'boss-agent'), { positionId: 'staff', departmentId: 'engineering' });
});

test('manager position limits supervisors to active same-company non-self occupants', async () => {
  const { eligibleSupervisors, selectSupervisor } = await import('./position-assignment.ts');
  const positions = [{ id: 'senior', companyId: 'co', isActive: true }];
  const people = [
    { id: 'a', companyId: 'co', positionId: 'senior', isActive: true },
    { id: 'b', companyId: 'co', positionId: 'senior', isActive: true },
    { id: 'self', companyId: 'co', positionId: 'senior', isActive: true },
    { id: 'inactive', companyId: 'co', positionId: 'senior', isActive: false },
    { id: 'foreign', companyId: 'other', positionId: 'senior', isActive: true },
    { id: 'unrelated', companyId: 'co', positionId: 'different', isActive: true },
  ];
  const candidates = eligibleSupervisors({ id: 'intern', managerPositionId: 'senior' }, 'self', 'co', people, positions);
  assert.deepEqual(candidates.map(person => person.id), ['a', 'b']);
  assert.equal(selectSupervisor(candidates, 'b'), 'b');
  assert.equal(selectSupervisor(candidates, 'unrelated'), null);
  assert.equal(selectSupervisor(candidates.slice(0, 1), null), 'a');
  assert.deepEqual(eligibleSupervisors({ id: 'intern', managerPositionId: 'vacant' }, 'self', 'co', people, positions), []);
});
test('company-direct staff have no department and heads use the active Boss position', async () => {
  const { eligibleSupervisors } = await import('./position-assignment.ts');
  assert.equal(positionAssignment({ id: 'director', isCompanyLeadership: true, defaultDepartmentId: 'ignored' }, 'boss', 'boss').departmentId, null);
  assert.deepEqual(eligibleSupervisors({ id: 'head', isDepartmentHead: true, managerPositionId: 'wrong' }, 'self', 'co', [{ id: 'boss', companyId: 'co', positionId: 'ceo', isActive: true }], [{ id: 'ceo', companyId: 'co', isCompanyBoss: true, isActive: true }]).map(person => person.id), ['boss']);
});
