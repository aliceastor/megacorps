import assert from 'node:assert/strict';
import test from 'node:test';
import { kanbanCards, projects, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { planMergeGate, selectMergeCandidate } from './merge-gate.ts';

const head = 'a'.repeat(40);
const repo = 'https://gitea.test/org/repo';
const url = `${repo}/pulls/12`;
test('URL-only PR is a candidate; a foreign origin is never the project repository', () => {
  assert.equal(selectMergeCandidate([{ type: 'pull_request', url }], { repoUrl: repo })?.pullRequestNumber, 12);
  assert.equal(selectMergeCandidate([{ pullRequestUrl: 'https://foreign.test/org/repo/pulls/12' }], { repoUrl: repo }), null);
});

for (const scenario of ['not_required', 'no_repo', 'no_candidate', 'no_head', 'missing_state', 'unavailable', 'wrong_base', 'stale', 'short', 'valid', 'artifact_refs', 'branch'] as const) {
  test(`provider evidence gate: ${scenario}`, async (t) => {
    const card: any = { id: 'card', companyId: 'company', projectId: 'project', columnStatus: 'in_review' };
    if (scenario === 'artifact_refs') card.executionLog = JSON.stringify({ kind: 'megacorps-report', status: 'completed', summary: 'Implemented and reviewed the requested change.', artifactRefs: [url] });
    const project = { id: 'project', completionRequiresMerge: scenario !== 'not_required', repoUrl: scenario === 'no_repo' ? null : repo, defaultBranch: 'main' };
    memoryDb(t, [[kanbanCards, [card]], [projects, [project]], [workProducts, ['no_candidate', 'artifact_refs'].includes(scenario) ? [] : scenario === 'branch' ? [{ id: 'wp', cardId: card.id, branch: 'feature', commitSha: head }] : [{ id: 'wp', cardId: card.id, type: 'pull_request', url, commitSha: scenario === 'stale' ? 'b'.repeat(40) : scenario === 'short' ? head.slice(0, 8) : head }]]]);
    const previous = process.env.GITEA_URL;
    const token = process.env.GITEA_ADMIN_TOKEN;
    process.env.GITEA_URL = 'https://gitea.test';
    process.env.GITEA_ADMIN_TOKEN = 'test-only-sentinel';
    t.after(() => { if (previous === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = previous; });
    t.after(() => { if (token === undefined) delete process.env.GITEA_ADMIN_TOKEN; else process.env.GITEA_ADMIN_TOKEN = token; });
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls++;
      if (scenario === 'unavailable') throw new Error('offline');
      return new Response(JSON.stringify(String(input).includes('/git/commits/') ? { sha: head } : { number: 12, state: scenario === 'missing_state' ? undefined : 'open', merged: false, html_url: url, head: { sha: scenario === 'no_head' ? null : head, ref: 'feature' }, base: { ref: scenario === 'wrong_base' ? 'release' : 'main' } }), { status: 200 });
    };
    const plan = await planMergeGate(card, { fetchImpl });
    assert.equal((plan as any).disposition, scenario === 'not_required' ? 'not_required' : ['valid', 'short', 'artifact_refs', 'branch'].includes(scenario) ? 'wait' : 'blocked');
    if (scenario === 'valid' || scenario === 'short') {
      assert.ok(calls > 0, 'reported SHA never skips provider verification');
      assert.equal((plan as any).headSha, head);
    }
  });
}
