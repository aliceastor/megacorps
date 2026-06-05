# MegaCorps Phase 1-9 Control Plane MVP

Node.js + Fastify + Next.js 15 + Drizzle + PostgreSQL + Turborepo using npm workspaces.

## Documentation

- [MegaCorps_PROGRESS.md](./MegaCorps_PROGRESS.md): current progress, Paperclip research, implemented features, gap analysis, and next phase plan.
- [MegaCorps_ARCHITECTURE.md](./MegaCorps_ARCHITECTURE.md): long-form architecture notes and implementation updates.

## Run locally

1. Copy `.env.example` to `.env` and set `PORTAINER_PASS`.
2. Install dependencies with `npm install`.
3. Start the full stack with `docker compose up -d --build`.
4. Open `http://localhost:3000`.

Default local URLs:

- Web UI: `http://localhost:3000`
- API: `http://localhost:4000`

NAS / remote Docker note:

- The web client auto-detects non-localhost browser hosts. If the UI is opened at `http://192.168.1.180:3000`, API calls fall back to `http://192.168.1.180:4000` instead of `http://localhost:4000`.
- Set `NEXT_PUBLIC_API_URL` only when the API is on a different host/domain. A baked `localhost` default will not override the browser-host fallback on NAS.

## Scripts

- `npm run test`
- `npm run typecheck`
- `npm run build`

## How to use agent adapters

MegaCorps now has two configuration layers:

1. Open `Settings -> Agent runtimes` and create a reusable runtime preset.
2. Open `Agents`, select an agent, then choose a runtime preset or fill the adapter override fields on that agent.

Agent overrides win over runtime presets. Runtime presets win over `.env` defaults.

Supported runtime fields:

- `mock`: no endpoint needed.
- `hermes`: `portainerUrl`, `portainerUser`, `portainerPass`, `portainerEndpointId`, `hermesContainer`, `publicApiUrl`, `reasoningEffort`, `maxTurns`.
- `hermes-gateway`: `hermesGatewayUrl`, `hermesDashboardToken`, `publicApiUrl`.
- `webhook`: `webhookUrl`.
- `openclaw`: `openclawUrl`.

For Hermes Portainer, the agent still needs a `hermesProfile`; the runtime tells MegaCorps where to execute it.
For Hermes HTTP API and Webhook/OpenClaw, the URL lives in the runtime preset or the agent override panel.

## Web UI pages

- `Dashboard`: operating overview, stage counts, recent task logs, recent API lifecycle events.
- `Companies`: company registry, company settings, department settings, reporting structure, and delegation closure.
- `Direct Chat`: company -> agent -> session direct messaging with resumable adapter sessions.
- `Kanban`: task UUIDs, stage, details, comments, sub-tasks, logs, run/review/decompose/delete.
- `Agents`: member hierarchy, agent CRUD, pause/resume/fire/reset, runtime and adapter configuration.
- `Budget`: spend and budget visibility for agents and tasks.
- `Logs`: cron heartbeat status, heartbeat runs, activity, and full API lifecycle log with request, response, status, duration, and errors.
- `Knowledge`: company-scoped Markdown docs injected into agent prompts by tag.
- `Workspaces`: project and goal setup for task context.
- `Settings`: company heartbeat settings, departments, runtime presets, adapter endpoints.

## Current scope

- Phase 1: auth endpoints, login/signup screens, shell, dashboard, theme toggle, locale string foundation.
- Phase 2: card CRUD, status transition validation, board UI, detail panel, Run Now button.
- Phase 3: agent CRUD, org chart, Portainer-backed Hermes adapter, assign/run storage.
- Phase 4: dispatch loop, review loop, retries, stage history, sub-task decomposition, execution logs.
- Phase 5: governance basics, agent pause/resume/fire, monthly budgets, API lifecycle logs.
- Phase 6: card comments, send-comment-to-agent context, stop-agent/comment/continue-run flow, company and department setup.
- Phase 7: runtime registry, adapter endpoint configuration, project/goal context, knowledge docs, workspace page, settings page, dashboard/log/budget views.
- Phase 8: execution locks, heartbeat run records, stale-lock recovery, safer adapter failure handling.
- Phase 9: activity log, cost events, budget policies, budget hard stops, pending approvals and approval decisions.
- Phase 10: direct agent chat sessions, per-session adapter resume ids, cron status/history/manual tick APIs, and chat UI.

## Paperclip-inspired loop

MegaCorps follows the same control-plane idea as Paperclip: manage goals and an org chart, not individual terminal sessions. A company owns departments, agents, tasks, goals, and dispatch settings. Agents report through an O-chart (`bossId`) and can be grouped by department.

The dispatch engine runs on a heartbeat. The global tick defaults to 10 seconds with `DISPATCH_LOOP_INTERVAL_MS=10000`; each company also has `dispatchIntervalSeconds` and `autoDispatchEnabled`. On each company heartbeat:

- scan `backlog` and `todo` Kanban tasks,
- auto-assign unassigned tasks to an active idle agent, preferring department and tag/capability matches,
- move assigned work into `in_progress`,
- run the configured adapter,
- move completed work to `in_review` or `done`,
- review tasks when a reviewer is configured,
- cascade parent tasks when all sub-tasks are complete.

Cron/debug endpoints:

- `GET /api/cron/status`: in-memory scheduler state plus recent durable cron runs.
- `GET /api/cron/runs`: cron run history.
- `POST /api/cron/run`: manually run one dispatch heartbeat.

## Direct agent chat

Open `Direct Chat` in the sidebar:

1. Pick a company.
2. Pick an agent in that company.
3. Select an existing session or create a new session.
4. Send a message.

Every chat session stores its own `agentSessionId`, so a user can keep several separate conversations with the same agent. Chat messages are stored in `chat_messages`, sessions in `chat_sessions`, and every agent reply is also recorded through `heartbeat_runs`, `activity_log`, and `cost_events`.

## Task comments and intervention

Open a task and use the Comments tab:

- `Comment only`: add audit/context.
- `Stop agent now and block task`: mark the task blocked and pause the assignee.
- `Send comment to agent context`: queue the instruction for the next run prompt.
- `Continue run with comment`: reactivate the assignee and move the task back to `todo`.

`Split into Sub-tasks` decomposes a larger task into child Kanban tasks. It uses the task body lines when available, otherwise it creates Plan / Execute / Review sub-tasks.

## Logs

MegaCorps stores two complementary log streams:

- `task_logs`: stage changes, dispatch/review/decomposition/comment events, agent output.
- `api_events`: full API lifecycle with method, path, status, request, response, error, duration, and user id. Sensitive fields such as password/token/secret/jwt are redacted.
- `activity_log`: product-level audit events for cards, agents, approvals, budget policies, locks, recovery, and webhook completions.
- `heartbeat_runs`: every dispatch/review run with source, status, lock, cost, duration, and error.
- `cost_events`: immutable cost records by company, agent, task, project, goal, provider, and model.
- `cron_runs`: every dispatch heartbeat tick with source, status, counts, duration, and errors.
- `chat_sessions` / `chat_messages`: direct agent conversation lifecycle and agent reply metadata.

Phase 8/9 safety behavior:

- A task must acquire an execution lock before an adapter run starts.
- Expired locks are recovered by the dispatch loop and returned to `todo`.
- Adapter `success:false` now goes through retry/block handling instead of silently marking work done.
- Budget policies can hard-stop an agent when monthly or per-task limits are reached.
- Tasks requiring approval create pending approval records and can be approved/rejected from the Budget page.
- Member hierarchy is based on `bossId`: the identity label is free text, while the important control-plane relation is who a member reports to and who reports to them.
- Decomposed sub-tasks are delegated to direct reports when the parent task is assigned to a member with subordinates.
- Work completed by a subordinate moves to `in_review` for the reporting manager by default, creating a bottom-up review path back toward the top-level member.

No pnpm. No Redis.

## Latest local verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- Authenticated API smoke: runtime, department, agent, project, goal, knowledge doc, task, comment, manual run, dashboard, logs.
- Web route smoke: `/dashboard`, `/companies`, `/chat`, `/kanban`, `/agents`, `/budget`, `/logs`, `/knowledge`, `/workspaces`, `/settings`.
