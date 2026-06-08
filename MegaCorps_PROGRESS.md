# MegaCorps Progress and Research Notes

Last updated: 2026-06-08

## Executive Summary

MegaCorps is now a working control-plane MVP for AI-agent companies. The product direction is intentionally close to Paperclip: manage companies, goals, org charts, departments, tickets/tasks, heartbeats, budgets, logs, and governance instead of manually babysitting individual agent sessions.

The current local stack runs with Docker:

- Web UI: `http://localhost:3000`
- API: `http://localhost:4000`
- Database: PostgreSQL in Docker

Latest verified baseline:

- Phase 1-19 operational MVP flows are implemented.
- Company registry page, company memberships, company-scoped RBAC, department setup, real top-down O-chart tree canvas, company-scoped runtime presets, runtime health summaries, adapter endpoint configuration, project-scoped direct agent chat, per-task agent/user message boards, bounded Kanban context injection, task intervention/escalation, lifecycle logs, knowledge docs, company/department/project goal context, repo-centric project workspace policy with project-level repo URL and work path, work products, React Query browser cache, WebSocket live events, execution locks, stale-lock retry/block recovery, DB-backed task-run queue, idempotent task-complete webhooks, Codex app-server adapter sessions, heartbeat runs, cron run history, budget policies, monthly budget reset, approvals, and automatic dispatch heartbeat are implemented.
- Deployment is user-managed. Local-only Docker was used for QA in this pass; NAS/server deployment remains user-managed.
- Browser/plugin QA previously verified signup/login, readable validation errors, Dashboard, Companies, Agents, Kanban, Direct Chat, Logs, Settings, task drawer, task message board comments, mobile narrow layout, and dark-mode agent card text. Current UI IA route smoke also covers Departments, Projects, Workspace, Cron, Admin, and Settings.
- Kanban now uses one incoming-work stage, `todo`; legacy `backlog` input is normalized to `todo`.
- June 2026 UI IA refactor is implemented: fixed independent sidebar, refined single-purpose navigation (`Companies`, `Departments`, `Agents`, `Projects`, `Workspace`, `Knowledge`, `Kanban`, `Direct Chat`, `Cron`, `Logs`), pure company CRUD plus context goals, dedicated department/org lanes, guided agent creation, tabbed Admin/Settings, Project CRUD split from Workspace, Workspace folder manager paths, Kanban company/sort filters, Ticket Thread timeline, Direct Chat optimistic dedupe, and longer Agent TEST timeout.
- API discovery is available at `GET /api/help`, `GET /api/help?format=markdown`, and the Web UI Help page, with response schema examples and rate-limit notes for every endpoint.
- Sidebar navigation now keeps Help and Settings in the bottom utility area, with the collapse toggle inside the sidebar.
- Hermes SSH adapter is implemented for direct `ssh -> hermes -z "{prompt}" --profile {profile}` dispatch against the configured Hermes host, with `/proc/1/environ` imported before Hermes so container-level provider keys are visible in SSH sessions. No production SSH host is hardcoded.
- Codex app-server adapter is implemented for stdio `codex app-server` and authenticated WebSocket endpoints. MegaCorps injects agent `soul`, starts/resumes Codex threads, runs one turn per chat/card attempt, streams agent message deltas, and stores adapter thread/turn ids in `adapter_sessions` / `task_runs`.
- Browser API fallback now tries the current browser hostname on port `4000` before falling back to baked `NEXT_PUBLIC_API_URL`, which avoids NAS deployments accidentally calling unreachable `localhost` or stale IPs.
- In-app rate limiting is enabled by default, and API Help now includes required roles for endpoints.
- Company-owned read APIs now scope results to the current user's company memberships.
- Company-owned mutation/manual execution APIs now require company operator/admin membership checks.
- Production auth onboarding now uses DB-backed `auth.signup_enabled` and `auth.jwt_secret`; signup defaults to enabled, signup becomes admin when no active admin exists, `POST /api/auth/bootstrap` can recover an admin when `BOOTSTRAP_TOKEN` is configured and no active admin exists, and the Admin page manages all accounts.
- Docker CI is configured in `.github/workflows/docker-build.yml` for server and web images.
- Round 3/4 Kanban reliability fixes are implemented: expired execution locks write `lock_expired/warning`, self-review is skipped unless a distinct reviewer/manager exists, task-complete webhooks dedupe by `taskRunId`, progress webhooks no longer release locks, `POST /api/cards/:id/cancel` preserves task history while cancelling active work, and `needs_review` separates help/escalation review from ordinary quality review.
- Round 5 adapter expansion is implemented: `codex-app` agents use MegaCorps `soul` identity, runtime-owned local roots/cwd/sandbox settings, and task-scoped Codex app-server threads instead of project-global sessions.

## Paperclip Research Summary

Reference: `paperclipai/paperclip`

Paperclip positions itself as the control plane for teams of AI agents. The key product idea is: if OpenClaw or Claude Code is an employee, Paperclip is the company. It is a Node.js server and React UI that orchestrates agents, goals, org charts, budgets, governance, work tracking, and cost monitoring from one dashboard.

Important Paperclip concepts to mirror in MegaCorps:

- Bring your own agent: any runtime or provider can be hired if it can receive a heartbeat.
- Goal alignment: every task should trace back to company/project/goal context so agents understand why they are working.
- Heartbeats: agents wake on a schedule, inspect work, and act.
- Multi-company: one deployment can run many companies with isolated data.
- Org chart: agents have roles, titles, reporting lines, managers, permissions, and budgets.
- Ticket system: work is tracked as tickets/issues with comments, logs, decisions, dependencies, and audit trails.
- Governance: humans can approve, pause, override, terminate, or reject work.
- Budget control: monthly and per-task budgets should stop runaway agent loops.
- Atomic execution: tasks need locks/checkouts so two agents do not do the same work.
- Persistent agent state: sessions and context should survive heartbeat cycles.
- Runtime skill injection: agents should receive company/project/task context and relevant workflow instructions.
- Company portability: import/export complete organizations with secrets scrubbed.
- Projects/Workspace: agents should receive the correct project repo/work path, while non-coding project files should live under the company Workspace authority path.
- Events/activity: every mutation, heartbeat, cost event, approval, comment, and work product should be durable and auditable.
- Plugins/adapters: external agents and custom capabilities should attach without forking the core.

## External Kanban Reference Review

References reviewed:

- Hermes Agent Kanban: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban.md
- Hermes Agent Chinese Kanban guide: https://hermesagent.org.cn/zh-Hant/docs/user-guide/features/kanban
- Paperclip README: https://github.com/paperclipai/paperclip/blob/master/README.md
- Paperclip product notes: https://github.com/paperclipai/paperclip/blob/master/doc/PRODUCT.md
- Paperclip org-structure guide: https://paperclip.inc/docs/guides/board-operator/org-structure

### Hermes Kanban Lessons

Hermes Kanban is closer to a durable worker board than a company-control-plane product. The useful design lessons for MegaCorps are:

- Durable task rows: every task must survive process restarts and agent crashes.
- Durable handoffs: every handoff/comment/block/unblock should be a row that humans and agents can read later.
- Worker identity: each worker is an independent process/profile with its own runtime identity, not an invisible in-process sub-agent.
- Dual surfaces: agents should use a dedicated task API/tool contract, while humans can use UI, CLI, or API.
- Claim/heartbeat/reclaim: work should be claimed atomically, heartbeated while running, and reclaimed or blocked when stale.
- Run attempts: a task is the logical work item; each execution attempt should be recorded separately with outcome, duration, stdout/stderr, error, cost, and session id.
- Dependency promotion: child or prerequisite tasks can unlock later tasks when dependencies are done.
- Task-scoped skills/context: a task should be able to request extra skills or context without permanently changing the worker profile.
- Goal-mode/reviewer loop: long-running work needs explicit acceptance criteria and a judge/reviewer loop instead of assuming a single run is enough.

MegaCorps already implements part of this: task UUIDs, one canonical stage, comments, logs, stage history, heartbeat runs, execution locks, stale-lock recovery, sub-tasks, bounded context injection, DB-backed task-run queue rows, and background task-run worker processing. The missing Hermes-style pieces are dependency graph promotion, external runtime health probes, streaming run progress, and a separate replica-safe worker sidecar for heavy production use.

### Paperclip Lessons

Paperclip is closer to the product MegaCorps should become. It is a company control plane rather than a local worker board. The most important lessons are:

- Company is the unit of organization; every agent, task, goal, runtime, budget, secret, and audit event should be company-scoped.
- Org chart is operational, not decorative: managers delegate down, reviewers escalate up, and every agent should know its chain of command.
- Every task should trace to a project/goal/company mission so agents know the business reason behind the work.
- Execution must be atomic: task checkout and budget enforcement should prevent duplicate work and runaway spend.
- Governance is part of the default loop: approvals, budget hard stops, pause/resume/fire, and audit logs are not optional production features.
- Work products should be first-class: files, reports, links, screenshots, PRs, previews, and artifacts should attach to the task that produced them.
- Company templates/import/export matter once the system can run more than one organization.

MegaCorps already mirrors Paperclip in the high-level model: companies, departments, company memberships, company-scoped RBAC, O-chart, agents, goals, Kanban, budgets, approvals, logs, direct chat, runtime presets, task-run queue attempts, repo-centric project workspace policy with project work paths, work products, React Query/WebSocket live updates, and Help/API discovery. The remaining Paperclip-style work is secret references, company template import/export, plugin architecture, richer dependency/blocker modeling, and durable worker execution outside the API process.

### MegaCorps Direction After This Review

MegaCorps should be the source of truth above Hermes, not a thin UI over Hermes Kanban. Hermes can remain a powerful runtime/worker engine, but MegaCorps should own:

- company and department structure,
- O-chart and reporting lines,
- task UUID/stage/history/comments,
- dispatch policy and budget policy,
- run attempt records,
- audit log and API lifecycle log,
- context packing and chain-of-command injection,
- approvals, escalation, and human intervention,
- work products and company export.

Recommended next phases:

1. Phase 16: Dependency/blocker graph with ready-state derivation and reclaim policy.
2. Phase 17: Chain-of-command delegation context and manager review/escalation loop.
3. Phase 18: Repo-centric project workspace policy and first-class work products. Completed.
4. Phase 20: Secret references plus company template import/export.
5. Phase 21: Worker sidecar, distributed queue locks, and deeper runtime liveness/recovery.

## Current MegaCorps Implementation

### Authentication and UI Shell

Implemented:

- Signup/login/logout.
- Authenticated app shell.
- Dark/light theme.
- Language foundation.
- Better validation error handling.
- API unreachable handling for frontend `fetch` failures.
- Signup creates a global admin and default-company admin membership when no active admin exists; later self-signups become viewer accounts with default-company viewer membership.

Notes:

- Server validation errors now return `validation_failed` plus structured issues.
- Frontend converts Zod-style errors into readable messages such as `password must be at least 8 characters.`

### Company Memberships and RBAC

Implemented:

- `company_memberships` table with `companyId`, `userId`, `role`, and `status`.
- Existing users are backfilled into existing companies during migration so upgraded deployments do not lose visibility.
- Company list, agents, cards, departments, projects, goals, knowledge docs, activity, heartbeat runs, task runs, approvals, costs, budget policies, chat sessions, and runtime presets are scoped to the current user's visible company memberships.
- Company-owned mutations require company `operator` or `admin`.
- Membership management requires company `admin`.
- Runtime presets now carry `companyId`, and agents can only use runtime presets in their own company.
- Settings page includes company member management by user email with viewer/operator/admin roles.
- API Help now describes company membership roles and queue responses.

Known remaining RBAC work:

- Invite links are implemented through Admin and `POST /api/auth/invites` / `POST /api/auth/accept-invite`; remaining RBAC work is service-agent keys and more granular company permission policies.
- Service-agent API keys are not implemented yet.
- System-level API lifecycle logs remain authenticated system data, not fully company-filtered audit slices.

### Kanban and Task Model

Implemented:

- Every task/card has a UUID.
- A card has exactly one stage:
  - `todo`
  - `in_progress`
  - `in_review`
  - `needs_review`
  - `done`
  - `blocked`
  - `cancelled`
- Legacy `backlog` API input is accepted as an alias and normalized to `todo`.
- Kanban columns match the stage list.
- Card detail panel includes:
  - UUID
  - stage
  - full detail/body
  - assignee
  - reviewer
  - retries
  - cost/session metadata
  - task logs
  - API lifecycle logs
  - sub-tasks
  - comments
- Kanban cards expose `data-card-id`, open from click or keyboard, and wrap into responsive columns so tasks are not clipped in desktop or mobile narrow viewports.
- The task detail drawer is wider on desktop and becomes full-screen on narrow mobile viewports.
- Manual actions:
  - Save task
  - Run now
  - Review
  - Split into sub-tasks
  - Pause with comment
  - Escalate to reviewer
  - Cancel task
  - Delete task

`Split into Sub-tasks` means:

- Use lines in the task body as sub-task titles when possible.
- Otherwise generate Plan / Execute / Review sub-tasks.
- Child tasks are shown on the Kanban and linked through `parentCardId`.

### Task Message Boards and Intervention

Implemented `card_comments` with these actions:

- `comment`: record context only.
- `agent_note`: record a message authored by a specific agent.
- `pause_agent`: pause the assigned agent, mark the task blocked, write logs.
- `escalate_to_reviewer`: move the task to `needs_review` and queue help review when an independent reviewer/manager exists; otherwise block the task.
- `send_to_agent`: store instruction and queue it for agent context.
- `continue_run`: reactivate the assignee and move task back to `todo`.

Implemented message board behavior:

- Each Kanban task has its own message board.
- Users can post normal comments or intervention instructions.
- Users can post an agent-authored note by selecting an agent as the author.
- Agent dispatch output is automatically added as an `agent_update` board message.
- Reviewer output is automatically added as `review_note` or `review_rejected`.
- Help-review output can be added as `review_guidance`, `review_escalated`, or `review_blocked`.
- Dispatch/review failures are automatically added as agent error messages.
- Webhook completions are also added as agent/system board messages.

Agent dispatch prompts now include latest task message board entries, so user and agent discussion can reach the agent on the next run.

### Bounded Kanban Context Injection

Implemented:

- Every task dispatch invocation includes a bounded Kanban context snapshot.
- Every review invocation includes the same bounded context plus execution output.
- Every direct chat invocation includes same-company Kanban context, focus-agent work context, and the selected project/no-project goal context.
- The snapshot contains:
  - company mission/settings
  - company, department, and project goals
  - compact same-company Kanban board state
  - stage counts
  - focus task full detail
  - parent/child/dependency links
  - focus agent assigned work and review queue
  - latest task message board entries
  - latest task lifecycle logs
  - recent company activity
  - recent heartbeat runs
- Context length is controlled with:
  - `DISPATCH_CONTEXT_CHAR_BUDGET`
  - `DISPATCH_CONTEXT_CARD_LIMIT`
  - `DISPATCH_CONTEXT_RECORD_LIMIT`
  - `DISPATCH_TASK_BODY_CHAR_LIMIT`
  - `DISPATCH_KNOWLEDGE_DOC_CHAR_LIMIT`
  - `MESSAGE_BOARD_COMMENT_LIMIT`
- Truncated sections are explicitly marked in the prompt.

### Task Runs and Async Queue

Implemented:

- `task_runs` table records queued/running/success/failed/cancelled task-run attempts.
- Manual `Run Now` and `Review` enqueue `task_runs` and return `202` with the task-run row.
- Cron heartbeat scans eligible `todo`, `in_review`, and `needs_review` cards and enqueues dispatch/review task runs instead of executing Hermes work directly inside the heartbeat scan.
- In-process task-run worker claims queued rows, marks them running, calls `dispatchCard` or `reviewCard`, links the resulting `heartbeat_runs` row, and records outcome, error, output, cost, and duration.
- Existing `heartbeat_runs` remains the adapter execution record; `task_runs` is the queue/job attempt record.
- Logs page shows task runs separately from heartbeat runs.
- Worker tuning env vars:
  - `TASK_RUN_WORKER_ENABLED`
  - `TASK_RUN_WORKER_INTERVAL_MS`
  - `TASK_RUN_WORKER_BATCH_SIZE`
  - `TASK_RUN_WORKER_ID`

Known remaining queue work:

- The worker currently runs in the API server process.
- Production should move it into a dedicated sidecar/worker process with replica-safe claiming and progress streaming.

### Agents, Company, Department, and O-chart

Implemented:

- Agent CRUD.
- Agent pause/resume/fire/reset-session.
- Dedicated `Companies` sidebar page.
- Company registry and company setup UI.
- Company fields:
  - name
  - slug
  - mission
  - `autoDispatchEnabled`
  - `dispatchIntervalSeconds`
- Department creation.
- Agent can belong to a department.
- Agent can report to another agent through `bossId`.
- Departments/Agents pages group the O-chart by department and render org lanes/tree nodes for reporting lines. Companies is now focused on company CRUD and company goals.
- Member identity labels are free text; hierarchy is controlled by `bossId` and direct reports.
- Clicking a member opens editing for identity label, department, reports-to relation, runtime, adapter, and budget.
- Agent runtime presets are managed in `Settings -> Agent runtimes`.
- Each agent can select a runtime preset in `Agents`.
- Each agent can override adapter-specific fields without changing the shared runtime preset.

Current O-chart meaning:

- `companyId`: company ownership boundary.
- `departmentId`: functional grouping.
- `bossId`: manager/reporting relationship and review path.
- `role/title`: free-text identity/function label only; it does not define the hierarchy.

Hierarchy lifecycle:

- Top-level members can hold broad tasks.
- `Split into Sub-tasks` delegates child tasks to direct reports when they exist.
- Child tasks review back to the parent member by default.
- Subordinate work moves upward through `in_review`, approval records, and parent-card cascade.
- Work the assignee cannot solve moves upward through `needs_review`; if no independent reviewer/manager exists, the task becomes `blocked`.
- Parent tasks close when all child tasks are completed, preserving a top-down delegation and bottom-up reporting loop.

### Direct Agent Chat

Implemented:

- Sidebar `Direct Chat` page.
- Company selector showing all agents in the selected company.
- Project selector for all projects, no-project/general chat, or a specific project.
- Agent selector with status, identity label, and adapter type.
- Per-agent, per-project session list.
- New session creation.
- Session-scoped direct messaging.
- WhatsApp/Teams-style web layout:
  - company/agent rail
  - session rail
  - conversation thread
  - bottom composer
- Responsive narrow viewport layout that stacks rails and conversation vertically.
- Backend tables:
  - `chat_sessions`
  - `chat_messages`
- Chat lifecycle logging:
  - user message
  - agent reply
  - system failure message
  - `heartbeat_runs` source `chat`
  - `activity_log` actions
  - `cost_events`
- Each chat session stores its own `agentSessionId` and optional `projectId`, so the same agent can have multiple independent conversations by project or no-project context.
- Direct chat uses the same runtime preset + agent override merge logic as task dispatch.

Current behavior:

- If the agent is paused, the message is stored and a system message explains the pause.
- If the agent is busy, the message is stored and a system message explains the conflict.
- If adapter execution fails, the error is stored as a system message and the API lifecycle log captures the failed response.
- Hermes/Hermes Gateway direct chat uses a chat-specific prompt, not the Kanban task webhook prompt.

### Automatic Dispatch Heartbeat

Implemented:

- Global heartbeat defaults to 10 seconds:

```bash
DISPATCH_LOOP_INTERVAL_MS=10000
```

- Each company has independent settings:
  - `autoDispatchEnabled`
  - `dispatchIntervalSeconds`

On each eligible company heartbeat:

1. Scan that company's `todo` tasks.
2. Check dependencies.
3. If no assignee exists, auto-select an active idle agent.
4. Prefer agents from the same department.
5. Add match score for tags, capabilities, role, title, and spend.
6. Move assigned cards to `todo`.
7. Dispatch cards to `in_progress`.
8. Run the selected adapter.
9. Move completed cards to `in_review` if approval/reviewer exists, otherwise `done`.
10. Move explicit cannot-complete output or webhook `status=needs_review` to help review when an independent reviewer/manager exists, otherwise `blocked`.
11. Auto-review `in_review` and `needs_review` cards when a reviewer is configured.
12. Cascade parent cards to `done` when all sub-tasks are done.

### Cron System

Implemented:

- The dispatch loop is now a named cron service: `dispatch-heartbeat`.
- The server still starts it automatically unless `DISPATCH_LOOP_ENABLED=false`.
- Global interval still uses `DISPATCH_LOOP_INTERVAL_MS`.
- Company-level interval and auto-dispatch switch still control which companies are eligible on a loop tick.
- Manual cron runs bypass company interval throttling so an operator can force a debug tick.
- Durable `cron_runs` table records:
  - source: `startup`, `loop`, or `manual`
  - status
  - start/completion time
  - duration
  - active company count
  - scanned cards
  - dispatched cards
  - reviewed cards
  - skipped cards
  - errors
- The monthly budget reset cron also writes a `budget-monthly-reset` row to `cron_runs` and `budget.monthly_reset` activity events.
- API endpoints:
  - `GET /api/cron/status`
  - `GET /api/cron/runs`
  - `POST /api/cron/run`
  - `GET /api/agent-runtimes/health`
- Logs page includes cron heartbeat status, recent run history, and a manual `Run now` button.

### Phase 8: Execution Safety

Implemented:

- `heartbeat_runs` records every dispatch/review run with source, status, cost, duration, error, card id, and agent id.
- `kanban_cards` has execution lock fields:
  - `executionLockId`
  - `executionLockedByAgentId`
  - `executionLockedAt`
  - `executionLockExpiresAt`
  - `activeHeartbeatRunId`
- `dispatchCard` now creates a heartbeat run and atomically acquires a lock before calling an adapter.
- If another process already owns the lock, the run is cancelled and the task is not double-executed.
- Expired locks are recovered by the dispatch loop, the agent is marked not busy, `lock_expired/warning` is logged, and the task returns to `todo` with backoff or moves to `blocked` after `max_retries`.
- Adapter results with `success: false` now go through retry/block handling instead of being treated as completed work.
- `pause_agent` comments clear active locks and cancel the active heartbeat run.

### Phase 9: Governance and Budget

Implemented:

- `activity_log` records product-level audit events for cards, agents, comments, approvals, budget policies, execution locks, stale recovery, and webhook completions.
- `cost_events` records immutable cost entries by company, agent, task, project, goal, provider, and model.
- `budget_policies` supports company-wide or agent-scoped limits:
  - monthly limit
  - per-task limit
  - warning threshold
  - hard-stop flag
- Dispatch preflight blocks and pauses agents that are already over monthly budget.
- Dispatch/review completion records cost events and can pause agents if hard-stop limits are exceeded.
- Monthly budget reset clears `agents.spent_this_month` on `BUDGET_RESET_DAY` UTC, default day 1, and is guarded by a `cron_runs` month marker.
- Budget hard stops create pending `budget_override_required` approvals.
- Tasks that require approval create pending approval records.
- Reviewer or board approval updates approval state and task stage.
- Budget page now includes policy creation, pending approvals, cost events, and spend rollups.
- Logs page now includes activity log and heartbeat run streams.

### Adapters and Execution

Implemented adapters:

- `mock`
- `hermes`
- `hermes-ssh`
- `hermes-gateway`
- `codex-app`
- `webhook`
- `openclaw`

Configuration model:

- Global defaults can still come from `.env`.
- Runtime presets live in `agent_runtimes`.
- Runtime presets now include `localWorkspaceRoot` and `localScratchRoot`, the machine-local folders used by attached agents for repo clone/cache and temporary task files.
- Agent-specific overrides live in `agents.adapter_config`.
- Effective adapter config is `env fallback -> runtime preset -> agent override`.
- Runtime health summaries are available in `Settings` and `GET /api/agent-runtimes/health`.

Where to configure:

- `Settings -> Agent runtimes`: create/edit/delete reusable runtime presets.
- `Agents -> select agent`: choose the runtime preset and set per-agent override fields.
- `Agents -> Test`: test the selected adapter using the merged runtime and agent configuration.

Runtime fields:

- Common runtime-local fields: `localWorkspaceRoot`, `localScratchRoot`.
- `mock`: no endpoint required.
- `hermes`: `portainerUrl`, `portainerUser`, `portainerPass`, `portainerEndpointId`, `hermesContainer`, `megacorpsApiUrl`.
- `hermes-ssh`: `sshHost`, `sshUser`, `sshPort`, `sshKeyPath`, `sshOptions`, `hermesCommand`, `megacorpsApiUrl`.
- `hermes-gateway`: `hermesGatewayUrl`, `hermesDashboardToken`, `megacorpsApiUrl`.
- `codex-app`: `codexTransport`, `codexCommand`, `codexArgs`, `codexAppServerUrl`, `codexWsToken`, `codexModel`, `codexCwd`, `codexSandbox`, `codexExperimentalApi`.
- `webhook`: `webhookUrl`.
- `openclaw`: `openclawUrl`.

Compatibility notes:

- `megacorpsApiUrl` is the MegaCorps callback/API base URL injected into task prompts. Existing `publicApiUrl`, `callbackUrl`, and `webhookBaseUrl` keys are still read for legacy runtime presets.
- Hermes CLI adapters pass prompts with `-z` and do not pass `--reasoning-effort`, `--max-turns`, or bare prompt arguments. Hermes v0.15.2 rejects unsupported CLI flags and bare prompt text. Reasoning behavior belongs in the Hermes profile/config, not the MegaCorps command line.

Current behavior:

- `mock` completes local smoke tasks.
- Hermes Portainer executes `hermes -z "{prompt}" --profile {profile}` through Portainer exec using runtime/agent configuration.
- Hermes SSH executes `hermes -z "{prompt}" --profile {profile}` through OpenSSH and captures stdout/stderr as the adapter result.
- Hermes HTTP API calls the configured gateway URL.
- Codex app-server starts/resumes a Codex thread through JSON-RPC, sends the MegaCorps prompt as a turn, streams agent-message deltas, and records thread/turn ids.
- Webhook and OpenClaw adapters post to their configured URLs.
- Hermes adapter stores session id, cost, duration, and output.
- Review loop can reject or approve based on reviewer output.

Gaps:

- In-process DB-backed task-run queue is implemented.
- Dedicated long-running worker sidecar and distributed queue locks are still future work.
- Secrets are stored as JSON config in the local MVP database; production should encrypt or externalize them.
- The server image includes `openssh-client`, creates `/home/megacorps/.ssh`, and deploy compose mounts persistent SSH keys there. Production deployments must provide an SSH key readable by the `megacorps` container user when `hermes-ssh` uses key auth.
- `docker-compose.deploy.yml` connects `megacorps-server` to the external `hermes_default` Docker network for stable DNS access to `hermes-suite` across Portainer redeployments.

### Production Controls Added

Implemented:

- `requireRole` helper with viewer/operator/admin rank.
- Operator/admin required for mutation-heavy routes, manual run/review/decompose, adapter tests, runtime edits, budget changes, approval decisions, and manual cron.
- `company_memberships` table with viewer/operator/admin roles.
- Company-scoped reads and mutations for company-owned data.
- Company-scoped runtime presets and Settings member management.
- `task_runs` queue records for manual and cron-triggered dispatch/review attempts.
- IP-based in-app rate limiter:
  - auth: 12/min
  - chat: 40/min
  - webhook: 120/min
  - operator actions: 20/min
  - writes: 120/min
  - reads: 600/min
- Fail-closed webhook shared-secret guard; task completion callbacks require `WEBHOOK_SHARED_SECRET` or DB setting `webhook.shared_secret`, and dispatched agents are prompted to send `X-MegaCorps-Webhook-Secret`.
- Production onboarding now uses no-active-admin signup promotion plus hashed one-time invite tokens.
- Runtime health API and Settings panel.
- Next.js error boundary with retry/dashboard recovery.

Limits:

- System-level API lifecycle logs are authenticated but not yet fully sliced by company.
- Service-agent keys and finer-grained production permission policies are not implemented yet.
- Rate limiting is in-memory per API process; production should still use reverse-proxy limits.
- Runtime health is based on configuration, attached agents, and recent runs; it is not yet an active external heartbeat probe.

### Logs and Audit Trail

Implemented:

- `task_logs` for task-local events:
  - stage changes
  - dispatch
  - review
  - retries
  - decomposition
  - cascade
  - comments
  - user interventions
- `api_events` for API lifecycle:
  - user id
  - method
  - path
  - status code
  - request body
  - response body
  - error
  - duration
  - timestamp
- `activity_log` for immutable product-level actions.
- `heartbeat_runs` for execution history and lock status.
- `cost_events` for budget and cost rollups.
- `cron_runs` for dispatch scheduler status and tick summaries.
- `chat_sessions` / `chat_messages` for direct agent conversations and adapter-session continuity.
- `adapter_sessions` for adapter-native thread/session continuity by scope; currently used by Codex app-server direct chat and card dispatch/review runs.

Sensitive keys are redacted when they match:

- password
- pass
- token
- secret
- jwt

Log health notes:

- Normal validation failures are logged as warnings, not server crashes.
- Real 5xx errors remain error-level logs.

## Current Local Verification

Verified on 2026-06-08:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check` returned only Windows CRLF normalization warnings, no whitespace/content errors.
- This pass did not start Docker; deployment remains user-managed.
- API compile coverage includes:
  - task message board comments with user/agent authors
  - bounded Kanban context builder
  - chat session/message routes
  - cron status/run routes
  - dispatch cron service
  - task dispatch/review/decomposition
  - adapter registry including `hermes-ssh`
  - Codex app-server adapter prompt/session parameter coverage
  - API Help response schema/example and rate-limit coverage
  - RBAC role helper and rate-limit policy classification
  - runtime health endpoint type coverage
  - monthly budget reset cron compile coverage
- Web route smoke:
  - `/dashboard`
  - `/companies`
  - `/departments`
  - `/agents`
  - `/projects`
  - `/workspaces`
  - `/knowledge`
  - `/kanban`
  - `/chat`
  - `/cron`
  - `/logs`
  - `/admin`
  - `/settings`
  - `/help`
  - `/budget`

Known local warning:

- On Windows, Next sometimes warns that the native SWC binary is not a valid Win32 application. The build falls back and exits successfully.

Recent log review:

- Last smoke run produced no 5xx server errors.
- Recent 400 entries were validation/JSON errors from deliberately incorrect smoke payloads while verifying error logging.
- Migration startup emits PostgreSQL `already exists, skipping` NOTICE messages because migrations are idempotent.

## Gap Analysis Against Paperclip

Implemented or partially implemented:

- Company control plane.
- Company memberships and company-scoped read/mutation checks.
- Real department-aware O-chart tree.
- Kanban/ticket board.
- Heartbeat dispatch.
- DB-backed task-run queue and in-process task-run worker.
- Bring-your-own-agent adapter shape, including Codex app-server.
- Runtime registry, adapter endpoint configuration, and runtime health summaries.
- Basic budgets on agents.
- Pause/resume/fire governance.
- Task comments and intervention.
- Task and API logs.
- Sub-task creation and parent cascade.
- Company/project/goal ancestry in prompts.
- Repo-centric project workspace policy with pull-before-run and push/PR completion protocol.
- Work products for PRs, commits, previews, reports, screenshots, artifacts, and external URLs.
- React Query browser cache and authenticated WebSocket live event invalidation.
- Knowledge base CRUD and tag-based prompt injection.
- Project CRUD, company Workspace authority paths, and company/department/project goal setup UI.
- Dashboard, companies, departments, agents, projects, workspace, kanban, direct chat, cron, logs, admin, settings, knowledge, and direct budget pages.

Still missing:

- Service-agent keys and more granular company permission policies.
- Dedicated async worker sidecar for long-running Hermes jobs.
- Distributed queue locks/retries with BullMQ/Redis or equivalent.
- Active external runtime probes, runtime versions, and adapter-reported capabilities.
- A richer durable event bus/streaming layer beyond the current in-process WebSocket broadcaster and `activity_log`.
- Multi-stage approval policy UI.
- Deeper repo integration such as automated PR creation, merge checks, and branch cleanup.
- Company template import/export with secret scrubbing.
- Plugin architecture.
- Secret encryption/external secret store for adapter credentials.
- End-to-end browser test suite.
- Multi-process WebSocket/SSE backplane for chat, task progress, logs, and dashboard counters.
- Multi-process/distributed rate limiting and advanced abuse controls.
- Replica-safe company membership enforcement for future multi-server deployments.
- Versioned migrations with rollback strategy; current migration is idempotent bootstrap SQL.
- Backup/restore, disaster recovery, and retention policies.

## Production Readiness Review

The Phase 1-15 operational MVP is usable for controlled local/NAS debugging, but it is not production-complete yet. The next work should harden it for real unattended operation:

1. Runtime health:
   - active runtime probe, not only last-run summary
   - last heartbeat
   - version/capabilities reported by runtime adapters
   - disable routing to offline runtimes

2. Secret handling:
   - encrypt runtime config secrets
   - redact secret-like values in all API responses
   - support external secret references

3. Authorization and tenancy:
   - add service-agent keys and membership recovery controls
   - add service-agent API keys
   - continue tightening system-level audit scoping for multi-tenant deployments

4. Workspaces:
   - repo provider credentials and secret refs
   - automated branch/PR lifecycle
   - richer runtime-local workspace cleanup/retention policies without making local folders the source of truth

5. Async execution:
   - move the current in-process DB queue worker into a dedicated sidecar
   - distributed queue locks for multi-replica deployments
   - per-agent concurrency limits outside the web server process
   - persistent job retry/timeout controls

6. Multi-stage approvals:
   - configurable execution policies
   - staged signoff
   - approval queue filters

7. Realtime collaboration:
   - replace the in-process live broadcaster with a multi-replica event backplane
   - extend live events to streamed adapter progress and dashboard counters

8. Browser QA:
   - manual Browser plugin pass is complete for the current UI
   - still need automated logged-in browser flows in CI
   - still need task drawer interaction tests
   - still need settings/agent runtime form tests
   - still need dark-mode contrast snapshots

9. Operations:
   - backup/restore runbook
   - metrics and alerting
   - reverse-proxy rate limits now, then built-in API throttling
   - production CORS/cookie security
   - audit retention and export

## Operational Notes

Useful commands:

```bash
npm run typecheck
npm test
npm run build
docker compose up -d --build
docker compose logs --tail=200 server
docker compose ps
```

Important URLs:

- Web: `http://localhost:3000`
- API: `http://localhost:4000`
- Health: `http://localhost:4000/health`

Important tables:

- `companies`
- `departments`
- `agents`
- `kanban_cards`
- `card_comments`
- `chat_sessions`
- `chat_messages`
- `task_logs`
- `api_events`
- `agent_runtimes`
- `knowledge_docs`
- `heartbeat_runs`
- `cron_runs`
- `activity_log`
- `cost_events`
- `budget_policies`
- `approvals`

## Source Links

- Paperclip GitHub: https://github.com/paperclipai/paperclip
- Paperclip README: https://github.com/paperclipai/paperclip/blob/master/README.md
- MegaCorps GitHub: https://github.com/aliceastor/megacorps
