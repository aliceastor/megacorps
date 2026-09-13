# Readable Agent Context Implementation Plan

> For agentic workers: use subagent-driven-development for bounded independent tasks, with primary integration and independent final review. User authorized formatting, company visibility/CV evidence and conversation-last changes; previous URL discovery finding is included. Work in the user's Z:\AgentsHub\megacorps checkout.

**Goal:** Make actual Task/Direct Chat injection clear, discoverable, concise and evidence-backed without changing workflow authority.
**Architecture:** Reuse real prompt builders and shared formatting helpers. Separate informational company membership from delegation eligibility; preserve real stored scores. Place platform and transport instructions before the final conversation section. Preview and dispatch use the same projections.
**Tech stack:** TypeScript, PostgreSQL/Drizzle, Node tests, Next/Playwright existing suite.

## Constraints
- No Hermes runtime/profile/config/security changes. No live handbook or project/repo mutations. No automatic new Agent/model tasks for verification.
- Preserve unrelated untracked bugs2 report and pending Help/Gitea plan. Existing authorization covers main push and exact-green Portainer stack42/endpoint4 redeploy.
- Existing help catalog is public; inject an explicit runtime-reachable configured API origin, not guessed localhost. Topic Help/Gitea provisioning are separate pending work; do not advertise nonexistent routes.
- No fabricated scores, roster names, permissions or acceptance evidence. Empty/unknown optional metadata may be omitted; actual blockers, required children and unresolved dependencies must remain visible.

## Tasks
- [x] Team/CV context: company-wide compact directory including inactive members and real reporting lines; distinguish eligible delegation recipients and show scope explicitly. Boss sees members beyond Heads without direct-delegation privilege. Show clear open-work counts/capacity and latest 3 stored scores with date/domain/verdict/reviewer/card/score-record pointers. Bound context and disclose omitted records. Include resource context in Task and Chat; retain scope/tenant controls. Tests for Boss+Head+Staff/inactive/foreign-company, multiple people, missing scores and per-person record limits. Own agent-cv, new team context modules, dispatch.teamResourceView and chat.buildDirectChatGoalContext only.
- [x] Chat order/discovery: native reporting prompt and chat carry full configured API/Help URLs with explicit auth boundary. Unknown runtime URL must be declared unavailable, never guess a remote localhost. Actual A2A callback configuration remains unchanged. Put chat-actions and A2A response framing before the conversation; final text is conversation transcript/latest input followed by Respond to the user directly. Avoid splitting on user-controlled marker text. Keep parser/actions behavior intact. Make report examples use supplied eligible recipients or explicit non-action placeholders without ghost assignees. Own adapters/hermes, a2a-final-output, agent-operation-guide/report-guidance and chat.buildChatPrompt plus tests; coordinate interfaces.
- [x] Task context presentation: replace none-filled pipe dump with Markdown task status and populated sections; bootstrap labelled current state, continuation labelled changes since known timestamp. Keep parent/child/dependency/blocker/evidence and recovery instruction semantics. Remove duplicate updated timestamp and confusing coordination wording. Label Boss/company-direct role header company leadership. Own dispatch delta/current-card formatting and company-context role header; no changes to worker-owned ranges.
- [ ] Integrate and verify: review raw attachments as untrusted data; real PostgreSQL prompt preview tests (Task/Chat, roles, scores, no writes/model calls), workspace typecheck/tests, production build and relevant browser preview case. Independent code review. Commit/push coherent changes after green verification; exact-SHA complete CI with Docker, one final redeploy, verify services/Hermes/data and read-only real previews. Save compact evidence report.

## Acceptance
1. Alice can see Ribel/Digby and inactive David in company overview; delegation still permits only actual eligible heads.
2. CTO receives average CV plus recent real score records, no arbitrary truncated GOAL ASSESSMENT posing as a score review.
3. Empty new-task state is short/readable; nonempty failure/review/dependency/approval information survives.
4. Both full and continuation chat prompts, including A2A wrapper, end with conversation/latest user input and response instruction.
5. Supplied prompt marker text cannot reorder or delete platform framing; configured HTTP URLs are absolute and credential-free, unavailable URL is explicit.
6. Generated preview remains the real dispatched prompt projection with synthetic run IDs and redacted credentials, no dispatch side effects.
