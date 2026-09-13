# Cross-department delegation — implementation addendum, 2026-09-13

> SUPERSEDED — user stopped this proposal and replaced it with Cross-department collaboration requests. Do not implement the direct cross-department permission expansion below. See `../specs/2026-09-13-cross-department-collaboration-design.md`.

User steering: Boss must implicitly have cross-department delegation. Other positions that enable it may assign original subordinates plus other departments' Heads.

Use subagent-driven-development for two independent bounded tasks; primary owns prompt/help integration and release.

## Rules
- Boss effective permission always on; normal Boss recipients remain same-company department Heads.
- Non-Boss flag adds only same-company other-department Heads to existing targets; no other department employees, self, Boss or foreign company.
- Delegation availability still applies active/runtime/busy checks. Structural reporting lines and review/merge authority stay unchanged.
- Mandatory delegation and sole-Head self-check are based on owned subordinate execution capacity, not optional cross-department recipients. Cross-department permission must not force a sole Head to become coordination-only.
- Apply common target policy to independent child reports and same-card delegation. Keep existing duplicate/cycle/fanout gates and reject invalid recipients.

## Work
1. Routing worker: company-workflow structural targets, required-delegation vs optional target separation, all usages of target length that determine sole-Head semantics, relevant tests for Boss flag false, Head/Staff flag off/on, foreign/peer employees, inactive/busy/runtime, and real delegation paths.
2. Position worker: UI Boss checkbox fixed on with concise explanation; other positions optional. API create/update normalizes Boss flag on and existing Boss API representation effective true. Test persistence/partial updates and UI. No migration or live-data edits.
3. Primary: align delegation terminology in actual prompts and API Help; review cycles and child parent-role assumptions, integrate tests, independent review, latest-SHA CI and single Portainer deployment. Keep prior readable context release4032f55 and include changes in a following commit.

No Hermes configuration/security changes. No new live Agent tasks for verification.
