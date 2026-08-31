import assert from 'node:assert/strict';
import test from 'node:test';
import { agentHomeDir, agentProjectCloneDir, companySharedDir, workspaceProtocolLines, workspacePathSlug } from './workspace-paths.ts';

const context = { companySlug: 'mega-corps', agentSlug: 'alice', projectName: 'Website Redesign', mountRoot: '/mnt/megacorps' };

test('paths follow the three-tier convention under the mount', () => {
  assert.equal(companySharedDir(context), '/mnt/megacorps/mega-corps/shared');
  assert.equal(agentHomeDir(context), '/mnt/megacorps/mega-corps/agents/alice');
  assert.equal(agentProjectCloneDir(context), '/mnt/megacorps/mega-corps/agents/alice/project/website-redesign');
});

test('windows UNC mount roots keep backslash separators', () => {
  const win = { ...context, mountRoot: '\\\\nas\\megacorps' };
  assert.equal(agentProjectCloneDir(win), '\\\\nas\\megacorps\\mega-corps\\agents\\alice\\project\\website-redesign');
});

test('paths are null without a mount and slugs normalize', () => {
  assert.equal(agentProjectCloneDir({ ...context, mountRoot: null }), null);
  assert.equal(workspacePathSlug('Tubelike 研究 v2', 'x'), 'tubelike-v2');
});

test('protocol lines carry exact paths with a mount and a git fallback without', () => {
  const withMount = workspaceProtocolLines(context).join('\n');
  assert.match(withMount, /Your workspace \(clone the project repo here\): \/mnt\/megacorps\/mega-corps\/agents\/alice\/project\/website-redesign/);
  assert.match(withMount, /no versioning and no locks/);
  assert.match(withMount, /handled entirely by git/);

  const withoutMount = workspaceProtocolLines({ ...context, mountRoot: null, localWorkspaceRoot: 'D:/work', nfsShareUrl: 'nfs://nas/megacorps' }).join('\n');
  assert.match(withoutMount, /share lives at nfs:\/\/nas\/megacorps/);
  assert.match(withoutMount, /Clone the project repo under D:\/work/);
});
