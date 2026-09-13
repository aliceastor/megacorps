# Cross-department Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development for bounded independent tasks, then independent whole-change review. Primary owns integration and all commits/builds/browser/deployment.

**Goal:** Replace cross-department delegation with collaboration child cards anchored to the requesting original card, and allow Boss department-representative fallback when no Head exists.

**Architecture:** Reuse kanbanCards.parentCardId/splitRequestKey, existing reviewerId/reviewerIds/reviewMode, cardComments metadata, guarded writes, review rounds, delivery acceptance and parent cascade. No parallel workflow engine or Hermes changes. Valid requests directly create children, without another approval stage.

**Tech Stack:** TypeScript, Zod, Drizzle/PostgreSQL, Node tests, Next/Playwright.

## Global Constraints
- Work directly in Z:\AgentsHub\megacorps; baseline4032f55 already pushed but not deployed.
- Preserve other untracked bugs2 report and help-project-gitea plan. Old cross-department-delegation plan is superseded and must not be implemented.
- Cross-company/self/foreign target spoofing prohibited. Target collaboration assignee is a formal Head. Boss fallback alone may choose highest position importance (smallest rank) if no Head exists.
- Staff expected reviewers: source Head plus requester. Head request reviewer: requester. Existing panel downgrade remains, busy alone is not reviewer exclusion. Review/merge/evidence must still pass.
- Every child parentCardId is the source request card. Return to its original owner/context; never reparent to either Head's unrelated card, never replace source assignee.
- Reuse existing retry, repair, fanout, depth, dedup and recovery behavior. No live model tasks for verification; use real PG fixtures plus read-only production previews.

## Shared contract
```ts
// Add to existing agentReportRequestSchema; normalized report stays singular request.
{ kind: 'collaboration', departmentSlug: string, question: string, acceptance: string[] }
// departmentSlug max120, question current question constraint, acceptance1..10 strings1..1000.
// Server generates title from original card and department; no actor/reviewer IDs accepted from agent.
// primary module, used by native/runner/webhook result consumers:
processCollaborationRequest(card, requester, request, taskRunId?)
  // returns Promise<{ created: string[]; errors: string[] }>, same shape as existing child splitting.
// Child recognizable via server-only unique splitRequestKey prefix 'collaboration:'.
// Trusted child card comment action 'collaboration_requested' metadata:
// { sourceCardId, requesterAgentId, sourceDepartmentId, targetDepartmentId,
//   requestedReviewerIds, sourceTaskRunId }
```

## Task1: Boss fallback and removal of obsolete option (worker1)
Files: company-workflow.ts plus tests; positions-page.tsx and tests; shared index.ts position schema section only; routes.ts position handlers only. No report schema/webhook/prompt helper edits.
- [x] RED: Boss with a department Head still targets Head despite busy/offline; no Head selects active dept member with smallest valid position rank; ties deterministic, empty/foreign/Boss excluded; no general Staff cross-dept permission added.
- [x] Implement one department representative resolver used by Boss targets and readiness. Ordinary structural role/reporting lines remain actual organizational facts; do not promote fallback member or broaden its authority. Existing real Head runtime issue remains waiting/recovery, not fallback.
- [x] RED: Position input and editor no longer expose/store meaningful canDelegateAcrossDepartments option. Remove checkbox, editor state/submission and injected preview text. Older payload key must grant no behavior; keep DB storage inert for migration compatibility.
- [x] GREEN: Node policy/position route tests, web unit tests, typecheck. Provide browser assertion location for primary to run.

## Task2: Existing review and parent return compatibility (worker2)
Files: review-rounds.ts/review-panel.ts tests if needed; dispatch.ts integrationSection (~1347) and cascadeParentStatus (~2528) only; delivery-acceptance/child-gate adjacent files only if proven needed. Primary owns other dispatch ranges.
- [x] RED using real PG: collaboration child assignee target Head, reviewerId source Head, reviewerIds source Head+Staff and reviewMode panel. Both active reviewers selected including busy reviewer (queued); one missing/inactive/runtime unavailable can degrade with metadata reason; none cannot approve. Revision rejection/fixes remain existing panel pipeline.
- [x] RED: accepted cooperation child under Staff card wakes Staff card for execution/integration; no managerial auto-accept shortcuts or wrong Head reparenting; duplicate cascade does not queue duplicate active runs; unaccepted child cannot resume or complete parent.
- [x] Make minimal corrections to existing paths. Parent integration wording distinguishes executing Staff from strategy-only Boss; evidence is inherited and must not trigger pointless recreation of delivered work. Head collaboration uses normal review unless normal critical/panel requirements apply.
- [x] GREEN: existing review/parent/recovery tests plus new regression. No independent acceptance engine or new table. Escalate any ownership assumptions to primary before changing interfaces.

## Task3: Canonical request and guarded child creation (primary)
Files: packages/shared/src/index.ts report request section/test, new collaboration-requests.ts/test, agent-results.ts/tests, dispatch native dispatch processing, runner-routes dispatch completion, routes task-complete dispatch section; agent-operation-guide, role-playbooks, agent-report-guidance, API Help plus tests.
- [x] RED validate canonical collaboration request and reject invalid target/empty acceptance, conflicting children/delegations/checkpoint/failed status. Preserve exact path feedback.
- [x] RED real PG creator: requester is source card's authorized active task owner, same-company source/target departments differ, target has formal Head; source requester/head-derived reviewers; no arbitrary supplied permissions. Child inherits company/project/goal/priority and has required acceptance body, correct parent, target dept, panel for Staff.
- [x] Create under existing lockResultAuthority transaction, unique deterministic splitRequestKey over source/actor/request. Duplicate replay returns existing child, no new round. Bound children/rounds and ancestor target cycles. Store provenance comment atomically with child. No new schema/table needed.
- [x] Hook all owner dispatch result channels before general input_required help handling. On success treat the consumed collaboration request as progress, keep parent waiting on children, complete original run safely; on failure reuse precise feedback/retry. Non-owner message/reviewer contexts must not accidentally mutate a different owner's card: explicitly route/return actionable help until owned-card context is available; never silently consume a request.
- [x] Emit card created/parent timeline through existing helpers. Recover missed wake/event via ordinary scheduler/cascade. Preserve review gates even if report incorrectly says completed.
- [x] Inject minimal collaboration example, source card/target department pointers and reviewer/return semantics. Remove obsolete cross-delegation permission from API Help; document Boss fallback.

## Task4: Integration, review, release (primary)
- [x] Self-review source identity, dedup, concurrency, role & tenant boundaries, mandatory delegation vs requesting help, parent reviewer vs child panel and single-review fallback.
- [x] Fresh independent whole-change review; resolve material findings.
- [ ] Tests in apps/server cwd with real isolated PG: node --test --test-concurrency=4 --import tsx 'src/**/*.test.ts'. Other workspace tests + typecheck. One production build and relevant browser tests, then exact-SHA full CI including browser/Docker.
- [ ] Commit coherent changes and push main. Do not deploy4032f55 separately; deploy latest all-green SHA once using existing verified stack42/endpoint4 scripts.
- [ ] Verify server/web revisions, health, unchanged Hermes; read-only real Agent previews show collaboration contract and no obsolete checkbox permission. Save compact report with test/CI/deploy evidence; no claim of new live autonomous model lifecycle.
