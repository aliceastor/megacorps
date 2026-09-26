# Report recovery and focused injection — 2026-09-26

## Changes

- Recover explicit terminal reports using bare JSON, json fences or megacorps-report fences, including CLI diff-only output. Tool-log braces no longer poison terminal parsing. A later malformed/rejected report cannot be replaced by an earlier approval; ambiguous CLI output remains rejected.
- Persist bounded original rejected reports and precise field errors across native, runner and webhook completion paths. All roles receive a correction-only prompt with current authority/acceptance; formatting alone does not request execution or rescoring. Manager recovery retains its allowed action constraints.
- Put bounded company mission, current task/acceptance, dependency blockers, required tools and human constraints ahead of optional context. Replace unrelated company-card history with compact project/goal pointers. Preserve bounded ancestor scope and unresolved review checks. Enforce the context budget and explicitly mark omitted material.
- Compact accepted-review evidence while retaining reviewer/author/head identity, meaningful checks/limitations and authenticated detail links. Block reuse when recorded head differs from accepted head; label author-only evidence distinctly. Existing artifact/assignment/approval/merge receipt gates are unchanged.
- Give Boss goal assessment its own report contract instead of appending professional-QA instructions. Help describes correction behavior, context/auth boundaries and assessment reports.

## Reproduction and measurement

All three audited production failures replay through the real extraction pipeline with exact terminal JSON and no schema corrections: Digby completed report (1120 chars); CTO approved review including its original9/10 score (1465 chars); Alice approved assessment without score (1965 chars). No historical score/task records were rewritten and no model was called.

Controlled full-prompt comparison against60422b3 with identical reconstructed87-card fixtures:

| Prompt | Before characters | After characters | Change |
|---|---:|---:|---:|
| Digby worker | 50691 | 30001 | -40.8% |
| CTO review | 48472 | 25208 | -48.0% |
| Alice assessment | 14392 | 14579 | +1.3% |
| Alice format correction | 14392 | 14010 | -2.7% |

The correction now contains the precise error and original1965-char report, both absent before. Mandatory handbook, configured API origin, current acceptance, dependencies, review identity and blocker probes pass. These are characters, not provider tokens or predicted latency savings. Fixtures use audit snapshots with historical filtering/reconstruction, not a complete point-in-time backup; unavailable external waits/provider findings/required tools/approvals are omitted, and an identical synthetic API origin is used. Saved historical prompt sizes are not used as the controlled baseline.

Accepted-evidence test fixtures shrink5629→2533 characters and13186→7149; packet limit8000. Rich focused-context regression remains under its8000-character budget without dropping the tested acceptance/blocker/dependency/tool/human instruction.

## Verification before release

- Full local server suite before the final helped/mission regressions: 1407 passed, 0 failed; 32 PostgreSQL test-file entries skipped because local TEST_DATABASE_URL is absent. The complete final PostgreSQL CI results are below.
- Web160, Shared23, CLI2 tests pass from their package directories.
- Server TypeScript check and git diff whitespace check pass.
- Focused protocol and full transport-path tests cover original report retention, stale score exclusion, same-session/fresh-context correction and cleared repair state.
- Independent parser/recovery/context review findings addressed with regression tests. The final helped-retry fix preserves bounded manager guidance only for its matching actor/stage; the 61-test focused recovery/context suite and server typecheck pass after this fix.
- Raw-output replay and prompt benchmark scripts/results are ignored local audit artifacts, not committed transcripts or credentials.

The first PostgreSQL CI pass found a missing company mission in focused task previews (1580 Server tests passed, one failed). The mission is restored with bounded output; existing-card and unsaved-draft regressions pass, and the original PostgreSQL assertion remains unchanged. The follow-up typecheck and 26-test focused suite pass. A superseded CI run was cancelled while correcting a test-only strict-null annotation.

## Released and verified

- Code revision: `d16f27d887a5a8a77e9011fbfc3e2c9f33989c48`, pushed to `origin/main` from `Z:\AgentsHub\megacorps`.
- Implementation commits: `231e313` terminal parsing; `91957fe` precise repair persistence; `987ff54` focused injection/accepted evidence; `9234b32` mission retention; `d16f27d` strict fixture typing and final measurements.
- [Full CI run 36247545801](https://github.com/aliceastor/megacorps/actions/runs/36247545801) succeeded for this exact revision: Server 1583, Web 160, CLI 2, Shared 23 tests (1768 total, zero failures/skips); 148 Playwright browser tests; workspace typecheck/build; server and web Docker build/push.
- Portainer stack 42 / endpoint 4 redeployed at 2026-09-26 22:29 HKT. At 22:30 HKT, server and web image revision labels both match the exact code revision. Server, web, PostgreSQL and Gitea are running/healthy; database health is up. The stack redeploy recreated its service containers; PostgreSQL/Gitea image identities are unchanged.
- Compose and environment hashes match the pre-deploy snapshot. Hermes container identity, start time and restart count are unchanged; no Hermes or timeout configuration was edited.
- Production `/api/help` contains the assessment example, precise correction contract, focused-context and authentication guidance.
- Authenticated, read-only task previews for Alice, CTO and Digby preserve supplied acceptance, role context, handbook, configured API origin and redaction. The worker preview contains compact history pointers and the direct-API authentication boundary. Card/chat/task-run ID sets are identical before/after; preview caused no model calls or task creation.
- Production preview lengths (new synthetic task, not the audit benchmark): Alice 21745, CTO 22177, Digby 31413 characters. These do not share the historical benchmark input and are not used to calculate the reported reductions.

This report and plan completion are delivered by a documentation-only follow-up commit; deployed application code remains the CI-verified revision above. Existing unrelated user files remain unstaged.

## Remaining measurement limits

No new paid real-model autonomous project was launched in this repair turn. The three original failures were replayed locally through the real extraction pipeline, and production injection was checked through the actual preview API. A new live task is still needed to measure real elapsed-time/token/cost improvement and whole-project behavior after deployment. Historical task outcomes and CV scores were not rewritten. No claim is made that all 81 minutes of the audited project were avoidable or that character reductions equal latency/cost reductions.
