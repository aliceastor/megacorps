# Position-driven organization and compact O-Chart implementation plan

> For agentic workers: use subagent-driven-development for bounded independent tasks, then integrated verification. User explicitly requested this refactor and its role/rank rules.

## Goal and architecture

Position ownership determines an assigned Agent's department. An explicit department-head position flag determines department leadership. Company Boss is outside departments and has no superior. Store/enforce the same rules on the server and show locked derived fields in all relevant editors. O-Chart uses actual reporting edges with short unobstructed orthogonal routing.

## Constraints and decisions

- Work in Z:\AgentsHub\megacorps. Preserve unrelated bugs2-report-20260905.md and pending Help/Gitea/Boss Merge plan.
- No Hermes, credential or security-policy modifications. Existing permission to commit/push main and redeploy verified Portainer stack42/endpoint4 remains.
- Rank integers 0..9 only: Company Boss=0, Department Head=1, Staff=2..9. Rank is not the sole role identity.
- Add explicit isDepartmentHead position flag. One head position per department (including inactive positions, to avoid hidden duplicate definitions). Head position must belong to a department in the same company; it cannot also be Boss.
- Boss position has no department or manager position. Boss Agent has departmentId=null and bossId=null. One current company Boss Agent.
- Occupant of head position reports to current company Boss; department.headAgentId is derived from the current head-position occupant. At most one active nondeleted occupant per head position. A vacant head position is valid and displayed as vacant; no fake Agent is assigned.
- Staff positions belong to one department. Choosing a position locks Agent department to it; mismatching API writes are rejected or normalized by an explicit consistent contract. No manually dragging/assigning a member into an unrelated department.
- Preserve valid existing Staff reporting relationships (e.g. Digby→Ribel), including unusual rank order; the request locks department assignment, not an unsolicited replacement of every Staff boss from legacy managerPositionId.
- Unpositioned draft Agents may remain visibly unconfigured; they cannot impersonate a Boss/Head. No invented head based on names/rank.
- Migrate existing positions based on recorded Boss flag and department.headAgentId, not names. Infer missing position department only when all current assigned Agents agree; ambiguous cross-department/shared head assignments require an explicit diagnostic rather than silent data loss.
- Preserve valid existing staff ranks 2..9. For legacy ranks outside range, map ordered distinct Staff levels to remaining 2..9 levels while preserving order/ties where possible; report collisions if more than eight Staff levels. Document exact mapping in migration evidence.
- Known production: Alice CEO Boss rank0/no department/no boss; CTO head of Engineering rank10; Ribel Senior Engineer rank100, position department missing but Agent Engineering; Digby Internship rank500 reports to Ribel; inactive David CMO rank10 in Product, NOT a recorded department head. Operations/Product head currently vacant.
- Position editor moves under Departments via tabs and a company-leadership view for Boss. Legacy /positions redirects into the new section. Boss remains accessible without pretending it belongs to a department.
- O-Chart normal unobstructed links route directly/locally. Use external detours only to avoid actual nodes or reversed/cyclic/cross-department obstacles. No curves, at least 10px clearance from unrelated Agent boxes, and source bottom→target top. Keep all real relationships visible.

## Task 1 — Server organization authority

- [x] Add shared schema/DB flag and rank constraints; implement authority resolution and transactional validation at position, Agent, department writes and applicable runner/admin/manifest paths.
- [x] Migrate existing data with explicit consistency checks; maintain derived head and Boss reporting on assign/change/deactivate/delete. Reject duplicate head positions and occupied-head conflicts, cross-company links and incompatible flags.
- [x] Update API Help definitions/templates/defaults and affected server fixtures; expose stable structured errors for clients.
- [x] TDD for roles/ranks, membership lock, head uniqueness (including concurrent PostgreSQL writes), vacant head/Boss handling, migration data preservation and valid Staff reporting retention.

## Task 2 — Editor/navigation integration

- [x] Move Position editor into Departments tabs with company leadership access and scoped department position list; redirect legacy route and remove separate sidebar entry.
- [x] Add Department Head control, fixed role ranks, Staff 2..9 input, locked department/reporting fields and helpful vacant-leadership state.
- [x] Make Agent and department member editors assign positions rather than overriding derived departments. Keep allowed Staff manager editing and clear validation feedback.
- [x] Tests/browser fixtures for Boss no-department, head uniqueness/selection, position-controlled membership, navigation and mobile layout. Coordinate shared translations only within owned changes.

## Task 3 — O-Chart routing

- [x] Reproduce screenshot with an aligned Boss/CTO/Ribel/Digby chain and multiple department boxes.
- [x] Use short direct/local routes where clear; preserve existing obstacle clearance/upward/cycle behavior and department connections.
- [x] Unit geometry tests prove ordinary aligned edges avoid global gutters, orthogonality/clearance and distinct actual reporting lines.
- [x] Adapt chart labels/types/fixture ranks to role model while keeping unconfigured legacy nodes visible. Browser verify actual diagram.

## Task 4 — Integrate and release

- [x] Independent code review of authority, migration, UI and routing; resolve important findings.
- [ ] Workspace tests/typecheck/build, true PostgreSQL migration/constraint tests, relevant browser suite and exact-SHA Docker CI.
- [ ] Commit/push main only reviewed work; capture preflight, redeploy once after green and verify images/health/Hermes unchanged.
- [ ] Verify live migrated organization and UI against user's screenshot, produce report with actual mappings and any limits. Help/Gitea/Boss Merge features remain separate pending work, not falsely claimed complete by this refactor.
