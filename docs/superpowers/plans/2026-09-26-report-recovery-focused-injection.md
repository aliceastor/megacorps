# APK report recovery and focused injection implementation plan

> Execute the approved audit recommendations in the existing Z:\AgentsHub\megacorps checkout. The user explicitly requested this checkout and authorized implementation. Use independent file ownership and test-first fixes.

**Goal:** Accept valid terminal reports without exposing CLI transcripts, repair only malformed reporting, preserve verified acceptance, and substantially shrink irrelevant prompt context.

**Architecture:** Keep existing report/schema and review gates. Add explicit terminal-boundary recognition and role-independent correction context. Build a focused card context with related evidence and authenticated API pointers. Reuse accepted review receipts only for the same artifact identity; never manufacture approval or bypass independent review/merge gates.

**Constraints:** No Hermes edits, no timeout increase, no new model calls for replay checks; do not modify historical task results/CV. Keep existing user files. No new dependency. Work in Z as requested. Preserve latest-rejection and malformed-terminal precedence over earlier approved reports.

## Task 1 — Terminal report boundaries
Files: apps/server/src/a2a-final-output.ts, agent-report.ts and their tests; a small shared terminal-candidate helper if needed.
- [x] RED: synthetic/minimized fixtures reproducing instructed megacorps-report fence rejection and Python diff brace poisoning; validate schema through the real extraction pipeline.
- [x] GREEN: recognize only explicit terminal report boundaries (bare/json/megacorps-report); tolerate preceding tool diff without selecting historical examples. Keep ambiguous trailing text and final malformed report errors.
- [x] Regression: old approved report plus later reject/truncated report; duplicate output; arbitrary prose; chat envelope/known footer; large transcript bound.
- [x] Replay all three saved actual production failures locally; assert original valid terminal verdict/evidence recovered without model invocation.

## Task 2 — Precise correction prompt
Files: protocol-repair.ts, protocol-repair.test.ts; root integrates helper into dispatch.ts after helper tests pass.
Interface: export protocolRepairPrompt(card, kind, actorId): string. Card shape includes existing protocolRepairState/lastError; extend persisted repair with bounded prior report text if needed.
- [x] RED: Boss/head/staff, fresh/continued review and dispatch all receive same precise field error and preserve-evidence instructions; unrelated/cleared repair state produces no correction prompt.
- [x] GREEN: carry relevant rejected terminal report and correction reason through repair; do not resend full CLI log. State only correct the report, preserve status/verdict/score/PR/head, no redo/rescore merely for formatting, genuinely missing evidence still requires work/help.
- [x] Integrate at role-independent task/review boundary, before current assignment; eliminate role-specific QA contradictions for Boss assessment.

## Task 3 — Focused context and evidence reuse
Files: dispatch.ts (root ownership), new focused-kanban-context.ts/tests if useful, reviewer-evidence.ts/tests (independent agent), relevant prompt tests/help docs.
- [x] RED: with 100 unrelated historical cards, execution/review prompt includes current card, ancestors, children and explicit dependencies; excludes unrelated bodies/history. Current project identity, relevant blockers and role authority stay present.
- [x] GREEN: bounded related-card summary plus authenticated pointers for full cards, review evidence and company/project discovery. Cross-project awareness stays as compact counts/pointers, not task instructions. Explicit user-selected full context remains possible only where needed.
- [x] Accepted evidence summaries retain reviewer/verdict/score/exact artifact revision/checks/limitations and pointer; same-head accepted review is reusable for manager goal assessment, changed head or unaccepted review is not an approval.
- [x] Verify available pointer endpoints and help describe auth and same-company scope. No secrets embedded in committed tests.
- [x] Measure complete generated worker/reviewer/Boss prompts on representative company data; record before/after character counts and ensure critical instructions remain.

## Task 4 — Integration and release verification
- [x] Focused real parser, prompt, repair, evidence and acceptance tests; server typecheck.
- [x] Independent review of parser safety and prompt omissions; fix material findings.
- [ ] Full workspace tests/typecheck/build with existing local test harness and required CI incl PostgreSQL/browser/Docker.
- [ ] Commit coherent fixes; push following existing authorized delivery workflow. Redeploy verified image using existing Portainer scripts, inspect health and prompt previews; do not claim a fresh live lifecycle run unless actually performed.
- [ ] Write release report with exact commit, checks, raw-output replay results, prompt sizes and limits.

Run local targeted tests after loading .superpowers/sdd/environment.ps1:
`node --test --import tsx apps/server/src/a2a-final-output.test.ts apps/server/src/agent-report.test.ts apps/server/src/protocol-repair.test.ts apps/server/src/reviewer-evidence.test.ts`
Use existing TEST_DATABASE_URL setup for Postgres integration, never production DB.