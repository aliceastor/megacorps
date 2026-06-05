# MegaCorps Progress and Research Notes

Last updated: 2026-06-05

## Executive Summary

MegaCorps is now a working control-plane MVP for AI-agent companies. The product direction is intentionally close to Paperclip: manage companies, goals, org charts, departments, tickets/tasks, heartbeats, budgets, logs, and governance instead of manually babysitting individual agent sessions.

The current local stack runs with Docker:

- Web UI: `http://localhost:3000`
- API: `http://localhost:4000`
- Database: PostgreSQL in Docker

Latest verified baseline:

- Phase 1-7 operational MVP flows are implemented.
- Company setup, department setup, O-chart, runtime presets, adapter endpoint configuration, comments, task intervention, lifecycle logs, knowledge docs, project/goal context, and automatic dispatch heartbeat are implemented.
- Local Docker deploy is running on `http://localhost:3000` and `http://localhost:4000`.
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

### Task Comments and Intervention

Implemented `card_comments` with these actions:

- `comment`: record context only.
- `pause_agent`: pause the assigned agent, mark the task blocked, write logs.
- `send_to_agent`: store instruction and queue it for agent context.
- `continue_run`: reactivate the assignee and move task back to `todo`.

Agent dispatch prompts now include recent task comments, so user instructions can reach the agent on the next run.

### Agents, Company, Department, and O-chart

Implemented:

- Agent CRUD.
- Agent pause/resume/fire/reset-session.
- Company setup UI.
- Company fields:
  - name
  - slug
  - mission
  - `autoDispatchEnabled`
  - `dispatchIntervalSeconds`
- Department creation.
- Agent can belong to a department.
- Agent can report to another agent through `bossId`.
- Agents page groups the O-chart by department and reporting line.
- Agent runtime presets are managed in `Settings -> Agent runtimes`.
- Each agent can select a runtime preset in `Agents`.
- Each agent can override adapter-specific fields without changing the shared runtime preset.

Current O-chart meaning:

- `companyId`: company ownership boundary.
- `departmentId`: functional grouping.
- `bossId`: manager/reporting relationship.
- `role/title`: agent job description.

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
- Atomic DB execution locks are not yet implemented.
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
- `docker compose up -d --build`
- API health: `GET /health`
- Authenticated API smoke:
  - signup/session cookie
  - runtime creation
  - department creation
  - agent creation with runtime
  - project creation
  - goal creation
  - knowledge doc creation
  - task creation with UUID/company/department/project/goal
  - comment queued for agent
  - manual mock dispatch
  - task logs
  - dashboard
  - API lifecycle logs
- Web route smoke:
  - `/dashboard`
  - `/kanban`
  - `/agents`
  - `/budget`
  - `/logs`
  - `/knowledge`
  - `/workspaces`
  - `/settings`
- Docker compose server/web/postgres health.

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
- Dashboard, logs, budget, settings, knowledge, and workspace pages.

Still missing:

- Strong multi-company data isolation enforcement in every endpoint.
- Atomic execution locks / no double-work guarantee.
- Async worker sidecar for long-running Hermes jobs.
- Queue and retries with BullMQ/Redis or equivalent.
- Runtime health checks, last heartbeat, versions, and capabilities.
- Immutable event bus separate from task/API logs.
- Cost events and budget policy enforcement.
- Approval queue UI.
- Project git worktrees, branches, commits, and merge/review flow.
- Work products and attachments.
- Company template import/export with secret scrubbing.
- Plugin architecture.
- Secret encryption/external secret store for adapter credentials.
- End-to-end browser test suite.

## Recommended Production Hardening Phase

The Phase 1-7 operational MVP is usable locally. The next work should harden it for real unattended operation:

1. Immutable event bus:
   - `events` table
   - event type
   - actor
   - company/project/card/agent ids
   - payload
   - created at

2. Execution locking:
   - card execution lock fields
   - prevent double dispatch
   - recover stale locks

3. Runtime health:
   - runtime status
   - last heartbeat
   - version/capabilities
   - disable routing to offline runtimes

4. Budget policies:
   - `cost_events`
   - `budget_policies`
   - 80% warning
   - 100% hard stop

5. Secret handling:
   - encrypt runtime config secrets
   - redact secret-like values in all API responses
   - support external secret references

6. Workspaces:
   - project workspace path
   - agent branch/worktree
   - output/work-product tracking

7. Approval queue:
   - all tasks requiring human approval
   - reviewer output
   - approve/reject with feedback

8. Browser QA:
   - logged-in Playwright flows
   - task drawer interaction tests
   - settings/agent runtime form tests
   - dark-mode contrast snapshots

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
- `task_logs`
- `api_events`
- `agent_runtimes`
- `knowledge_docs`

## Source Links

- Paperclip GitHub: https://github.com/paperclipai/paperclip
- Paperclip README: https://github.com/paperclipai/paperclip/blob/master/README.md
- MegaCorps GitHub: https://github.com/aliceastor/megacorps
