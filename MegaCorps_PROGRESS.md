# MegaCorps Progress and Research Notes

Last updated: 2026-06-05

## Executive Summary

MegaCorps is now a working control-plane MVP for AI-agent companies. The product direction is intentionally close to Paperclip: manage companies, goals, org charts, departments, tickets/tasks, heartbeats, budgets, logs, and governance instead of manually babysitting individual agent sessions.

The current local stack runs with Docker:

- Web UI: `http://localhost:3000`
- API: `http://localhost:4000`
- Database: PostgreSQL in Docker

Latest verified baseline:

- Phase 1-11 operational MVP flows are implemented.
- Company registry page, department setup, O-chart, runtime presets, adapter endpoint configuration, direct agent chat, per-task agent/user message boards, bounded Kanban context injection, task intervention, lifecycle logs, knowledge docs, project/goal context, execution locks, heartbeat runs, cron run history, budget policies, approvals, and automatic dispatch heartbeat are implemented.
- Deployment is user-managed. Local-only Docker was used for QA in this pass; NAS/server deployment remains user-managed.
- Browser plugin QA verified signup/login, readable validation errors, Dashboard, Companies, Agents, Kanban, Direct Chat, Logs, Settings, task drawer, task message board comments, mobile narrow layout, and dark-mode agent card text.
- Docker CI is configured in `.github/workflows/docker-build.yml` for server and web images.

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
- Workspaces: agents should work in the correct project directory, branch, or worktree.
- Events/activity: every mutation, heartbeat, cost event, approval, comment, and work product should be durable and auditable.
- Plugins/adapters: external agents and custom capabilities should attach without forking the core.

## Current MegaCorps Implementation

### Authentication and UI Shell

Implemented:

- Signup/login/logout.
- Authenticated app shell.
- Dark/light theme.
- Language foundation.
- Better validation error handling.
- API unreachable handling for frontend `fetch` failures.

Notes:

- Server validation errors now return `validation_failed` plus structured issues.
- Frontend converts Zod-style errors into readable messages such as `password must be at least 8 characters.`

### Kanban and Task Model

Implemented:

- Every task/card has a UUID.
- A card has exactly one stage:
  - `backlog`
  - `todo`
  - `in_progress`
  - `in_review`
  - `done`
  - `blocked`
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
- `send_to_agent`: store instruction and queue it for agent context.
- `continue_run`: reactivate the assignee and move task back to `todo`.

Implemented message board behavior:

- Each Kanban task has its own message board.
- Users can post normal comments or intervention instructions.
- Users can post an agent-authored note by selecting an agent as the author.
- Agent dispatch output is automatically added as an `agent_update` board message.
- Reviewer output is automatically added as `review_note` or `review_rejected`.
- Dispatch/review failures are automatically added as agent error messages.
- Webhook completions are also added as agent/system board messages.

Agent dispatch prompts now include latest task message board entries, so user and agent discussion can reach the agent on the next run.

### Bounded Kanban Context Injection

Implemented:

- Every task dispatch invocation includes a bounded Kanban context snapshot.
- Every review invocation includes the same bounded context plus execution output.
- Every direct chat invocation includes same-company Kanban context and focus-agent work context.
- The snapshot contains:
  - company mission/settings
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
- Companies/Agents pages group the O-chart by department and reporting line.
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
- Parent tasks close when all child tasks are completed, preserving a top-down delegation and bottom-up reporting loop.

### Direct Agent Chat

Implemented:

- Sidebar `Direct Chat` page.
- Company selector showing all agents in the selected company.
- Agent selector with status, identity label, and adapter type.
- Per-agent session list.
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
- Each chat session stores its own `agentSessionId`, so the same agent can have multiple independent conversations.
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

1. Scan that company's `backlog` and `todo` tasks.
2. Check dependencies.
3. If no assignee exists, auto-select an active idle agent.
4. Prefer agents from the same department.
5. Add match score for tags, capabilities, role, title, and spend.
6. Move assigned cards to `todo`.
7. Dispatch cards to `in_progress`.
8. Run the selected adapter.
9. Move completed cards to `in_review` if approval/reviewer exists, otherwise `done`.
10. Auto-review `in_review` cards when a reviewer is configured.
11. Cascade parent cards to `done` when all sub-tasks are done.

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
- API endpoints:
  - `GET /api/cron/status`
  - `GET /api/cron/runs`
  - `POST /api/cron/run`
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
- Expired locks are recovered by the dispatch loop, the agent is marked not busy, the task returns to `todo`, and recovery is logged.
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
- Budget hard stops create pending `budget_override_required` approvals.
- Tasks that require approval create pending approval records.
- Reviewer or board approval updates approval state and task stage.
- Budget page now includes policy creation, pending approvals, cost events, and spend rollups.
- Logs page now includes activity log and heartbeat run streams.

### Adapters and Execution

Implemented adapters:

- `mock`
- `hermes`
- `hermes-gateway`
- `webhook`
- `openclaw`

Configuration model:

- Global defaults can still come from `.env`.
- Runtime presets live in `agent_runtimes`.
- Agent-specific overrides live in `agents.adapter_config`.
- Effective adapter config is `env fallback -> runtime preset -> agent override`.

Where to configure:

- `Settings -> Agent runtimes`: create/edit/delete reusable runtime presets.
- `Agents -> select agent`: choose the runtime preset and set per-agent override fields.
- `Agents -> Test`: test the selected adapter using the merged runtime and agent configuration.

Runtime fields:

- `mock`: no endpoint required.
- `hermes`: `portainerUrl`, `portainerUser`, `portainerPass`, `portainerEndpointId`, `hermesContainer`, `publicApiUrl`, `reasoningEffort`, `maxTurns`.
- `hermes-gateway`: `hermesGatewayUrl`, `hermesDashboardToken`, `publicApiUrl`.
- `webhook`: `webhookUrl`.
- `openclaw`: `openclawUrl`.

Current behavior:

- `mock` completes local smoke tasks.
- Hermes Portainer executes `hermes chat -q` through Portainer exec using runtime/agent configuration.
- Hermes HTTP API calls the configured gateway URL.
- Webhook and OpenClaw adapters post to their configured URLs.
- Hermes adapter stores session id, cost, duration, and output.
- Review loop can reject or approve based on reviewer output.

Gaps:

- Long-running async worker sidecar is still future work.
- Queue-based concurrency is not yet implemented.
- Secrets are stored as JSON config in the local MVP database; production should encrypt or externalize them.

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

Verified on 2026-06-05:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`
- This pass did not start Docker; deployment remains user-managed.
- API compile coverage includes:
  - task message board comments with user/agent authors
  - bounded Kanban context builder
  - chat session/message routes
  - cron status/run routes
  - dispatch cron service
  - task dispatch/review/decomposition
  - adapter registry
- Web route smoke:
  - `/dashboard`
  - `/companies`
  - `/chat`
  - `/kanban`
  - `/agents`
  - `/budget`
  - `/logs`
  - `/knowledge`
  - `/workspaces`
  - `/settings`

Known local warning:

- On Windows, Next sometimes warns that the native SWC binary is not a valid Win32 application. The build falls back and exits successfully.

Recent log review:

- Last smoke run produced no 5xx server errors.
- Recent 400 entries were validation/JSON errors from deliberately incorrect smoke payloads while verifying error logging.
- Migration startup emits PostgreSQL `already exists, skipping` NOTICE messages because migrations are idempotent.

## Gap Analysis Against Paperclip

Implemented or partially implemented:

- Company control plane.
- Department and O-chart basics.
- Kanban/ticket board.
- Heartbeat dispatch.
- Bring-your-own-agent adapter shape.
- Runtime registry and adapter endpoint configuration.
- Basic budgets on agents.
- Pause/resume/fire governance.
- Task comments and intervention.
- Task and API logs.
- Sub-task creation and parent cascade.
- Company/project/goal ancestry in prompts.
- Knowledge base CRUD and tag-based prompt injection.
- Project/workspace/goal setup UI.
- Dashboard, direct chat, logs, budget, settings, knowledge, and workspace pages.

Still missing:

- Strong multi-company data isolation enforcement in every endpoint.
- Async worker sidecar for long-running Hermes jobs.
- Queue and retries with BullMQ/Redis or equivalent.
- Runtime health checks, last heartbeat, versions, and capabilities.
- A richer event bus/streaming layer beyond the current `activity_log`.
- Multi-stage approval policy UI.
- Project git worktrees, branches, commits, and merge/review flow.
- Work products and attachments.
- Company template import/export with secret scrubbing.
- Plugin architecture.
- Secret encryption/external secret store for adapter credentials.
- End-to-end browser test suite.
- WebSocket/SSE realtime updates for chat, task progress, logs, and dashboard counters.
- Rate limits and abuse controls on auth, chat, webhook, and manual cron endpoints.
- Role-based authorization beyond basic authenticated access.
- Versioned migrations with rollback strategy; current migration is idempotent bootstrap SQL.
- Backup/restore, disaster recovery, and retention policies.

## Production Readiness Review

The Phase 1-10 operational MVP is usable for controlled local/NAS debugging, but it is not production-complete yet. The next work should harden it for real unattended operation:

1. Runtime health:
   - runtime status
   - last heartbeat
   - version/capabilities
   - disable routing to offline runtimes

2. Secret handling:
   - encrypt runtime config secrets
   - redact secret-like values in all API responses
   - support external secret references

3. Authorization and tenancy:
   - enforce company scoping in every endpoint
   - introduce RBAC for admin/operator/viewer actions
   - restrict manual cron, adapter tests, budget override, and delete operations

4. Workspaces:
   - project workspace path
   - agent branch/worktree
   - output/work-product tracking

5. Async execution:
   - queue/worker sidecar for long-running Hermes jobs
   - per-agent concurrency limits outside the web server process
   - persistent job retry/timeout controls

6. Multi-stage approvals:
   - configurable execution policies
   - staged signoff
   - approval queue filters

7. Realtime collaboration:
   - WebSocket or SSE for chat, run progress, logs, and dashboard updates
   - reconnect and backfill behavior

8. Browser QA:
   - manual Browser plugin pass is complete for the current UI
   - still need automated logged-in browser flows in CI
   - still need task drawer interaction tests
   - still need settings/agent runtime form tests
   - still need dark-mode contrast snapshots

9. Operations:
   - backup/restore runbook
   - metrics and alerting
   - rate limits
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
