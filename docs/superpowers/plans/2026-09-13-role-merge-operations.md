# Role-scoped merge operations implementation plan

**Goal:** Implement explicit manager-authorized managed Gitea merging, discoverable role-labelled Help, and authoritative inherited role flags.

**Architecture:** Keep provider credentials and exact-head merge fences in MegaCorps. A reviewed merge intent waits for an explicit current Boss or owning department Head decision. Reuse queued message-board questions for a bounded management decision, not a second quality review. Direct Chat exposes the same `merge_pr` operation. Documentation describes structural roles separately from inherited capabilities.

**Global constraints:** Boss has company scope; Head has only its own department scope; Staff cannot authorize merge. Independent artifact review is required. Boss remains rank 0 with no physical department and no manager. Busy managers wait. Preserve human approvals, reviewed SHA, repository binding, child acceptance and provider verification. Never modify Hermes or give runtime agents service credentials. Existing in-flight intents reconcile; no migration fabricates manager approval.

## Task 1 — Authority and injected identity
- [x] Add a shared pure authority projection from active Agent and active Position, deriving boss/head/staff capabilities; never infer authority from rank or prompt text.
- [x] Update actual common Task/Chat injection and Position preview to print rank, boss, department_head, staff, active in that order. Boss inherits head/staff, Head inherits staff.
- [x] Tests: active Boss, Head, Staff, inactive/deleted/missing position, company leadership staff. Preserve structural role/department invariants.

## Task 2 — Manager merge decision
- [x] Extend `merge_intents` with a versioned decision-required flag, manager identity/reason/time and durable decision question identity. Migration marks unsent intents as requiring fresh decisions; in-flight provider outcomes reconcile without replay.
- [x] Extend shared chat action schema with strict `{action:'merge_pr', intentId: UUID, headSha: 40 lowercase hex, reason: nonempty}`. Reuse it in one bounded merge decision prompt.
- [x] Implement `requestManagerMerge` with current actor/user/company authorization; same-company intent/card/project; Boss company scope or formal Head matching immutable candidate department; independently accepted reviewed candidate; current exact head; durable idempotent decision.
- [x] The provider claim rechecks decision authority and all existing gates immediately before mutation. Reviewer approval alone cannot send new merges. Legacy direct runtime merge remains forbidden.
- [x] Queue one message-board decision per eligible candidate; choose owning Head then Boss if no eligible Head. Busy never counts as absent. Process only platform-marked merge questions through the merge operation handler, bounded failure escalates with actionable reasons; ordinary peer questions remain informational.
- [x] Direct Chat uses the same service and returns truthful accepted/pending/provider-confirmed states. Expose candidate IDs/head via existing merge-intent reads and pending decision context.
- [x] Tests before code: Staff/foreign Head/cross-company/inactive denied; Boss and own Head allowed; missing review/stale SHA/required human gate denied; duplicate no second merge; reviewer-only no provider call; authority change before claim; queued busy manager; failure recovery.

## Task 3 — Help and operation guide
- [x] Publish discoverable BOSS / DEPARTMENT HEAD / STAFF applicability for every API catalog entry and every Agent operation, distinguishing browser user roles from Agent roles and dedicated runtime credentials.
- [x] Add merge_pr guide with schema, scope, errors, candidate lookup, manager decision vs provider execution, mandatory review and no force merge. All roles can read all Help.
- [x] Inject Help pointer and concise inherited authority/action guidance. Show role metadata in Help UI and Markdown/JSON exports. Do not claim unavailable project creation/chat actions.
- [x] Tests check complete endpoint metadata and role-scoped merge guidance.

## Verification and delivery
- [x] Focused real behavioral tests, PostgreSQL merge fencing/interleavings, workspace typecheck and full required suite; review code against requirements.
- [ ] Commit and push only scoped files on Z; preserve unrelated untracked report/old help plan. Wait for CI including Docker jobs, deploy through authorized Portainer path, verify exact app revisions and read-only prompt/API previews. No live paid Agent tasks without a need for lifecycle verification.
- [ ] Update handbook to match deployed manager decision behavior and report actual verification status.
