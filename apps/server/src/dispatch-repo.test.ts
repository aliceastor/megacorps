import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchInternals } from './dispatch.ts';

const project = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'snake_html',
  repoProvider: 'gitea-local',
  repoUrl: 'http://192.168.1.180:3300/default/snake_html.git',
  workPath: '',
  defaultBranch: 'main',
  protectedBranches: ['main'],
  workBranchPattern: 'megacorps/card-{cardId}-{agentSlug}',
  pullBeforeRun: true,
  pushAfterRun: true,
  completionPolicy: 'push_or_pr',
  publishRepoUrl: 'https://github.com/other/publish-site',
};

const card = { id: '11111111-2222-3333-4444-555555555555' };
const agent = { slug: 'ribel' };

test('repository protocol names project.repo_url as the only clone and push source of truth', () => {
  const protocol = dispatchInternals.projectGitProtocol(null, project as any, card as any, agent as any, null);
  assert.match(protocol, /http:\/\/192\.168\.1\.180:3300\/default\/snake_html\.git/);
  assert.match(protocol, /single source of truth|only clone\/push target|project\.repo_url/i);
  assert.doesNotMatch(protocol, /the workspace path is the repository identity/i);
});

test('repository protocol requires origin to match project.repo_url before push', () => {
  const protocol = dispatchInternals.projectGitProtocol(null, project as any, card as any, agent as any, null);
  assert.match(protocol, /git remote get-url origin/);
  assert.match(protocol, /do not push|must not push|hard fail/i);
  assert.match(protocol, /match/);
});

test('gitRemoteMatchesProjectRepo accepts credential/host rewrites of the same org/repo', () => {
  const { gitRemoteMatchesProjectRepo } = dispatchInternals;
  const projectUrl = 'http://192.168.1.180:3300/default/snake_html.git';
  assert.equal(gitRemoteMatchesProjectRepo('http://192.168.1.180:3300/default/snake_html.git', projectUrl), true);
  assert.equal(gitRemoteMatchesProjectRepo('http://agent-ribel:tok@gitea.lan:3300/default/snake_html.git', projectUrl), true);
  assert.equal(gitRemoteMatchesProjectRepo('git@gitea.lan:default/snake_html.git', projectUrl), true);
});

test('gitRemoteMatchesProjectRepo rejects a different repo or a parent-repo remote', () => {
  const { gitRemoteMatchesProjectRepo } = dispatchInternals;
  const projectUrl = 'http://192.168.1.180:3300/default/snake_html.git';
  assert.equal(gitRemoteMatchesProjectRepo('http://192.168.1.180:3300/default/other.git', projectUrl), false);
  assert.equal(gitRemoteMatchesProjectRepo('http://192.168.1.180:3300/default/monorepo.git', projectUrl), false);
  assert.equal(gitRemoteMatchesProjectRepo('http://192.168.1.180:3300/aliceastor/megacorps.git', projectUrl), false);
  assert.equal(gitRemoteMatchesProjectRepo(null, projectUrl), false);
  assert.equal(gitRemoteMatchesProjectRepo(projectUrl, null), false);
});
