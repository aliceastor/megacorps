import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDeliverablesPath, projectSharedFileSpaceLines, projectSharedWorkspacePath, workspaceSlug } from './project-workspace.ts';

test('project shared workspace paths are derived from company and project slugs', () => {
  const company = { name: 'Mega Corps', slug: 'mega-corps' };
  const project = { id: 'project-1', name: 'TubeLike Research' };

  assert.equal(workspaceSlug('TubeLike Research', 'project'), 'tubelike-research');
  assert.equal(projectSharedWorkspacePath(company, project), '/workspaces/mega-corps/tubelike-research');
  assert.equal(projectDeliverablesPath(company, project, 'card-123'), '/workspaces/mega-corps/tubelike-research/deliverables/card-123/');
});

test('project shared file space instructions reject runtime scratch as final output', () => {
  const lines = projectSharedFileSpaceLines({ slug: 'aurora' }, { name: 'Video Platform', workspacePathHint: '/srv/work/video' }, 'card-abc');
  const text = lines.join('\n');
  assert.match(text, /Project shared file space: \/workspaces\/aurora\/video-platform\//);
  assert.match(text, /Project deliverables path: \/workspaces\/aurora\/video-platform\/deliverables\/card-abc\//);
  assert.match(text, /\/tmp are temporary only/);
  assert.match(text, /workProducts/);
});
