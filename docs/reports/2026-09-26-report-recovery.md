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

- Final local server suite:1407 passed,0 failed;32 PostgreSQL test-file entries skipped because local TEST_DATABASE_URL is absent.
- Web160, Shared23, CLI2 tests pass from their package directories.
- Server TypeScript check and git diff whitespace check pass.
- Focused protocol and full transport-path tests cover original report retention, stale score exclusion, same-session/fresh-context correction and cleared repair state.
- Independent parser/recovery/context review findings addressed with regression tests. The final helped-retry fix preserves bounded manager guidance only for its matching actor/stage; the 61-test focused recovery/context suite and server typecheck pass after this fix.
- Raw-output replay and prompt benchmark scripts/results are ignored local audit artifacts, not committed transcripts or credentials.

The first PostgreSQL CI pass found a missing company mission in focused task previews (1580 Server tests passed, one failed). The mission is restored with bounded output; existing-card and unsaved-draft regressions pass, and the original PostgreSQL assertion remains unchanged. The follow-up typecheck and 26-test focused suite pass. A superseded CI run was cancelled while correcting a test-only strict-null annotation.

## Release status

Commits/push, full CI (PostgreSQL/browser/build/Docker), Portainer redeploy and production prompt/Help verification are pending at this report's initial creation. No new paid real-model autonomous project is part of these replay checks. Hermes and timeout settings remain unchanged.