import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeAuthorizedMessage,
  mergeDriftMessage,
  mergeVerdict,
  normalizeBranchRef,
  parsePullRequestNumber,
  repoFullNameFromUrl,
  repoSlugFromProject,
  sameCommit,
  sameRepoFullName,
  selectMergeCandidate,
  type MergeEventFacts,
  type MergeWaitFacts,
} from './merge-gate.ts';

const AUTHORIZED = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const DRIFTED = '9999999999999999999999999999999999999999';

function wait(overrides: Partial<MergeWaitFacts> = {}): MergeWaitFacts {
  return { provider: 'gitea', status: 'waiting', externalId: '12', authorizedHeadSha: AUTHORIZED, ...overrides };
}

function pullEvent(overrides: Partial<MergeEventFacts> = {}): MergeEventFacts {
  return { kind: 'pull_request', defaultBranch: 'main', action: 'closed', merged: true, headSha: AUTHORIZED, baseRef: 'main', pullRequestNumber: 12, ...overrides };
}

test('parsePullRequestNumber reads Gitea and GitHub pull request URLs', () => {
  assert.equal(parsePullRequestNumber('http://gitea.lan:3300/mega-corps/website/pulls/12'), 12);
  assert.equal(parsePullRequestNumber('https://github.com/org/repo/pull/481'), 481);
  assert.equal(parsePullRequestNumber('http://gitea.lan/org/repo/pulls/7/files'), 7);
  assert.equal(parsePullRequestNumber('http://gitea.lan/org/repo/pulls/7?tab=diff'), 7);
  assert.equal(parsePullRequestNumber('http://gitea.lan/org/repo/commit/abc123'), null);
  assert.equal(parsePullRequestNumber(null), null);
  assert.equal(parsePullRequestNumber(''), null);
});

test('repoFullNameFromUrl normalizes clone, browse and scp style URLs', () => {
  assert.equal(repoFullNameFromUrl('http://gitea.lan:3300/Mega-Corps/Website.git'), 'mega-corps/website');
  assert.equal(repoFullNameFromUrl('https://github.com/org/repo'), 'org/repo');
  assert.equal(repoFullNameFromUrl('http://agent-alice:tok@gitea.lan:3300/mega-corps/website.git'), 'mega-corps/website');
  assert.equal(repoFullNameFromUrl('git@gitea.lan:mega-corps/website.git'), 'mega-corps/website');
  assert.equal(repoFullNameFromUrl('http://gitea.lan:3300/onlyone'), null);
  assert.equal(repoFullNameFromUrl(null), null);
  assert.equal(sameRepoFullName('Mega-Corps/Website.git', 'mega-corps/website'), true);
  assert.equal(sameRepoFullName('mega-corps/website', 'mega-corps/other'), false);
});

test('repoSlugFromProject returns the Gitea org and repo', () => {
  assert.deepEqual(repoSlugFromProject({ repoUrl: 'http://gitea.lan:3300/mega-corps/website.git' }), { org: 'mega-corps', repo: 'website' });
  assert.equal(repoSlugFromProject({ repoUrl: null }), null);
  assert.equal(repoSlugFromProject(null), null);
});

test('normalizeBranchRef strips refs/heads and blanks', () => {
  assert.equal(normalizeBranchRef('refs/heads/main'), 'main');
  assert.equal(normalizeBranchRef('feature/x'), 'feature/x');
  assert.equal(normalizeBranchRef('  '), null);
  assert.equal(normalizeBranchRef(undefined), null);
});

test('sameCommit requires exact full hexadecimal SHAs', () => {
  assert.equal(sameCommit(AUTHORIZED, AUTHORIZED.toUpperCase()), true);
  assert.equal(sameCommit(AUTHORIZED, AUTHORIZED.slice(0, 8)), false);
  assert.equal(sameCommit(AUTHORIZED.slice(0, 7), AUTHORIZED), false);
  assert.equal(sameCommit('not-a-sha', 'not-a-sha'), false);
  assert.equal(sameCommit(AUTHORIZED.slice(0, 6), AUTHORIZED), false, 'six characters is too short to trust');
  assert.equal(sameCommit(AUTHORIZED, DRIFTED), false);
  assert.equal(sameCommit(null, AUTHORIZED), false);
  assert.equal(sameCommit(AUTHORIZED, ''), false);
});

test('selectMergeCandidate prefers the newest pull request on the project repo', () => {
  const project = { repoUrl: 'http://gitea.lan:3300/mega-corps/website.git', defaultBranch: 'main' };
  const candidate = selectMergeCandidate([
    { id: 'wp-new', pullRequestUrl: 'http://gitea.lan:3300/mega-corps/website/pulls/12', commitSha: AUTHORIZED, createdAt: '2026-09-03T10:00:00.000Z' },
    { id: 'wp-old', pullRequestUrl: 'http://gitea.lan:3300/mega-corps/website/pulls/9', commitSha: DRIFTED, createdAt: '2026-09-01T10:00:00.000Z' },
  ], project);
  assert.equal(candidate?.kind, 'pull_request');
  assert.equal(candidate?.pullRequestNumber, 12);
  assert.equal(candidate?.headSha, AUTHORIZED);
  assert.equal(candidate?.workProductId, 'wp-new');
});

test('selectMergeCandidate ignores work products on another repository', () => {
  const project = { repoUrl: 'http://gitea.lan:3300/mega-corps/website.git', defaultBranch: 'main' };
  const candidate = selectMergeCandidate([
    { id: 'other', pullRequestUrl: 'https://github.com/other/repo/pull/3', repoUrl: 'https://github.com/other/repo', commitSha: DRIFTED, createdAt: '2026-09-03T10:00:00.000Z' },
    { id: 'ours', branch: 'megacorps/card-1', commitSha: AUTHORIZED, createdAt: '2026-09-02T10:00:00.000Z' },
  ], project);
  assert.equal(candidate?.kind, 'branch');
  assert.equal(candidate?.branch, 'megacorps/card-1');
  assert.equal(candidate?.headSha, AUTHORIZED);
});

test('selectMergeCandidate has nothing to merge for the default branch or an empty board', () => {
  const project = { repoUrl: 'http://gitea.lan:3300/mega-corps/website.git', defaultBranch: 'main' };
  assert.equal(selectMergeCandidate([{ id: 'onmain', branch: 'refs/heads/main', commitSha: AUTHORIZED }], project), null);
  assert.equal(selectMergeCandidate([{ id: 'report', title: 'Report', url: 'http://gitea.lan:3300/mega-corps/website/raw/report.md' }], project), null);
  assert.equal(selectMergeCandidate([], project), null);
  assert.equal(selectMergeCandidate([{ id: 'x', commitSha: AUTHORIZED }], null), null);
});

test('mergeVerdict: only the exact authorized head merged into the default branch is success', () => {
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent() }), 'success');
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ headSha: AUTHORIZED.slice(0, 10) }) }), 'drift');
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ baseRef: 'refs/heads/main' }) }), 'success');
});

test('mergeVerdict: a merge of a different head is drift, not completion', () => {
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ headSha: DRIFTED }) }), 'drift');
});

test('mergeVerdict: a hand-made wait with no authorized head keeps the plain merged meaning', () => {
  assert.equal(mergeVerdict({ wait: wait({ authorizedHeadSha: null }), event: pullEvent({ headSha: DRIFTED }) }), 'success');
  assert.equal(mergeVerdict({ wait: wait({ authorizedHeadSha: null }), event: pullEvent({ action: 'synchronized', merged: false, headSha: DRIFTED }) }), 'ignore');
});

test('mergeVerdict: new commits on the pull request are drift, an unchanged head is not', () => {
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ action: 'synchronized', merged: false, headSha: DRIFTED }) }), 'drift');
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ action: 'synchronize', merged: false, headSha: DRIFTED }) }), 'drift');
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ action: 'synchronized', merged: false, headSha: AUTHORIZED }) }), 'ignore');
});

test('mergeVerdict: closing without merging fails the wait', () => {
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ merged: false }) }), 'failure');
});

test('mergeVerdict ignores events that are not this wait', () => {
  assert.equal(mergeVerdict({ wait: wait({ provider: 'github' }), event: pullEvent() }), 'ignore');
  assert.equal(mergeVerdict({ wait: wait({ status: 'superseded' }), event: pullEvent() }), 'ignore');
  assert.equal(mergeVerdict({ wait: wait({ externalId: '13' }), event: pullEvent() }), 'ignore');
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ baseRef: 'release/1.0' }) }), 'ignore');
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ action: 'opened', merged: false }) }), 'ignore');
  assert.equal(mergeVerdict({ wait: wait(), event: pullEvent({ action: 'reopened', merged: false }) }), 'ignore');
});

test('mergeVerdict: a push closes the wait only when the default branch carries the authorized head', () => {
  const push = (overrides: Partial<MergeEventFacts> = {}): MergeEventFacts => ({ kind: 'push', defaultBranch: 'main', ref: 'refs/heads/main', containsAuthorizedHead: true, ...overrides });
  assert.equal(mergeVerdict({ wait: wait(), event: push() }), 'success');
  assert.equal(mergeVerdict({ wait: wait(), event: push({ containsAuthorizedHead: false }) }), 'ignore');
  assert.equal(mergeVerdict({ wait: wait(), event: push({ ref: 'refs/heads/megacorps/card-1' }) }), 'ignore');
  assert.equal(mergeVerdict({ wait: wait({ authorizedHeadSha: null }), event: push() }), 'ignore');
  // A push is repo-wide, so the PR number on the wait must not filter it out.
  assert.equal(mergeVerdict({ wait: wait({ externalId: '999' }), event: push() }), 'success');
});

test('board messages name the head and the target', () => {
  const authorized = mergeAuthorizedMessage({
    headSha: AUTHORIZED,
    defaultBranch: 'main',
    candidate: { kind: 'pull_request', pullRequestUrl: 'http://gitea.lan/mega-corps/website/pulls/12', pullRequestNumber: 12, branch: 'megacorps/card-1', headSha: AUTHORIZED, workProductId: null },
  });
  assert.match(authorized, new RegExp(AUTHORIZED));
  assert.match(authorized, /#12/);
  assert.match(authorized, /merged into main/);
  const drift = mergeDriftMessage({ authorized: AUTHORIZED, observed: DRIFTED, reason: 'new commits were pushed.' });
  assert.match(drift, new RegExp(`${AUTHORIZED} to ${DRIFTED}`));
  assert.match(drift, /back in review/);
});
