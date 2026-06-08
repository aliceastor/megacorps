# MegaCorps Phase 1-15 Control Plane MVP

Node.js + Fastify + Next.js 15 + Drizzle + PostgreSQL + Turborepo using npm workspaces.

## Documentation

- [MegaCorps_PROGRESS.md](./MegaCorps_PROGRESS.md): current progress, Paperclip/Hermes Kanban reference review, implemented features, gap analysis, and next phase plan.
- [MegaCorps_ARCHITECTURE.md](./MegaCorps_ARCHITECTURE.md): long-form architecture notes and implementation updates.

## Run locally

1. Copy `.env.example` to `.env` and set any adapter credentials such as `PORTAINER_PASS`.
2. Install dependencies with `npm install`.
3. Start the full stack with `docker compose up -d --build`.
4. Open `http://localhost:3000`.

The sample `DATABASE_URL` is for the Docker Compose network (`postgres:5432`). If you run the server directly on the host instead of through Compose, change the host to `localhost` and expose or provide a local PostgreSQL instance.

Default local URLs:

- Web UI: `http://localhost:3000`
- API: `http://localhost:4000`

Remote Docker note:

- The web client auto-detects the browser host first. If the UI is opened at `http://megacorps.example.internal:3000`, API calls use `http://megacorps.example.internal:4000` before trying the baked `NEXT_PUBLIC_API_URL`.
- Set `NEXT_PUBLIC_API_URL` only when the API is on a different host/domain. A baked `localhost` default will not override the browser-host fallback on remote Docker.
- `docker-compose.deploy.yml` connects `megacorps-server` to the external `hermes_default` Docker network so the `hermes-ssh` runtime can use Docker DNS names such as `hermes-suite`. Ensure that external network exists before deploying that compose file.

## Scripts

- `npm run test`
- `npm run typecheck`
- `npm run build`

Local red-team cleanup:

```powershell
Get-Content scripts/cleanup-redteam-data.sql | docker exec -i megacorps-postgres psql -U megacorps -d megacorps -v ON_ERROR_STOP=1
```

## How to use agent adapters

MegaCorps now has two configuration layers:

1. Open `Settings -> Agent runtimes` and create a reusable runtime preset.
2. Open `Agents`, select an agent, then choose a runtime preset or fill the adapter override fields on that agent.

Agent overrides win over runtime presets. When `.env` adapter fallback is enabled, runtime presets win over `.env` defaults.
In production, external adapters (`hermes`, `hermes-ssh`, `hermes-gateway`, `webhook`, `openclaw`) require a company-scoped runtime preset by default. `.env` adapter fallback is disabled unless `ADAPTER_ENV_FALLBACK_ENABLED=true`, which should be reserved for local development/debugging.
Signup is stored in DB setting `auth.signup_enabled` and defaults to enabled. Admins can turn it on/off in the Web UI `Admin` page.
Adapter egress blocks localhost/link-local metadata targets by default. Set `ADAPTER_TARGET_ALLOWLIST` to comma-separated hostnames or wildcard domains such as `hermes.example.internal,*.agents.example.com` when production should restrict agent runtimes to known hosts.

Production onboarding:

1. Open `/signup` and create the first account. If no active admin exists, that signup becomes global admin and default-company admin.
2. Open `Admin` to manage all accounts, roles, account status, password resets, and the DB-backed signup switch.
3. Later users can self-signup while signup is enabled, or accept `/signup?invite=...` invite links from an admin.
4. Existing users receiving invites get the new membership but must log in with their existing password.

Common login/onboarding errors:

- `signup_disabled`: signup was turned off from the `Admin` page. Use an invite link or ask an admin to re-enable signup.
- `user_disabled`: the account was disabled from the `Admin` page.

Supported runtime fields:

- `mock`: no endpoint needed.
- `hermes`: `portainerUrl`, `portainerUser`, `portainerPass`, `portainerEndpointId`, `hermesContainer`, `megacorpsApiUrl`, `maxTurns`.
- `hermes-ssh`: `sshHost`, `sshUser`, `sshPort`, `sshKeyPath`, `sshOptions`, `hermesCommand`, `megacorpsApiUrl`, `maxTurns`.
- `hermes-gateway`: `hermesGatewayUrl`, `hermesDashboardToken`, `megacorpsApiUrl`.
- `webhook`: `webhookUrl`.
- `openclaw`: `openclawUrl`.

`megacorpsApiUrl` is the MegaCorps API base URL agents use for task-complete callbacks. Legacy `publicApiUrl`, `callbackUrl`, and `webhookBaseUrl` config keys are still accepted for existing runtimes, but new presets should use `megacorpsApiUrl`.
Hermes CLI adapters intentionally do not pass `--reasoning-effort`; Hermes v0.15.2 rejects that flag. Configure provider/model reasoning behavior inside the Hermes profile/config instead.
For Hermes Portainer, the agent still needs a `hermesProfile`; the runtime tells MegaCorps where to execute it.
For Hermes SSH, create a runtime preset with `adapterType=hermes-ssh`, set `sshHost` to your Hermes host, set the SSH user/key path reachable inside the server container, and set each agent's `hermesProfile` to the Hermes profile name such as `alice`. The SSH user defaults to `root` and can be overridden. The deploy compose mounts persistent SSH keys at `/home/megacorps/.ssh`, with `/home/megacorps/.ssh/id_ed25519` as the default key path.
For Hermes HTTP API and Webhook/OpenClaw, the URL lives in the runtime preset or the agent override panel.

Hermes suite operational notes:

- Prefer a Hermes suite image with `openssh-server` preinstalled for production. Installing it in the Hermes entrypoint works for debugging, but it slows every restart and is external to this MegaCorps image.
- Verify the Hermes profile used by each MegaCorps agent has provider/model/API-key state available inside hermes-suite. For example: `hermes --profile alice config get provider`, `hermes --profile alice config get model`, and `cat /root/.hermes/profiles/alice/.env`.

## Web UI pages

- `Dashboard`: operating overview, stage counts, recent task logs, recent API lifecycle events.
- `Companies`: company registry, company settings, department settings, reporting structure, and delegation closure.
- `Direct Chat`: company -> agent -> session direct messaging with resumable adapter sessions.
- `Kanban`: task UUIDs, stage, details, per-task message board, sub-tasks, logs, run/review/decompose/delete.
- `Agents`: member hierarchy, agent CRUD, pause/resume/fire/reset, runtime and adapter configuration.
- `Budget`: spend and budget visibility for agents and tasks.
- `Logs`: cron heartbeat status, heartbeat runs, activity, and full API lifecycle log with request, response, status, duration, and errors.
- `Knowledge`: company-scoped Markdown docs injected into agent prompts by tag.
- `Workspaces`: project and goal setup for task context.
- `Admin`: global account management, signup switch, roles, account status, and password resets.
- `Settings`: company heartbeat settings, departments, runtime presets, adapter endpoints.
  Runtime health summaries show adapter status, attached agents, last run status, and capabilities. Company members can be managed by email with viewer/operator/admin roles.

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
- Phase 11: per-task agent/user message boards and bounded Kanban context injection for every agent invocation.
- Phase 12: Hermes SSH adapter, API Help response schema/examples, rate-limit disclosure, and browser-host API fallback.
- Phase 13: real O-chart tree canvas, operator RBAC for mutations/manual execution, in-app rate limiting, runtime health summary, webhook shared-secret guard, monthly budget reset cron, and UI error boundary.
- Phase 14: company memberships, company-scoped read filters, company operator/admin mutation checks, runtime company scoping, and Settings member management.
- Phase 15: database-backed `task_runs` queue, background task-run worker, queued manual run/review, queued cron dispatch/review, and Logs task-run visibility.

Reference-informed next phases:

- Phase 16: dependency/blocker graph with derived ready state and reclaim policy.
- Phase 17: chain-of-command context, manager review, escalation, and delegation loop.
- Phase 18: work products, attachments, preview links, and company template import/export.

## Paperclip-inspired loop

MegaCorps follows the same control-plane idea as Paperclip: manage goals and an org chart, not individual terminal sessions. A company owns departments, agents, tasks, goals, and dispatch settings. Agents report through an O-chart (`bossId`) and can be grouped by department. The Companies and Agents pages render this as a real top-down tree canvas with connector lines; clicking any member opens the edit panel for identity, runtime, department, budget, and reporting relation.

The dispatch engine runs on a heartbeat. The global tick defaults to 10 seconds with `DISPATCH_LOOP_INTERVAL_MS=10000`; each company also has `dispatchIntervalSeconds` and `autoDispatchEnabled`. On each company heartbeat:

- scan `todo` Kanban tasks,
- auto-assign unassigned tasks to an active idle agent, preferring department and tag/capability matches,
- enqueue dispatch task-run attempts,
- enqueue review task-run attempts when a reviewer is configured,
- let the task-run worker claim queued work, move assigned work into `in_progress`, run the configured adapter, and move completed work to `in_review` or `done`,
- cascade parent tasks when all sub-tasks are complete.

Cron/debug endpoints:

- `GET /api/help`: machine-readable API catalog for agents and integrations, including response schema examples and rate-limit notes.
- `GET /api/help?format=markdown`: Markdown API catalog with body examples, response examples, and rate-limit notes.
- `GET /api/agent-runtimes/health`: runtime status, attached agent counts, last run state, and adapter capabilities.
- `GET /api/task-runs`: queued/running/completed dispatch and review attempts.
- `GET /api/cron/status`: in-memory scheduler state plus recent durable cron runs.
- `GET /api/cron/runs`: cron run history.
- `POST /api/cron/run`: manually run one dispatch heartbeat and enqueue eligible task runs.

## Direct agent chat

Open `Direct Chat` in the sidebar:

1. Pick a company.
2. Pick an agent in that company.
3. Select an existing session or create a new session.
4. Send a message.

Every chat session stores its own `agentSessionId`, so a user can keep several separate conversations with the same agent. Chat messages are stored in `chat_messages`, sessions in `chat_sessions`, and every agent reply is also recorded through `heartbeat_runs`, `activity_log`, and `cost_events`.

## Task message board and intervention

Open a task and use the Message Board tab:

- `Comment only`: add audit/context.
- `Agent note`: leave a task message as a specific agent.
- `Stop agent now and block task`: mark the task blocked and pause the assignee.
- `Send comment to agent context`: queue the instruction for the next run prompt.
- `Continue run with comment`: reactivate the assignee and move the task back to `todo`.

Dispatch/review/webhook completions now also create agent-authored messages on the task board, so task discussion is not hidden only in logs.

`Split into Sub-tasks` decomposes a larger task into child Kanban tasks. It uses the task body lines when available, otherwise it creates Plan / Execute / Review sub-tasks.

## Agent invocation context

Every task dispatch, review, and direct chat invocation receives a bounded Kanban context snapshot:

- company mission/settings,
- compact same-company Kanban board snapshot,
- focus task details,
- parent/child/dependency task context,
- focus agent open work and review queue,
- latest task message board entries,
- latest task lifecycle logs,
- recent company activity,
- recent heartbeat runs.

Context budget env vars:

- `DISPATCH_CONTEXT_CHAR_BUDGET`
- `DISPATCH_CONTEXT_CARD_LIMIT`
- `DISPATCH_CONTEXT_RECORD_LIMIT`
- `DISPATCH_TASK_BODY_CHAR_LIMIT`
- `DISPATCH_KNOWLEDGE_DOC_CHAR_LIMIT`
- `MESSAGE_BOARD_COMMENT_LIMIT`

## Logs

MegaCorps stores two complementary log streams:

- `task_logs`: stage changes, dispatch/review/decomposition/comment events, agent output.
- `api_events`: full API lifecycle with method, path, status, request, response, error, duration, and user id. Sensitive fields such as password/token/secret/jwt are redacted.
- `activity_log`: product-level audit events for cards, agents, approvals, budget policies, locks, recovery, and webhook completions.
- `task_runs`: DB-backed queue jobs for dispatch/review attempts with queued/running/success/failed state.
- `heartbeat_runs`: every dispatch/review run with source, status, lock, cost, duration, and error.
- `cost_events`: immutable cost records by company, agent, task, project, goal, provider, and model.
- `cron_runs`: every dispatch heartbeat tick with source, status, counts, duration, and errors.
- `chat_sessions` / `chat_messages`: direct agent conversation lifecycle and agent reply metadata.
- `card_comments`: per-task message board entries from users, agents, system/webhook completions, and intervention actions.

Phase 8/9 safety behavior:

- A task must acquire an execution lock before an adapter run starts.
- Expired locks are recovered by the dispatch loop and returned to `todo`.
- Adapter `success:false` now goes through retry/block handling instead of silently marking work done.
- Budget policies can hard-stop an agent when monthly or per-task limits are reached.
- Tasks requiring approval create pending approval records and can be approved/rejected from the Budget page.
- Member hierarchy is based on `bossId`: the identity label is free text, while the important control-plane relation is who a member reports to and who reports to them.
- Decomposed sub-tasks are delegated to direct reports when the parent task is assigned to a member with subordinates.
- Work completed by a subordinate moves to `in_review` for the reporting manager by default, creating a bottom-up review path back toward the top-level member.
- In-app IP rate limiting is enabled by default. Tune `RATE_LIMIT_*` env vars or set `RATE_LIMIT_ENABLED=false` for local stress tests.
- Mutation/manual execution routes require operator/admin roles. Viewer role can read authenticated UI data.
- Task completion webhooks require `WEBHOOK_SHARED_SECRET` and must send either `X-MegaCorps-Webhook-Secret` or `Authorization: Bearer`.
- Monthly agent spend resets on `BUDGET_RESET_DAY` UTC, default day 1, and the reset is marked in `cron_runs`.
- Company membership rows scope visible companies and company-owned entities. Company operators/admins can mutate company data; company admins can manage memberships.
- Manual Run/Review and cron dispatch now enqueue `task_runs`; the in-process worker claims the queue and records linked `heartbeat_runs`.

No pnpm. No Redis.

## Production launch checklist

- Put the app behind TLS, a reverse proxy, and external rate limits in addition to the in-app limiter.
- Set strong `WEBHOOK_SHARED_SECRET`, SSH keys, and external database credentials. The session signing secret is generated automatically into DB `app_settings.auth.jwt_secret`.
- Encrypt or externalize adapter/runtime secrets before multi-user production.
- Move the current in-process DB task-run worker into a separate sidecar/replica-safe worker for heavy production usage.
- Add WebSocket/SSE consumers for live task/chat/log updates.
- Extend company-scoped membership/RBAC with invite flow, service-agent keys, and emergency break-glass admin policy.
- Add database backup/restore, retention, migration rollback, metrics, alerts, and incident runbooks.

## Latest local verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- Authenticated API smoke: runtime, department, agent, project, goal, knowledge doc, task, comment, manual run, dashboard, logs.
- Web route smoke: `/dashboard`, `/companies`, `/chat`, `/kanban`, `/agents`, `/budget`, `/logs`, `/knowledge`, `/workspaces`, `/settings`.
