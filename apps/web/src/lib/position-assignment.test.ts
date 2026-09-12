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
