import { db, sql } from '../db/client.ts';
import { eq } from 'drizzle-orm';
import { kanbanCards, projects, externalWaits } from '../db/schema.ts';
import { parkForMerge, reconcileMergeWait, handleGiteaWebhookEvent } from '../merge-gate.ts';
import { executeAuthorizedMerge } from '../authorized-merge.ts';

// Dedicated process per contender: module-local serializeMerge cannot mask SQL races.
const input = JSON.parse(process.env.MC_TEST_MERGE_INPUT!);
const head = 'a'.repeat(40);
const fetchImpl: typeof fetch = async (_url, init) => {
  if (init?.method === 'POST') {
    if (input.operation === 'crash') {
      process.send?.({ phase: 'committed-claim-before-provider-return' });
      await new Promise(() => {});
    }
    return new Response(null, { status: 204 });
  }
  const path = new URL(String(_url)).pathname;
  const value = path.endsWith('/version') ? { version: '1.22.6' } : path.endsWith('/user') ? { login: 'service' } : path.endsWith('/permission') ? { permission: 'admin' } : path.endsWith('/collaborators') ? [] : path.endsWith('/branch_protections') ? [{ rule_name: '[m]ain', created_at: '2026-09-05T00:00:00Z', enable_push: false, enable_merge_whitelist: true, merge_whitelist_usernames: ['service'], merge_whitelist_teams: [] }, { rule_name: '**', created_at: '2026-09-05T00:00:02Z', enable_push: true, enable_push_whitelist: false, enable_merge_whitelist: true, merge_whitelist_usernames: [], merge_whitelist_teams: [] }] : path.endsWith('/pulls/12') ? { number: 12, state: input.merged ? 'closed' : 'open', merged: Boolean(input.merged), head: { sha: head }, base: { ref: 'main' } } : { default_branch: 'main' };
  return new Response(JSON.stringify(value));
};
try {
  const [card] = await db.select().from(kanbanCards).where(eq(kanbanCards.id, input.cardId));
  const [project] = await db.select().from(projects).where(eq(projects.id, card!.projectId!));
  process.send?.({ phase: 'ready' });
  await new Promise<void>(resolve => process.once('message', () => resolve()));
  let result;
  if (input.operation === 'park') result = await parkForMerge(card!, { disposition: 'wait', project: project!, candidate: { kind: 'pull_request', pullRequestNumber: 12, pullRequestUrl: 'https://gitea.test/org/repo/pulls/12', branch: 'feature', headSha: head, workProductId: null }, headSha: head, defaultBranch: 'main', waitingFor: 'merge into main', externalId: '12', externalUrl: 'https://gitea.test/org/repo/pulls/12' }, { fetchImpl });
  else if (input.operation === 'callback') result = await handleGiteaWebhookEvent({ eventName: 'pull_request', payload: { repository: { full_name: 'org/repo' }, action: 'closed', pull_request: { number: 12, merged: true, state: 'closed', head: { sha: head }, base: { ref: 'main' } } }, fetchImpl });
  else if (input.operation === 'reconcile') result = await reconcileMergeWait(input.waitId, { immediate: true, fetchImpl });
  else result = await executeAuthorizedMerge(input.waitId, { fetchImpl });
  process.send?.({ phase: 'done', result });
} catch (error) { process.send?.({ phase: 'error', error: String(error) }); process.exitCode = 1; }
finally { await sql.end({ timeout: 2 }); process.disconnect?.(); }
