# Unified Agent Reporting and Recovery Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the bounded independent reporting/prompt tasks, and execute recovery integration in this session. Track steps with checkboxes. User approved this design and explicitly requested planning followed by implementation on 2026-09-08; no further design approval is needed.

**Goal:** Make invalid reports, exhausted execution attempts, and missing completion evidence recover through the existing help-review workflow, with explicit ownership and bounded cost, while simplifying the instructions exposed to each Agent.

**Architecture:** Keep the existing card, task-run, review, approval and merge machinery. Normalize reports at one boundary; expose only role/stage-relevant instructions. Store durable recovery metadata alongside existing protocol repair metadata and route recovery through a help review; a recovery answer repairs routing/instructions or sends work back, never approves an artifact. All entry points share the same recovery authority and idempotency checks.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle/PostgreSQL, node:test/tsx, Next.js/React.

## Global constraints

- Workspace: Z:\AgentsHub\megacorps (same as \\10.0.1.1\DataSet\AgentsHub\megacorps). Keep the existing branch; no other clone/worktree.
- Do not modify Hermes profiles, credentials, security rules, runtime installation, or sessions administratively. MegaCorps prompt construction is in scope.
- Preserve untracked bugs2-report-20260905.md; do not commit it. Preserve and incorporate the existing peer-project-authority.test.ts draft where relevant.
- Boss coordinates only. A department head can execute only when it has no employees. Rank is not management authority.
- Never fabricate evidence, rewrite a foreign repository reference into an accepted one, infer approval from repair, bypass human gates, or reopen completed/cancelled cards from stale callbacks.
- No full model lifecycle loops during implementation. Targeted failing tests first, full local checks after integration, one CI/release/acceptance sequence only after code checks pass.
- Existing permission and company budget checks remain mandatory. A recovery limit transfers responsibility; it is not evidence of a structural defect.

## Acceptance matrix

| Requirement | Tasks | Observable result |
| --- | --- | --- |
| Less complex agent instructions | 2 | Each role/stage sees one supported help format and relevant operations only |
| Precise format correction | 1 | Field path, received type, expected constraint and correction instruction |
| Deterministic platform repair | 1, 3 | Whitelisted lossless normalization; rejects ambiguous status/evidence |
| Retry exhaustion does not abandon cards | 3 | Durable help-review owner or human request |
| Wrong repository/evidence | 3 | Return for real rework; no merge or Done |
| Busy senior / Boss + sole head | 3 | Queue eligible senior; Boss only repairs instructions/routing |
| Three senior actions | 3 | fix_card, rework, raise_to_human validated server-side |
| UI and API align | 4 | Durable recovery state visible and documented; native/webhook semantics agree |
| Bounded/idempotent recovery | 3, 5 | Duplicate callback cannot create another repair or reset the shared ceiling |

## Task 1 — One report validation boundary

**Files:** apps/server/src/agent-report.ts, apps/server/src/agent-results.ts; new apps/server/src/report-validation.ts and report-validation.test.ts; existing report-envelope.test.ts and agent-results.test.ts.

**Interface:** `formatReportIssues(value: unknown, issues: readonly {path: PropertyKey[]; message: string}[], prefix?: string): string`; `normalizeOptionalReportFields(value: unknown): { data: unknown; corrections: string[] }`. Validation still uses agentReportSchema/reportedWorkProductSchema. Only schema-known optional null fields may be omitted; optional null array members and required fields remain invalid. Original model output is retained by existing task logging. Do not alter verdicts, summaries, artifact ownership, repository, SHA or project values.

- [x] Add failing tests for nested child dependsOn:null, invalid workProducts[0].title/type, required summary:null, conflicting envelope, and original input immutability. Check precise paths and type-only received diagnostics (never echo secrets).
  ```ts
  const r = normalizeAgentResult({workProducts:[{type:'wrong',title:'x'}]});
  assert.equal(r.outcome, 'invalid');
  assert.match(r.reason!, /workProducts\[0\]\.type/);
  assert.match(r.reason!, /received|Received/);
  ```
- [x] Run `node --import tsx --test apps/server/src/report-validation.test.ts apps/server/src/report-envelope.test.ts apps/server/src/agent-results.test.ts`; record expected assertion failures before implementation.
- [x] Implement schema-aware optional-null normalization and shared diagnostic formatting; apply the same boundary to embedded and separately supplied reports. Maintain conflict detection and one final current report selection.
  ```ts
  const normalized = normalizeOptionalReportFields(parsed);
  const checked = agentReportSchema.safeParse(normalized.data);
  if (!checked.success) return {error: formatReportIssues(normalized.data, checked.error.issues)};
  ```
- [x] Run the same targeted suite; review diff for lossy repairs. Preserve unchanged valid report behavior and hostile/ambiguous input rejection.
- [ ] Commit only reporting changes after review: `fix: normalize unambiguous reports with actionable validation feedback`.

## Task 2 — Role/stage prompts and project authority

**Files:** apps/server/src/role-playbooks.ts, dispatch.ts prompt builders only, company-context.ts as needed; new agent-report-guidance.ts and tests; existing peer-project-authority.test.ts, message-project-authority.test.ts, native-reporting.test.ts.

**Interface:** `agentReportGuidance(mode: 'execution'|'management'|'review'|'recovery'): string`. Keep protocol field names; do not add a second reporting language. Recovery schema is Task 3's action contract. Use literal schema-valid examples, selected by role/stage. Existing optional HTTP compatibility stays outside primary task instructions.

- [x] Add failing tests that all exposed report examples parse with the shared schema and no native help instruction recommends status needs_review. Check management children remain permitted, ordinary reviews return rework instead of inventing new work, and worker guidance omits panel contracts unless relevant.
  ```ts
  assert.doesNotMatch(MEMBER_PLAYBOOK, /status\s+"needs_review"/);
  assert.match(MEMBER_PLAYBOOK, /input_required/);
  assert.match(agentReportGuidance('execution'), /request/);
  ```
- [x] Run prompt tests including the existing peer draft; verify missing authority and contradictory guidance failures before editing.
- [x] Fix native status/help wording and the stale prohibition on future child work. Group prompts as role, goal/acceptance, canonical project authority, current evidence, permitted response. Label past summaries/knowledge as contextual data; current project authority overrides old repo instructions.
- [x] Include sanitized project identity in peer answer-only prompts using company/project/actor scope; no repository credentials or execution workflow in informational peer answers. Keep original question and peer deduplication.
- [ ] Run prompt, company context, peer, message authority tests. Commit prompt changes independently after review: `fix: simplify role prompts and preserve current project authority`.

## Task 3 — Durable recovery through existing help review

**Files:** new apps/server/src/card-recovery.ts and card-recovery.test.ts; protocol-repair.ts, run-retry.ts, dispatch.ts lifecycle hooks, merge-gate.ts, delegated-help.ts, agent-results.ts permission hook, routes.ts callback hook; packages/shared/src/index.ts for typed recovery actions.

**State:** Extend ProtocolRepairState with optional `recovery`, leaving existing dispatch/review keys and DB JSON column intact. No schema migration required. Persist original assignee/reviewer, failed stage, reason, handled event keys, visited owners, recovery round, state and timestamps. State modes are `awaiting_manager`, `reworking`, `awaiting_human`, `resolved`. Formatting normalization is synchronous and logged; existing protocol same_session/fresh_context modes represent platform correction in progress.

**Action contract:** A recovery report uses the existing report envelope with a new optional field:
```ts
recovery: {
  action: 'fix_card' | 'rework' | 'raise_to_human';
  reason: string;
  instructions?: string;
  patch?: { body?: string; assigneeSlug?: string };
}
```
`fix_card` accepts only those explicit patch fields; retain original goal/history and require nonempty repair explanation. A new assignee must be active, same company and authorized by actual organization relationships; Boss cannot become executor. `rework` requires concrete instructions and returns original execution/review stage as appropriate. `raise_to_human` creates one actionable existing human gate and leaves evidence gates intact. Recovery never accepts an approved product verdict as a repair action.

**Interfaces:** `requestCardRecovery(card, {reason,eventKey,actorId,stage})` persists/claims the failure once and routes to an eligible owner; `recoveryPrompt(card)` returns current problem, scope and three actions; `applyRecoveryReport(card, actorId, report, taskRunId?)` checks current authority and applies one action; `isRecoveryReview(card, actorId?)` separates guidance from quality review.

- [x] Write failure fixtures with real memoryDb orchestration for exhausted dispatch/review, no_candidate, missing superior, busy superior, two-agent company, duplicate event, late callback, pending human gate, and active merge intent. Assert no Done or accepted merge is produced.
  ```ts
  await requestCardRecovery(card, failure);
  await requestCardRecovery(structuredClone(card), failure);
  assert.equal(card.columnStatus, 'needs_review');
  assert.equal(card.reviewerId, head.id);
  assert.equal(card.protocolRepairState.recovery.round, 1);
  ```
- [x] Implement a card-locked transaction with existing authority predicates. Refuse terminal/deleted/cross-company cards, pending human gates, and provider merge states in_flight/accepted/uncertain. Resolve reviewer then department/manager/Boss using organization relationships, skip self/visited/cyclic/inactive recipients; busy recipients remain eligible and queued. Persist before scheduling, allowing existing cron to recover scheduling after a crash.
- [x] Retain one total per-card recovery ceiling of three manager rounds across failure categories. Each round gets existing bounded task attempts. Clear only the failed stage's retry streak when sending work back; keep recovery round history. If no eligible owner or no further progress allowance, create one human gate with problem and attempted history. Do not silently reset the ceiling on progress.
- [x] Connect protocol repair exhaustion/helper failure, dispatch/lease retry exhaustion, run-retry exhaustion, delegated assignment failure, missing merge candidate/repo configuration, and native no-superior help. Distinguish permission/security problems: route explanation/decision only, never auto-retry a forbidden action or change authorization.
- [x] Intercept recovery replies before quality verdict/persist-product/merge processing in native and authenticated webhook paths. Preserve current run/company/reviewer and stale-result guards. Review prompts choose recovery before Boss assessment; Boss guidance does not invoke code/test/clone instructions.
- [x] Implement the three actions atomically; cancel only obsolete ordinary approvals, preserve independent panels and human gates, restore original reviewer on rework, release only original attempt capacity, enqueue the proper original stage. Message delegation recovery must restore its exact request/assignee rather than executing the whole card.
- [x] Run recovery, protocol, run-retry, merge-gate, native and webhook regression suites. Add real PostgreSQL transaction cases to the existing integration harness for duplicate ownership/rollback races; do not rely solely on the memory double for concurrency.
- [ ] Commit reviewed recovery code: `feat: route blocked work through bounded managerial recovery`.

## Task 4 — Visible recovery and aligned API help

**Files:** apps/web/src/components/kanban/card-types.ts; apps/web/src/lib/card-situation.ts and card-situation.test.ts; existing localization dictionaries; API help source located by `rg -n 'megacorps-report|agentReportSchema' apps/server/src apps/web/src`.

- [x] Add tests for correction in progress, queued manager name, rework and human escalation; terminal status and explicit human gates take precedence over stale recovery metadata.
- [x] Render state from protocolRepairState without introducing new board columns. Display owner and concrete reason; use existing card comments/history to show recovery decisions.
  ```ts
  if (!terminal && recovery?.mode === 'awaiting_manager')
    return finish('kanban.situation.recoveryManager', {name: agentName(recovery.ownerId) ?? you}, 'warning');
  ```
- [x] Document native help, report-only correction, recovery actions, authority restrictions and the difference between report completed and card Done. Generate/validate examples from the shared contract.
- [ ] Run web unit tests/typecheck/build and API-help tests; commit: `feat: show recovery ownership and document agent recovery actions`.

## Task 5 — Integrated verification and delivery

- [ ] Review every changed entry point against the acceptance matrix, including authenticated webhook, native adapter, task queue, merge gate and UI. Fix test expectations only when their former behavior is intentionally superseded, retaining security assertions.
- [ ] Run targeted tests first, then `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build` from the shared workspace. Use the existing supported Node runtime; avoid npm cwd shell problems on UNC by invoking node directly with explicit working directories where needed.
- [x] Run existing real-PG/Chromium harnesses with isolated test data only. Capture command, commit, counts, failures and limitations in the plan execution record. Do not claim omitted checks passed.
- [ ] Obtain a whole-diff correctness/authority review; resolve material findings. Commit only task files and this plan, never credentials or the untracked root report.
- [ ] Push the verified branch/main according to the user's existing release authorization; verify exact-SHA CI including Docker. Redeploy stack 42 once through the documented Portainer flow; verify running Web/Server SHA and health. No Hermes changes.
- [x] Run one fresh development task and one fresh documentation task with natural goals, no manual repair/replay/answer injection. Observe autonomous format correction and managerial rework using controlled tests; inspect real artifacts and merge provenance for the natural tasks. Report a lifecycle failure honestly rather than starting repeated model loops.

## Execution record

- 2026-09-08: Design approved by user; plan written before production edits. Baseline c659d04; only existing peer test draft and untracked root report present. Implementation and verification boxes above remain open until supported by actual outputs.
- 2026-09-08 implementation verification: Server **1,071 passed, 15 explicitly skipped PostgreSQL tests, 0 failures** (1,086 total); Web **131 passed**; Shared **17 passed**. Server/shared typechecks and the Web production build passed. Commands used the existing Node 22 runtime, `node --test --import tsx`, `tsc --noEmit`, and `next build --webpack` from the Z workspace. Full PostgreSQL integration remains pending CI; it was not run against production.
- Chromium recovery checks: **3 passed**, covering 390px/1280px ownership and reason rendering, plus required human guidance/resume without artifact approval. The narrow screenshot was visually inspected; text wraps within the panel. Existing CI will run the full browser suite.
- Assertion RED→GREEN evidence covers report diagnostics/null normalization, scoped prompts and current project identity, recovery routing/actions/transports, UI status, and human guidance. A late contract test caught a recovery example using `progress` after the handler required `completed`; the example and stage guidance now agree, including no incompatible help example during a recovery decision.
- Independent whole-diff review found three issues: invalid webhook action precedence, delegated permission propagation, and deduplication across subsequent delegated attempts. All three were reproduced, fixed, and independently rechecked (**4 targeted regressions passed**). A separate focused recovery suite passed **49/49**. No remaining finding was reported within that follow-up scope.
- Delivery grouping adjustment: report handling, prompts, shared schema and recovery hooks modify the same server entry points and depend on one another. Commit the plan, one coherent backend change, and the UI change separately instead of publishing intermediate server states that cannot compile. No root report, credentials, ignored evidence, or Hermes runtime configuration belongs in these commits.
- CI, push/main, deployment, and natural development/documentation lifecycle are still pending at this record. Local test success does not establish autonomous production acceptance.
- Initial three commits were pushed to main at c877d79. CI 34243525316 exposed three PostgreSQL-only assertion failures: the new rollback fixture must inspect Drizzle's wrapped PostgreSQL `cause`; two existing permission concurrency cases still expected Blocked and persisted partial evidence. Their cancellation/reassignment/new-lock assertions remain unchanged; the unchanged-authority case now requires one pending human gate, permission restriction, and zero work products. A test-only follow-up corrects these expectations; no production deployment occurred before CI completion.
- CI 34244059741 passed the recovery rollback assertions but exposed a real machine-runner permission ordering difference (partial evidence persisted before permission routing) and a fixture migration lock timeout. Runner permission now routes first; actual authenticated dispatch/review callbacks and duplicates have RED→GREEN coverage (31 targeted tests passed). Repeated companyless fixture startup now uses the same fixture-only migration admission lock as initial setup; application lock timeout remains 1200ms and production migrations are unchanged. Runner recovery decisions are also being aligned with the native/webhook handler before the next release check.
- Runner recovery alignment is complete: valid decisions resume the original stage, malformed/conflicting decisions receive bounded correction, and ordinary approval cannot substitute for recovery. Authenticated callback/deduplication/outside-context regressions plus related runner/protocol/usage cases passed **40/40**; server typecheck passed. PostgreSQL and full CI remain pending the subsequent run.
- Release `213ecce`: CI **34245200443** passed all three jobs, including server/web Docker; Server **1,195**, Web **131**, Shared **17**, Chromium **126** passed, zero failures/skips. Stack 42 redeployed at 2026-09-08T15:48:42Z; both application OCI revisions matched this SHA, all four services healthy, mounts/compose/environment/database and Gitea images preserved, Hermes unchanged.
- The single natural development/documentation trial ran 15:52–16:20 UTC. Automatic report correction and platform merges occurred, but full acceptance **FAILED**: repeated head mismatch re-reviews had no finite recovery exit; the merged CLI counts code-fence examples as tasks; the merged onboarding document points users to the API service as the Kanban UI. Two root cards were unfinished. No manual repair/replay/answer injection occurred. At 16:20 UTC, after saving failure evidence, five unfinished trial cards were cancelled to stop further spend; three already-Done cards and their repositories were retained. No second natural trial was launched.
- Follow-up release scope is bounded to two observed/reproduced platform gaps: valid reviewer help across native/webhook/Runner (including stale authority and recovery/permission guards), and head drift entering finite managerial recovery while retaining exact-head review. Artifact quality failures remain explicit; no platform code will invent successful test/review evidence. Detailed snapshots and final release verification are recorded in the ignored `.superpowers/sdd/unified-recovery-delivery-report.md`.
- Follow-up verification: **66/66** reviewer-help, drift and webhook compatibility tests passed; **132/132** recovery/review-identity/human/panel/completion regressions passed; server typecheck and diff check passed. Independent review reproduced and then confirmed fixes for stale reviewer help clearing a newer dispatch lock, and loss of required panel review after recovery. Both legitimate review statuses are supported. Manager and human guidance reopen required panels; no direct ordinary review substitutes for them. The original exact-head and no-unauthorized-merge assertions remain in place. Full CI and deployment of this follow-up remain pending its new commit.
