# Agent workflow, Direct Chat and organization chart implementation plan

> **For agentic workers:** Use subagent-driven-development for bounded independent UI/transport tasks; the primary implements and integrates prompt/evidence changes. User explicitly requested these fixes and supplied the chart design; execute without another approval round.

**Goal:** Make management decisions use CV/mandatory knowledge and reusable verified acceptance, provide compact discoverable platform operations, fix chat completion display, and show company leadership above departments.

**Architecture:** Keep existing role/gate machinery. Add bounded context and evidence projections at existing prompt boundaries, not another workflow engine. Preserve raw events/messages and render user-facing projections. Separate chat reads from inference submissions for rate limiting. Lay out actual company leadership separately from department lanes.

**Tech Stack:** TypeScript, Fastify/Drizzle/PostgreSQL, React/Next, node:test, Playwright.

## Global constraints

- Work in Z:\AgentsHub\megacorps, preserve unrelated bugs2-report-20260905.md.
- Do not modify Hermes, credentials, runtime policy or security settings.
- Existing authorization covers commit/push main and Portainer stack42/endpoint4 redeploy after all checks including Docker.
- No automatic approval, fabricated verification, cross-company information disclosure, duplicate action replay, or loss of real manager edges.
- Other projects/history remain discoverable as compact pointers; user explicitly does not want them removed.
- Boss role detection uses company/position authority, not the display name CEO or numeric rank alone.

## Task 1 — Chat completion and readable action receipts

Files: apps/web/src/components/chat-page.tsx, apps/web/src/lib/api.ts, new chat display/poll helpers and tests if useful, apps/server/src/rate-limit.ts and rate-limit.test.ts, apps/web/e2e/direct-chat.spec.ts. Coordinate any server chat.ts changes with primary.

- [x] Reproduce: chat GET polls currently share the 40/minute inference bucket; inspect timer/live-event overlap and fetch failures.
- [x] Red tests: read polling cannot exhaust submit bucket; transient 429 honors Retry-After then retrieves completed reply without reload or repost; overlapping polls are bounded; cached transcript remains visible.
- [x] Fix read/submit policies without disabling limits; coalesce polling and automatically recover completion fetch after transient throttling.
- [x] Render recognized chat-action fences as a compact operation receipt rather than raw protocol JSON; keep ordinary code examples intact. Preserve raw message and do not execute on reads. Translate legacy self-note outcome into clear localized text without mid-word truncation.
- [x] Verify accepted POST occurs once, background completion becomes visible, note result appears once, no F5 needed.

## Task 2 — Company Boss above department lanes

Files: apps/web/src/lib/org-layout.ts and test, apps/web/src/components/company-o-chart-page.tsx, chart e2e fixtures/tests and needed styles.

- [x] Red layout tests using company boss position flag: boss with null department appears centered above all lanes; no unassigned lane created solely for boss.
- [x] Preserve true unassigned ordinary members, real manager edges, rank ordering, reversed rank relationships, orthogonal paths with >=10px card clearance, editing behavior and narrow viewport scrolling.
- [x] Connect the company Boss to every real department group, including empty/headless groups. Keep these company hierarchy connectors distinct from actual stored agent reporting edges; do not invent agent manager relationships.
- [x] Test coordinates and real browser chart screenshots against supplied layout.

## Task 3 — Management knowledge and CV injection

Files: apps/server/src/dispatch.ts, company-context.ts, role-playbooks.ts, agent-position-prompt.ts if needed, matching prompt/context tests.

- [x] Red test: staffed department management and Boss assignment include eligible direct reports' CV, workload and declared capabilities, within bounded budget and correct company scope.
- [x] Inject teamResourceView into management branch currently returning before buildTaskPromptCore.
- [x] Treat handbook/policy company docs as mandatory company reference alongside general docs; retain tag scoping for specialized docs, deterministic selection and explicit truncation/omission limits.
- [x] Resolve observed legacy CTO merge-after-PASS instructions at authoritative prompt projection without changing Hermes. Keep original saved custom prompt, project policy authority and other useful role instructions. Use conditional sole-head guidance.

## Task 4 — Compact discovery and accurate Agent API guide

Files: apps/server/src/chat.ts, dispatch.ts, agent-report-guidance.ts or new agent-operation-guide.ts, api-help.ts and route contract tests.

- [x] Audit registered routes vs API Help method/path catalog; document exact coverage and fix missing entries. Verify examples against shared schema where applicable.
- [x] Inject a bounded role/surface guide: native report states, help/escalation, children, review verdict/score, chat actions, read pointers, endpoint authentication. Full help /api/help and Markdown variants remain available; never suggest browser-session routes are usable with arbitrary agent tokens.
- [x] Company-level Direct Chat gets current company project index (including projects with no cards) and compact card pointers. Distinguish selected execution project from company visibility; no-project is not proof that other projects do not exist.
- [x] Replace detailed unrelated project goals/cards/history with concise pointers, keeping current task/upstream/evidence details needed for correctness.
- [x] Red tests for ONLINE CHESS visibility in general chat, cross-company exclusion, role-appropriate valid guide examples, and bounded unrelated context.

## Task 5 — Reuse valid acceptance evidence

Files: apps/server/src/dispatch.ts, delivery-acceptance.ts, new evidence projection helper if appropriate, matching PostgreSQL/dispatch tests.

- [x] Supply structured current reviewer checks, reviewer/author provenance, accepted revision and merge status to management rather than relying on searching runtime histories.
- [x] Before an eligible Boss reviews the single required child, include the complete parent goal and a server-bound scope/evidence token. Reuse only an explicit approved parentAssessment matching that token and accepted review output, after current child acceptance, author identity, product versions and all gates are rechecked transactionally. Child and parent scopes may differ because the Boss explicitly assesses both; missing approval, multiple children or changed coverage retain normal assessment.
- [x] Keep all existing review/merge/permission/client gates and atomic task completion ordering. Explicitly invalidate reuse on changed head/scope/child evidence, rejection, missing receipt or outstanding gates.
- [x] Tests: matching explicit combined assessment avoids another model assessment; changed/missing evidence falls back to normal review; no double scores, no fake output or self-review.

## Task 6 — Readable Kanban report messages

- [x] Project recognized final Agent reports into conversational summary plus separate status, review result, score and artifact links.
- [x] Keep CLI warnings, tool diffs and duplicate protocol JSON in an expandable original record; preserve database output and workflow parsing.
- [x] Ordinary messages, quoted examples and malformed reports must remain readable without silently claiming an accepted result.
- [x] Test the supplied warning + file diff + duplicate report case and rendering of real artifact links.

## Release and verification

- [ ] Focused red/green tests per task, review integrated diff and resolve important findings.
- [ ] Workspace tests/typecheck and impacted browser tests; CI database suites and all Docker jobs green for exact pushed SHA.
- [ ] Redeploy authorized stack preserving compose/env/mounts and Hermes; verify image SHA and service health.
- [ ] Verify company project pointers/current handbook/CV in generated prompts without invoking a model unnecessarily; validate chat completion recovery using deterministic e2e fixtures and saved messages.
- [ ] Produce a report stating verified behavior and any remaining limits; do not describe untouched historical runs as newly passing.
