# MegaCorps Phase 1-18 Control Plane MVP

Node.js + Fastify + Next.js 15 + Drizzle + PostgreSQL + Turborepo using npm workspaces.

## Documentation

- [MegaCorps_PROGRESS.md](./MegaCorps_PROGRESS.md): current progress, Paperclip/Hermes Kanban reference review, implemented features, gap analysis, and next phase plan.
- [MegaCorps_ARCHITECTURE.md](./MegaCorps_ARCHITECTURE.md): long-form architecture notes and implementation updates.
- [MegaCorps_PROMPT_INJECTION.md](./MegaCorps_PROMPT_INJECTION.md): Direct Chat and Kanban prompt context format, company/department/project/card goal context, and escalation webhook payloads.

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

- The web client now tries the same-origin Next proxy first: `/api/proxy/...`. The web server forwards to `SERVER_API_URL`, which Docker Compose defaults to `http://server:4000`.
- Direct browser-host `:4000` and baked `NEXT_PUBLIC_API_URL` are retained only as fallbacks. This avoids browser-side failures where `localhost:4000` or a stale LAN IP is unreachable from the user's browser.
- Set `SERVER_API_URL` for the web container when the API is not reachable at `http://server:4000`. Set `NEXT_PUBLIC_API_URL` only when you intentionally want a direct browser fallback.
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

Runtime presets can also define `localWorkspaceRoot` and `localScratchRoot`, the local folders used by agents attached to that runtime for repo clones/caches and temporary task files.
Agent overrides win over runtime presets. When `.env` adapter fallback is enabled, runtime presets win over `.env` defaults.
In production, external adapters (`hermes`, `hermes-ssh`, `hermes-gateway`, `codex-app`, `webhook`, `openclaw`) require a company-scoped runtime preset by default. `.env` adapter fallback is disabled unless `ADAPTER_ENV_FALLBACK_ENABLED=true`, which should be reserved for local development/debugging.
Signup is stored in DB setting `auth.signup_enabled` and defaults to enabled. Admins can turn it on/off in the Web UI `Admin` page.
Adapter egress blocks localhost/link-local metadata targets by default. Set `ADAPTER_TARGET_ALLOWLIST` to comma-separated hostnames or wildcard domains such as `hermes.example.internal,*.agents.example.com` when production should restrict agent runtimes to known hosts.

Production onboarding:

1. Open `/signup` and create the first account. If no active admin exists, that signup becomes global admin and default-company admin.
2. If signup is disabled or a deployment has no active admin, set `BOOTSTRAP_TOKEN` temporarily and call `POST /api/auth/bootstrap` with the token, email, name, and password. Bootstrap only works while no active admin exists. `/api/auth/signup` also accepts `bootstrapToken`, `token`, or `X-MegaCorps-Bootstrap-Token` for the same no-active-admin recovery case.
3. Open `Admin` to manage all accounts, roles, account status, password resets, and the DB-backed signup switch.
4. Later users can self-signup while signup is enabled, or accept `/signup?invite=...` invite links from an admin.
5. Existing users receiving invites get the new membership but must log in with their existing password.

Common login/onboarding errors:

- `signup_disabled`: signup was turned off from the `Admin` page. Use an invite link or ask an admin to re-enable signup.
- `user_disabled`: the account was disabled from the `Admin` page.

Supported runtime fields:

- `mock`: no endpoint needed.
- `hermes`: `portainerUrl`, `portainerUser`, `portainerPass`, `portainerEndpointId`, `hermesContainer`, `megacorpsApiUrl`.
- `hermes-ssh`: `sshHost`, `sshUser`, `sshPort`, `sshKeyPath`, `sshOptions`, `hermesCommand`, `megacorpsApiUrl`.
- `hermes-gateway`: `hermesGatewayUrl`, `hermesDashboardToken`, `megacorpsApiUrl`.
- `codex-app`: `codexTransport`, `codexCommand`, `codexArgs`, `codexAppServerUrl`, `codexWsToken`, `codexModel`, `codexCwd`, `codexSandbox`, `codexExperimentalApi`.
- `webhook`: `webhookUrl`.
- `openclaw`: `openclawUrl`.

`megacorpsApiUrl` is the MegaCorps API base URL agents use for task-complete callbacks. Legacy `publicApiUrl`, `callbackUrl`, and `webhookBaseUrl` config keys are still accepted for existing runtimes, but new presets should use `megacorpsApiUrl`.
Hermes CLI adapters invoke one-shot prompts as `hermes -z "<prompt>" --profile <profile>`. They intentionally do not pass `--reasoning-effort`, `--max-turns`, or a bare prompt argument; Hermes v0.15.2 rejects unsupported flags and treats bare prompt text as unrecognized arguments. Configure provider/model reasoning behavior inside the Hermes profile/config instead.
For Hermes Portainer, the agent still needs a `hermesProfile`; the runtime tells MegaCorps where to execute it.
For Hermes SSH, create a runtime preset with `adapterType=hermes-ssh`, set `sshHost` to your Hermes host, set the SSH user/key path reachable inside the server container, and set each agent's `hermesProfile` to the Hermes profile name such as `alice`. The SSH user defaults to `root` and can be overridden. The deploy compose mounts persistent SSH keys at `/home/megacorps/.ssh`, with `/home/megacorps/.ssh/id_ed25519` as the default key path. SSH dispatch imports `/proc/1/environ` before running Hermes so container-level provider API keys remain visible to the SSH session.
For Codex App Server, create a runtime preset with `adapterType=codex-app`. Stdio mode launches `codex app-server` by default; WebSocket mode uses `codexAppServerUrl` and should use a bearer/capability token. Codex agents should set `soul`, because MegaCorps owns the agent identity/personality/work style instead of relying on a Hermes profile. Direct Chat keeps one Codex thread per chat session. Kanban keeps one Codex thread per card, agent, and dispatch/review kind; every retry or continuation is a new turn in that thread.
For Hermes HTTP API and Webhook/OpenClaw, the URL lives in the runtime preset or the agent override panel.
Task-complete webhooks require `WEBHOOK_SHARED_SECRET` or DB setting `webhook.shared_secret` with at least 16 characters. MegaCorps injects the configured secret into dispatched agent prompts as `X-MegaCorps-Webhook-Secret`.

Hermes suite operational notes:

- Prefer a Hermes suite image with `openssh-server` preinstalled for production. Installing it in the Hermes entrypoint works for debugging, but it slows every restart and is external to this MegaCorps image.
- Verify the Hermes profile used by each MegaCorps agent has provider/model/API-key state available inside hermes-suite. For example: `hermes --profile alice config get provider`, `hermes --profile alice config get model`, and `cat /root/.hermes/profiles/alice/.env`.

## Web UI pages

- `Dashboard`: operating overview, stage counts, recent task logs, recent API lifecycle events.
- `Companies`: pure company CRUD plus company goals.
- `Departments`: department management, direct agent membership assignment, reporting-line editing, clickable org canvas agent editing, and department goals.
- `Agents`: member hierarchy, guided agent creation, pause/resume/fire/reset, runtime and adapter configuration.
- `Projects`: unified project authority workbench for project CRUD, repo settings, branch policy, runtime services, work path, and project goals.
- `Workspace`: company folder manager and authoritative workspace paths for non-coding project files.
- `Knowledge`: company-scoped Markdown docs injected into agent prompts by tag.
- `Kanban`: task UUIDs, stage columns, company dropdown/project/assignee filters, sort by company/date/priority, ticket thread, work products, sub-tasks, logs, run/review/decompose/delete.
- `Direct Chat`: company -> project/no-project -> agent -> session direct messaging with resumable adapter sessions.
- `Cron`: dispatch heartbeat status, company intervals, job/company/runner-scoped manual runs, daily-report/health-check run records, and run history.
- `Logs`: cron heartbeat status, heartbeat runs, activity, and full API lifecycle log with request, response, status, duration, and errors.
- `Admin`: tabbed global account management, signup switch, invites, roles, account status, and password resets.
- `Settings`: tabbed runtime presets, company settings, departments, company members, and advanced configuration.
- `Budget`: direct governance route for budget policies, approvals, spend, and cost events. It is intentionally outside the primary sidebar while the IA is focused on company/department/project/workspace operations.
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
- Phase 16: help/escalation review via `needs_review`, company/department/project goals, project-scoped Direct Chat, and the Projects/Workspace split.
- Phase 17: React Query browser cache plus authenticated WebSocket live events for chat, Kanban card updates, task logs, comments, projects, goals, and work products.
- Phase 18: repo-centric project workspace policy with project-level `repoUrl` and `workPath`, pull-before-run/push-after-run prompt protocol, and first-class task work products for PRs, commits, previews, reports, screenshots, and artifacts.
- Phase 19: Codex app-server adapter, platform-owned agent `soul`, and durable adapter session records for direct chat and task-scoped Codex threads.

Reference-informed next phases:

- Phase 20: dependency/blocker graph with derived ready state and richer handoff records.
- Phase 21: company template import/export with secret references.
- Phase 22: worker sidecar, distributed queue locks, and richer runtime liveness probes.

## Paperclip-inspired loop

MegaCorps follows the same control-plane idea as Paperclip: manage goals and an org chart, not individual terminal sessions. A company owns departments, agents, tasks, goals, and dispatch settings. Agents report through an O-chart (`bossId`) and can be grouped by department. The Companies page now focuses on company CRUD and company goals; Departments and Agents render the org lanes/tree and agent configuration panels.

The dispatch engine runs on a heartbeat. The global tick defaults to 10 seconds with `DISPATCH_LOOP_INTERVAL_MS=10000`; each company also has `dispatchIntervalSeconds` and `autoDispatchEnabled`. On each company heartbeat:

- scan `todo` Kanban tasks,
- auto-assign unassigned tasks to an active idle agent, preferring department and tag/capability matches,
- enqueue dispatch task-run attempts,
- enqueue review task-run attempts when a reviewer is configured,
- let the task-run worker claim queued work up to `TASK_RUN_WORKER_BATCH_SIZE`, move assigned work into `in_progress`, run the configured adapter, and move completed work to `in_review`, `needs_review`, `done`, or `blocked`,
- hold review task-runs while their card is still `in_progress`, so long-running dispatches do not block unrelated queued work but reviewers do not judge unfinished output,
- distinguish quality review (`in_review`) from help/escalation review (`needs_review`). If an assignee cannot complete a task, the required output is attempted methods, blocker/root cause, reviewer questions, and partial output/logs. MegaCorps queues review when a distinct reviewer/manager exists, otherwise top-level escalations become `blocked`,
- recover expired execution locks; expired `in_progress` work increments `retry_count`, returns to `todo` with backoff, or moves to `blocked` after `max_retries`,
- cascade parent tasks when all sub-tasks are complete.

Cron/debug endpoints:

- `GET /api/help`: machine-readable API catalog for agents and integrations, including response schema examples and rate-limit notes.
- `GET /api/help?format=markdown`: Markdown API catalog with body examples, response examples, and rate-limit notes.
- `GET /api/agent-runtimes/health`: runtime status, attached agent counts, last run state, and adapter capabilities.
- `GET /api/task-runs`: queued/running/completed dispatch and review attempts.
- `GET /api/cron/status`: in-memory scheduler state plus recent durable cron runs.
- `GET /api/cron/runs`: cron run history.
- `POST /api/cron/run`: manually run one cron job. `dispatch-heartbeat` can be scoped to a company and runner metadata; `daily-report` and `health-check` record completed manual runs with company/runner details.
- `POST /api/cards/:id/cancel`: cancel active or queued work without archiving the task history.

## Direct agent chat

Open `Direct Chat` in the sidebar:

1. Pick a company.
2. Pick a project, or `No project` for general chat.
3. Pick an agent in that company.
4. Select an existing session or create a new session.
5. Send a message.

Every chat session stores its own `agentSessionId` and optional `projectId`, so a user can keep several separate conversations with the same agent by project or no-project context. Adapters that need richer turn identity, such as Codex app-server, also write durable rows to `adapter_sessions`. Chat messages are stored in `chat_messages`, sessions in `chat_sessions`, and every agent reply is also recorded through `heartbeat_runs`, `activity_log`, and `cost_events`. The UI shows the user's outgoing message optimistically and displays an agent typing indicator while the adapter run is still pending.
The web app uses React Query plus an authenticated `/api/live` WebSocket to invalidate chat session/message caches as soon as the server stores user, agent, or system messages. This makes outgoing messages appear immediately and keeps other open browser tabs in sync without manual refresh.

## Task message board and intervention

Open a task and use the Message Board tab:

- `Comment only`: add audit/context.
- `Agent note`: leave a task message as a specific agent.
- `Stop agent now and block task`: mark the task blocked and pause the assignee.
- `Escalate to reviewer`: move the task to `needs_review` and queue help review when an independent reviewer/manager exists; otherwise block the task.
- `Send comment to agent context`: queue the instruction for the next run prompt.
- `Continue run with comment`: reactivate the assignee and move the task back to `todo`.

Dispatch/review/webhook completions now also create agent-authored messages on the task board, so task discussion is not hidden only in logs.
Kanban task detail tabs use React Query plus a short-lived browser session cache for message board, task logs, work products, and filtered API lifecycle rows. Selecting a task renders details immediately, then prefetches cached tab data in the background; live events invalidate only the affected card caches.

## Projects, workspace paths, and work products

Projects are repo/workspace-centric. MegaCorps stores the shared Git repository and project work area, while each remote agent runtime uses its own local clone/folder. A project can define `repoProvider`, `repoUrl`, project-level `workPath`, `defaultBranch`, protected branches, `workBranchPattern`, pull-before-run, push-after-run, completion policy, setup command, test command, runtime service metadata, and an optional runtime-local workspace hint. Runtime presets define the machine-local `localWorkspaceRoot` and `localScratchRoot` used by agents attached to that runtime.

`repoUrl` is the shared Git remote. `workPath` is the repo/workspace-relative path agents should focus on, such as `apps/server`, `reports/final`, or `docs/contracts`; null means project root. `workspacePathHint` is only a local clone/folder hint for a runtime and is not the source of truth. `localWorkspaceRoot` is the runtime's persistent clone/cache root; `localScratchRoot` is for temporary task files. Prompt injection tells agents to pull/rebase before editing, stay inside the project work path unless the task explicitly requires broader edits, work on a task branch, avoid protected branches, validate, then push or open a PR according to the project policy. Final deliverables should be reported as work products, URLs, PRs, commits, or artifacts rather than runtime-local file paths.

The `Projects` page owns project CRUD, repo settings, branch policy, runtime services, and project goals. The `Workspace` page is separate: it is the company folder manager and authority path surface for non-coding project files, using `/workspaces/{company-slug}/...` paths rather than pretending runtime-local folders are shared truth.

Task outputs are no longer limited to comments/logs. `work_products` records reviewable deliverables such as PRs, commits, preview URLs, reports, screenshots, files, artifacts, and external links. The task-complete webhook accepts a `workProducts` array, and Kanban task details include a Work Products tab so reviewers can inspect the actual deliverable instead of reading logs only.

`Split into Sub-tasks` decomposes a larger task into child Kanban tasks. It uses the task body lines when available, otherwise it creates Plan / Execute / Review sub-tasks.

## Agent invocation context

Every task dispatch, review, and direct chat invocation receives a bounded Kanban context snapshot:

- company mission/settings,
- company, department, and project goals,
- compact same-company Kanban board snapshot,
- focus task details,
- parent/child/dependency task context,
- focus agent open work and review queue,
- focus agent soul/personality/work style when configured,
- latest task message board entries,
- latest task lifecycle logs,
- project repository policy, project work path, and Git workflow instructions,
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
- `adapter_sessions`: adapter-native session/thread continuity by scope, currently used for Codex app-server direct chat and card-scoped dispatch/review threads.
- `card_comments`: per-task message board entries from users, agents, system/webhook completions, and intervention actions.
- `work_products`: reviewable deliverables by card/project/agent/task-run, including repo URLs, branches, commits, PRs, previews, reports, screenshots, artifacts, and external URLs.

Phase 8/9 safety behavior:

- A task must acquire an execution lock before an adapter run starts.
- Expired locks are recovered by the dispatch loop, write `lock_expired/warning`, increment `retry_count`, schedule the next run with backoff, and move the card to `blocked` after `max_retries`.
- Adapter `success:false` now goes through retry/block handling instead of silently marking work done.
- Budget policies can hard-stop an agent when monthly or per-task limits are reached.
- Tasks requiring approval create pending approval records and can be approved/rejected from the Budget page.
- Member hierarchy is based on `bossId`: the identity label is free text, while the important control-plane relation is who a member reports to and who reports to them.
- Decomposed sub-tasks are delegated to direct reports when the parent task is assigned to a member with subordinates.
- Work completed by a subordinate moves to `in_review` for a distinct configured reviewer or reporting manager. Self-review is not treated as a real review gate; if no distinct reviewer is available, successful dispatch goes directly to `done`.
- Work the assignee cannot solve moves to `needs_review` for a help/escalation review when an independent reviewer or manager exists. Reviewers can finish directly (`done`), return guidance (`todo`), or escalate to their manager. If a top-level reviewer cannot solve it, the card becomes `blocked`.
- In-app IP rate limiting is enabled by default. Tune `RATE_LIMIT_*` env vars or set `RATE_LIMIT_ENABLED=false` for local stress tests.
- Mutation/manual execution routes require operator/admin roles. Viewer role can read authenticated UI data.
- Task completion webhooks require `WEBHOOK_SHARED_SECRET` or DB setting `webhook.shared_secret` with at least 16 characters and must send either `X-MegaCorps-Webhook-Secret` or `Authorization: Bearer`. Agent prompts include `taskRunId`; repeated webhook completions with the same `taskRunId` return `duplicate: true` and do not re-write cost, comments, or stages. A webhook `status=done` updates the card stage, clears active execution locks, and is protected from being overwritten by a late dispatch/review return. `status=needs_review` queues help review when possible. `status=in_progress` is a progress update and does not release the active run.
- Monthly agent spend resets on `BUDGET_RESET_DAY` UTC, default day 1, and the reset is marked in `cron_runs`.
- Company membership rows scope visible companies and company-owned entities. Company operators/admins can mutate company data; company admins can manage memberships.
- Manual Run/Review and cron dispatch enqueue `task_runs`; the in-process worker claims queue capacity without waiting for every active adapter call to finish and records linked `heartbeat_runs`.

No pnpm. No Redis.

## Production launch checklist

- Put the app behind TLS, a reverse proxy, and external rate limits in addition to the in-app limiter.
- Set strong `WEBHOOK_SHARED_SECRET`, SSH keys, and external database credentials. Use `BOOTSTRAP_TOKEN` only temporarily for admin recovery, then remove it. The session signing secret is generated automatically into DB `app_settings.auth.jwt_secret`.
- Encrypt or externalize adapter/runtime secrets before multi-user production.
- Move the current in-process DB task-run worker into a separate sidecar/replica-safe worker for heavy production usage.
- Extend company-scoped membership/RBAC with invite flow, service-agent keys, and emergency break-glass admin policy.
- Add database backup/restore, retention, migration rollback, metrics, alerts, and incident runbooks.

## Latest local verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- Temporary Next production route smoke on `http://localhost:3021`: `/projects`, `/agents`, `/departments`, `/cron`, `/kanban`, and `/api/proxy/health`; temporary server stopped afterward.
- Previous authenticated API smoke baseline: runtime, department, agent, project, goal, knowledge doc, task, comment, manual run, dashboard, logs.
- Previous full web route smoke baseline: `/dashboard`, `/companies`, `/departments`, `/agents`, `/projects`, `/workspaces`, `/knowledge`, `/kanban`, `/chat`, `/cron`, `/logs`, `/admin`, `/settings`, `/help`, plus the direct `/budget` governance route.
