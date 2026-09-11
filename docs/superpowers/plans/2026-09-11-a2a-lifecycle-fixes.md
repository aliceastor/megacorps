# A2A Lifecycle Fixes Implementation Plan

> **For agentic workers:** Use subagent-driven-development for bounded independent work, with root integration and final review. The user authorized implementation, main push, verified Portainer deployment and a new autonomous trial.

**Goal:** Remove the three platform defects reproduced by the expense-project trial without changing Hermes.

**Architecture:** Normalize the transport's final answer before report parsing; acknowledge consumed execution journals within the transaction that commits dispatch completion; keep unresolved remote work fenced after local cancellation/deadline and reconcile it using bounded read-only task queries. No report fabrication, automatic resubmission, or assumption that a local cancellation stops a remote process.

**Tech Stack:** TypeScript, Node test runner, PostgreSQL/Drizzle, existing A2A JSON-RPC client, Next.js status views.

## Global constraints

- Work in the user-requested Z:\AgentsHub\megacorps checkout, branch codex/a2a-lifecycle-fixes. Preserve untracked bugs2-report-20260905.md.
- Do not modify Hermes, its profiles/security/credentials/container or platform compose/env/mounts.
- The observed Hermes CancelTask marks task state but does not terminate its forwarded subprocess. Do not claim it proves process termination; favor draining the original task and keep capacity reserved until a natural terminal result.
- Keep existing task deadlines, review/merge evidence, accounting identity and retry limits. Reconciliation queries do not submit model work or invent evidence.
- Raw live transcripts stay in ignored .superpowers/sdd; checked-in fixtures must be synthetic and credential-free.
- Each bug has a focused commit, full tests/typecheck/build/CI including Docker green before redeploy; new project trial must report actual outcome honestly.

## Task 1: Final answer boundary

Files: apps/server/src/a2a-client.ts, adapters/a2a.ts as needed, a focused final-output module and tests, agent-report tests only where required.

- [x] Reproduce the saved expense input locally (694,932-character A2A text fails; its final 2,108-character report validates). Inspect framing rather than copying raw transcript into source.
- [x] Add synthetic failing cases covering CLI banners/reasoning/tool braces and quoted JSON before a valid final, plain Direct Chat final text, genuine truncated last report, historical valid report plus later invalid final, and legitimate quoted/braced answer content.
- [x] Implement a bounded deterministic final-answer projection for recognizable Hermes output. A final structured DataPart remains authoritative. Never choose an earlier valid report merely because the newest fails schema. Ambiguous framing fails closed; preserve valid ordinary text.
- [x] Verify end-to-end extraction using production schema and the live fixture offline. Assert no reasoning/tool transcript in projected chat output, unchanged status/children/dependencies, and no synthetic approvals.

Example regression expectation:
```ts
const parsed = extractAgentReport(projectFinalText(transcript));
assert.ok(parsed && 'report' in parsed);
assert.equal(parsed.report.status, 'progress');
assert.equal(parsed.report.children?.length, 2);
```

## Task 2: Atomic journal acknowledgment

Files: apps/server/src/dispatch.ts completion transaction, a2a-executions.ts only if needed, a2a-task-recovery.test.ts plus true dispatch regression.

- [x] Add a red test that executes the actual main dispatch completion path; a successful run must leave its terminal journal inactive, and the next same-card/scope invocation must receive a new execution identity.
- [x] Add the acknowledgment inside the transaction that writes task success (the branch around dispatch.ts:3563), before returning the completed card. Audit other direct success writes for the same ordering hole.
- [x] Test rollback leaves both task/journal unconsumed, replaying one run does not resubmit, and genuine next-stage work does not reuse old output. Cover parent split then integration.
- [x] Run focused dispatch/recovery/usage tests; make no remote calls.

Transaction invariant:
```ts
await tx.update(taskRuns).set({status: 'success', /* existing fields */});
await acknowledgeA2aExecution(`task-run:${taskRunId}`, tx);
// Both writes commit or both roll back.
```

## Task 3: Cancel/deadline reconciliation and capacity

Files: a focused a2a remote-reconciliation module, a2a-executions.ts, adapters/a2a.ts for reusable route resolution, dispatch capacity/loop hooks, routes.ts cancellation/archive/pause, chat-jobs admission/finish, relevant help/status UI as necessary.

- [x] Write red tests: cancel while remote working; timeout while remote working; restart with abandoned journal; task completion after cancellation; missing/wrong remote identity; concurrent claim versus stop; late result cannot create cards/merge/release another owner's capacity.
- [x] Record/derive remote work still outstanding from the durable journal. Local cancellation ends local card processing, but does not let another task or Direct Chat claim that agent while remote work is unresolved.
- [x] Add bounded periodic read-only reconciliation of the original endpoint/context/task ID with backoff. Resume across restart; never SendMessage during reconciliation. Unknown acceptance or missing task keeps an explicit unresolved state instead of freeing capacity. Route changes cannot redirect old work to a new server.
- [x] Natural remote completion permits dropping cancelled results, settling available actual usage to the original attempt and releasing only capacity no longer owned by other work. Timed-out execution retains required review/recovery handling; no late automatic merge.
- [x] Expose waiting-for-remote status so UI/API do not claim an idle agent or stopped remote task. Do not register Hermes CancelTask as a guaranteed hard stop.
- [x] Run real PostgreSQL race tests in CI and local deterministic tests; verify one submission and original task identity across lifecycle transitions. Branch CI 34573715866 and main CI 34574893431 passed.

## Integration and delivery

- [x] Review all three diffs together for ordering, authority, retries, accounting and route identity.
- [x] Run npm run typecheck, npm run test, npm run build; retain logs. PostgreSQL and Chromium run in CI.
- [x] Push review branch; after full CI green, fast-forward main, push and await Docker jobs. Preserve source SHA evidence.
- [x] Snapshot production; redeploy stack 42 with existing compose/env; verify SHA, mounts, health, unchanged Hermes. Verified revision e81d507f2d35774ef77f6f192af25005f9ec89d9 on server and web.
- [ ] Start one fresh small project through normal natural-goal submission. Observe no operator repair; independently verify repo/PR/test outcomes if reached. Stop repeated structural failures with evidence and fix remaining authorized defects rather than claiming success prematurely.

## Follow-up: observed CLI verifier footer

The fresh stock-check trial produced a valid terminal report followed by a Hermes file-mutation verifier warning. The source PR independently passes its 18 tests and 10 additional CLI cases; the platform nevertheless rejected the report boundary and retried the task. The automatic retry reached review without operator task intervention.

- Recognize only the observed complete verifier footer immediately after a terminal answer, with count/line shape checks; never strip arbitrary trailing prose or select an older report.
- Reproduce using the saved wire offline and synthetic fixtures; preserve normal schema, review and merge gates. No Hermes changes or additional model calls are needed to validate this transport fix.
- Run focused regression tests, typecheck, CI including Docker, and verify the deployed revision. The active lifecycle remains under observation; an open PR is not completion evidence.
