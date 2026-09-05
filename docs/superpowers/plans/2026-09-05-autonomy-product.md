# Autonomous workflow and product correction implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement and review each task. Track completed work in `.superpowers/sdd/progress.md`; do not stop between tasks.

**Goal:** Complete the user's 15 requested corrections so ordinary company tasks have a simple interface, truthful autonomous lifecycle, usable responsive UI, and accountable costs.

**Architecture:** Keep the existing company, card, task-run, review, and external-wait model. Consolidate report interpretation, evidence gates, injected context, and usage settlement behind explicit modules instead of duplicating rules across transport callbacks. Ship compatible migrations and independently reviewable commits.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle/PostgreSQL, Next.js/React, node:test, Playwright Chromium.

## Global Constraints

- Develop in `Z:\AgentsHub\megacorps` (the same files as `\\10.0.1.1\DataSet\AgentsHub\megacorps`); source changes must remain visible there.
- Start from `85ec23952545934bfe9fe318ea08f10e94392ea5` on `codex/autonomy-product-20260905`. Do not force push, overwrite unrelated work, or switch the user's workspace to another directory.
- Minimum company: one strategy-only Boss and at least one department with a head. When the head has no employee, the head executes. Boss does not perform implementation or professional artifact review.
- Structured failure, permission request, invalid output, failed delegation, missing required evidence, and incomplete required children must not become Done or an approval of nonexistent work.
- Preserve stored advanced fields when their controls are hidden. Preserve legacy reports through explicit normalization. Do not silently strip recognized work products or requests.
- Narrow sidebar retains the approved inline push-down behavior. Test geometry after transitions settle.
- O-Chart uses ascending numeric Rank for vertical placement, department boundaries, and orthogonal boss-bottom to report-top edges with at least 10px visible clearance from unrelated cards, including upward reporting relationships.
- Secrets must not enter committed tests/reports. Use synthetic credential sentinels in regression tests. Do not disable Tirith or mutate Hermes.
- Existing Default Company contains `playground`; protect its records until its specific migration/disposal is reviewable and authorized. Removing implicit default creation must not break first-account registration.
- One bug or cohesive independently reviewable change per commit. Tests must show the failure before the fix. Run covering tests, then full tests/typecheck/build and CI/Docker before deployment.
- Final deployment stays within previously authorized Portainer stack 42 / endpoint 4; preserve compose/env and existing persistent data.
- Final autonomous development/document tasks must finish without operator work-product registration, fake approval, or manual event replay. Record actual limitations when permissions or required resources are unavailable.

## Execution order and coverage

| Task | Deliverable | User items | Principal files |
| --- | --- | --- | --- |
| 1 | A normalized, preserved report envelope and truthful result/review interpretation | 2, 5, 14 | shared/index.ts; agent-report.ts; dispatch.ts; routes.ts; new agent-results.ts |
| 2 | Required evidence gates, existing-merge reconciliation and bounded protocol repair | 2, 14 | merge-gate.ts; external-polling.ts; run-retry.ts; dispatch.ts |
| 3 | Structural Boss/head behavior and common role/knowledge context | 1, 10, 14 | role-playbooks.ts; agent-position-prompt.ts; dispatch.ts; chat.ts; shared/schema and company/department editors |
| 4 | Companyless bootstrap, setup wizard, removal of implicit default, legacy SSH hidden from creation | 7, 11 | db/migrate.ts; routes.ts; runner-routes.ts; companies-page.tsx; settings-page.tsx; org editors |
| 5 | Lazy paginated logs and log-payload suppression | 3, 5 | log-query module; routes.ts; request-log.ts; logs-page.tsx; api-help.ts |
| 6 | Responsive Projects/Goals/Departments, safe draft reset, simple card creation | 4, 8, 9, 13 | project-authority-panel.tsx; departments-page.tsx; kanban forms; globals.css |
| 7 | Conversation-first Direct Chat layout | 4, 12 | chat-page.tsx; globals.css |
| 8 | Rank/department O-Chart, obstacle-aware edges and safe assignment edits | 4, 6 | company-o-chart-page.tsx; new org-layout.ts; globals.css; routes.ts |
| 9 | Consistent actual/estimated/unknown usage ledger and scoped budget enforcement | 15 | new usage-settlement.ts; db/schema.ts; db/migrate.ts; adapters; dispatch/chat/runner; budget/dashboard UI |
| 10 | Executable API contracts, whole-product regression and live lifecycle acceptance | 4, 5, 14 | api-help.ts; shared contracts; integration and browser tests; acceptance report |

Each subsystem receives a concrete task brief before implementation, with file ownership, existing interfaces, test assertions, acceptance and reporting commands. This table remains the coverage ledger; a finished subset does not finish the request.

## Task 1: Normalized report and truthful result interpretation

**Files:** modify `packages/shared/src/index.ts`, `apps/server/src/agent-report.ts`, `apps/server/src/dispatch.ts`, `apps/server/src/routes.ts`, `apps/server/src/api-help.ts`; create `apps/server/src/agent-results.ts` and `apps/server/src/agent-results.test.ts`; extend `agent-report.test.ts` and `dispatch-verdict.test.ts`. Use the existing work-product schema and persistence instead of adding another table.

**Interfaces:** keep `extractAgentReport(output): AgentReportExtraction | null` and all existing report consumers compatible. `null` means no report; `{error}` means a present invalid report and must remain distinguishable. Add one exported pure result normalizer in `agent-results.ts` consumed by dispatch and webhook, with explicit report/prose outcomes. Retain `kind: megacorps-report`; accept legacy status `in_progress` and normalize to `progress`. Add optional `version` (default legacy version), typed `request`, and `workProducts` sharing the existing work-product field rules while deriving company/card/agent/run identity server-side.

- [ ] RED: add a schema/extractor test asserting `in_progress` is accepted as progress and report workProducts/request survive parsing; assert a present malformed final report is an error even after an earlier valid report.

```ts
const parsed = extractAgentReport(JSON.stringify({kind:'megacorps-report', status:'in_progress', summary:'Working', workProducts:[{type:'pull_request', title:'Change', url:'https://github.com/example/repo/pull/1'}]}));
assert.ok(parsed && 'report' in parsed);
assert.equal(parsed.report.status, 'progress');
assert.equal(parsed.report.workProducts?.[0]?.url, 'https://github.com/example/repo/pull/1');
```

- [ ] RED: use actual `dispatchInternals` result/verdict helpers for failed/input_required reports and permission-blocked prose, and final-verdict precedence. Assert none can be Done or treat a permission blocker as product approval. Preserve native A2A needsInput routing.

```ts
assert.equal(dispatchInternals.reviewDecision('Previous run: REJECTED.\nFinal verdict: APPROVED.', 'quality'), 'approved');
assert.notEqual(dispatchInternals.dispatchCompletionDecision('Clone pending approval', null).nextStatus, 'done');
```

- [ ] Run from `apps/server`: `node --test --import tsx src/agent-report.test.ts src/dispatch-verdict.test.ts src/agent-results.test.ts`; preserve the expected failures in the report.
- [ ] GREEN: normalize legacy aliases and typed requests; classify report presence/validity before side effects. Structured report status dominates prose. Permission blocker -> blocked with a concrete reason, help request -> existing help/checkpoint flow, failed/rejected -> failure flow, progress -> continued/waiting work without completion, completed -> existing evidence/review gates. A present invalid report produces correction feedback, never a null success fallback. Task 2 supplies the persistent correction bound.
- [ ] GREEN: accept outputs through both returned content and webhook; normalize report work products using server-derived identities and persist them before completion gates. Do not store supplied foreign card/company/agent identifiers. Preserve existing artifacts and legacy top-level webhook workProducts without inserting duplicates for the same response.
- [ ] GREEN: structured current verdict wins; legacy parsing uses an explicit final verdict line before narrative keywords. Conflicting explicit current verdicts require repair; historical prose must not reject current approval.
- [ ] GREEN: align the short injected report example and API help with accepted states and work products; do not expand prompts with all API endpoints.
- [ ] Add route/dispatch integration tests using the existing memory DB/fake adapter patterns, proving report-only work-product persistence and failed/permission/invalid output cannot pass the actual completion entry point. Keep stale-run state preservation intact.
- [ ] Run covering tests, server/shared tests and typecheck. Inspect `git diff --check`; commit only Task 1 files with a truthful fix subject. Record exact RED/GREEN commands and outputs in `.superpowers/sdd/task-1-report.md`.

## Verification and handoff

Per-task reviews use the exact task brief, report and base..head diff. Resolve Important/Critical findings before the next task. Later briefs define concrete tests against the current interfaces rather than guessing how earlier tasks implemented them. Update `.superpowers/sdd/progress.md` after each accepted review.

After all tasks: full unit/integration suite, shared/server/web typecheck, workspace production build, Chromium responsive/form/workflow tests, broad branch review, CI and Docker success. Then verify the deployed revision and authenticated UI. Run the two autonomous acceptance projects using natural-language goals and keep the operator intervention count at zero for a passing lifecycle.
