# MegaCorps Progress and Research Notes

Last updated: 2026-06-05

## Executive Summary

MegaCorps is now a working control-plane MVP for AI-agent companies. The product direction is intentionally close to Paperclip: manage companies, goals, org charts, departments, tickets/tasks, heartbeats, budgets, logs, and governance instead of manually babysitting individual agent sessions.

The current local stack runs with Docker:

- Web UI: `http://localhost:3000`
- API: `http://localhost:4000`
- Database: PostgreSQL in Docker

Latest verified baseline:

- Phase 1-4 core flows are implemented.
- Phase 5-6 foundation is partially implemented.
- Company setup, department setup, O-chart, comments, task intervention, lifecycle logs, and automatic dispatch heartbeat are implemented.
- Docker CI builds have passed for server and web.

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

Current behavior:

- `mock` completes local smoke tasks.
- Hermes adapter stores session id, cost, duration, and output.
- Review loop can reject or approve based on reviewer output.

Gaps:

- Long-running async worker sidecar is still future work.
- Queue-based concurrency is not yet implemented.
- Atomic DB execution locks are not yet implemented.

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

Recently verified:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `docker compose up -d --build`
- API health: `GET /health`
- Web login page: `GET http://localhost:3000/login`
- Signup validation error shape.
- Company + department + agent creation.
- Backlog task auto-assignment.
- Mock agent auto-dispatch to done.
- Comment-to-agent context log.
- Docker compose server/web/postgres health.

Known local warning:

- On Windows, Next sometimes warns that the native SWC binary is not a valid Win32 application. The build falls back and exits successfully.

## Gap Analysis Against Paperclip

Implemented or partially implemented:

- Company control plane.
- Department and O-chart basics.
- Kanban/ticket board.
- Heartbeat dispatch.
- Bring-your-own-agent adapter shape.
- Basic budgets on agents.
- Pause/resume/fire governance.
- Task comments and intervention.
- Task and API logs.
- Sub-task creation and parent cascade.

Still missing:

- Strong multi-company data isolation enforcement in every endpoint.
- Company/project/goal ancestry in every prompt.
- Atomic execution locks / no double-work guarantee.
- Async worker sidecar for long-running Hermes jobs.
- Queue and retries with BullMQ/Redis or equivalent.
- Runtime health checks and agent runtime registry details.
- Immutable event bus separate from task/API logs.
- Cost events and budget policy enforcement.
- Approval queue UI.
- Knowledge base CRUD and tag-based injection.
- Project workspaces, git worktrees, branches, commits, and merge/review flow.
- Work products and attachments.
- Company template import/export with secret scrubbing.
- Plugin architecture.
- Mobile-first/polished operations UI.

## Recommended Next Phase

Phase 7 should focus on the missing control-plane backbone rather than cosmetic UI:

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

3. Goal/project context:
   - inject company mission, project, goal, dependency summaries, comments, and previous work into prompts

4. Budget policies:
   - `cost_events`
   - `budget_policies`
   - 80% warning
   - 100% hard stop

5. Agent runtime health:
   - runtime status
   - last heartbeat
   - version/capabilities
   - disable routing to offline runtimes

6. Workspaces:
   - project workspace path
   - agent branch/worktree
   - output/work-product tracking

7. Approval queue:
   - all tasks requiring human approval
   - reviewer output
   - approve/reject with feedback

8. Knowledge base:
   - markdown docs
   - tags
   - auto-injection into prompts

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

## Source Links

- Paperclip GitHub: https://github.com/paperclipai/paperclip
- Paperclip README: https://github.com/paperclipai/paperclip/blob/master/README.md
- MegaCorps GitHub: https://github.com/aliceastor/megacorps
