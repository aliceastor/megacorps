# MegaCorps Phase 1-6 Control Plane MVP

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

## Scripts

- `npm run test`
- `npm run typecheck`
- `npm run build`

## Current scope

- Phase 1: auth endpoints, login/signup screens, shell, dashboard, theme toggle, locale string foundation.
- Phase 2: card CRUD, status transition validation, board UI, detail panel, Run Now button.
- Phase 3: agent CRUD, org chart, Portainer-backed Hermes adapter, assign/run storage.
- Phase 4: dispatch loop, review loop, retries, stage history, sub-task decomposition, execution logs.
- Phase 5: governance basics, agent pause/resume/fire, monthly budgets, API lifecycle logs.
- Phase 6: card comments, send-comment-to-agent context, stop-agent/comment/continue-run flow, company and department setup.

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

No pnpm. No Redis.
