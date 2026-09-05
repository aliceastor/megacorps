import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectSchema, updateProjectSchema } from '@megacorps/shared';
import * as policy from './managed-project-policy.ts';

test('project API preserves explicit auto merge opt-out and legacy partial update', () => {
  assert.equal((createProjectSchema.parse({ name: 'Managed', autoMergeAfterApproval: false }) as any).autoMergeAfterApproval, false);
  assert.equal((updateProjectSchema.parse({ autoMergeAfterApproval: true }) as any).autoMergeAfterApproval, true);
  assert.equal((updateProjectSchema.parse({ name: 'Renamed' }) as any).autoMergeAfterApproval, undefined);
});
test('managed permission requires explicit policy, provisioned binding, merge gate and configured provider', () => {
  assert.equal(typeof (policy as any).managedMergeTarget, 'function');
  const config = { apiUrl: 'https://gitea.test', internalUrl: 'http://gitea:3000', externalUrl: 'https://gitea.test' };
  const project = { repoProvider: 'gitea-local', repoUrl: 'https://gitea.test/org/repo.git', managedRepoFullName: 'org/repo', completionRequiresMerge: true, autoMergeAfterApproval: true };
  assert.deepEqual((policy as any).managedMergeTarget(project, config), { org: 'org', repo: 'repo' });
  for (const change of [{ autoMergeAfterApproval: false }, { managedRepoFullName: null }, { repoProvider: 'github' }, { repoUrl: 'https://foreign.test/org/repo' }, { repoUrl: 'https://gitea.test/org/other' }, { completionRequiresMerge: false }]) assert.equal((policy as any).managedMergeTarget({ ...project, ...change }, config), null);
  assert.equal((policy as any).managedMergeTarget(project, null), null);
});
