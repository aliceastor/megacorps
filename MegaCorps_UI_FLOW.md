# MegaCorps UI Flow

Generated: 2026-06-08

This document is a textual inventory of every current web UI surface, including route pages, shell controls, drawers, modal overlays, confirmation dialogs, tabs, and major page elements. It also records the DB/API alignment audit performed during this pass.

## Global Shell

Routes inside the app shell use `apps/web/src/components/shell.tsx`.

Primary navigation:
- Dashboard: `/dashboard`
- Companies: `/companies`
- Direct Chat: `/chat`
- Kanban: `/kanban`
- Agents: `/agents`
- Budget: `/budget`
- Logs: `/logs`
- Knowledge: `/knowledge`
- Workspaces: `/workspaces`

Utility navigation:
- Help: `/help`
- Settings: `/settings`
- Admin: `/admin`, visible only when `/api/me` returns global role `admin`

Persistent elements:
- Sidebar collapse/expand button
- MegaCorps brand link
- Theme toggle
- Language selector
- User menu with logout
- Heartbeat/status text
- Live event listener provided by the app shell; pages can react to `megacorps-live` events.

## Public/Auth Flow

### `/`

Behavior:
- Redirects to `/dashboard`.

### `/login`

Data sources:
- `GET /api/auth/status`
- `POST /api/auth/login`

Elements:
- Email input
- Password input
- Login button
- Status/error text
- Signup link when signup is enabled or the next signup will bootstrap admin
- Redirect handling via `next` query parameter

No modal overlays.

### `/signup`

Data sources:
- `GET /api/auth/status`
- `POST /api/auth/signup`
- `POST /api/auth/accept-invite`

Elements:
- Invite-token mode when `?invite=` is present
- Name input
- Email input, hidden in invite mode
- Password input
- Create account / Accept invite button
- Signup disabled warning
- Bootstrap admin notice when applicable
- Link back to login

No modal overlays.

### Error Boundary

Route:
- `apps/web/src/app/error.tsx`

Elements:
- Error title
- Recovery/retry affordance

## Dashboard

Route:
- `/dashboard`

Data source:
- `GET /api/dashboard`

Elements:
- Stat cards: companies, open tasks, completed tasks, blocked tasks, active agents, busy agents, active runs, pending approvals, budget policies, monthly cost
- API Help card linking to `/help`
- Markdown/API entrypoint link
- Kanban stages summary
- Recent task activity
- Recent API events

No modal overlays.

## Companies

Route:
- `/companies`

Component:
- `OrgChart` with `surface="companies"`

Data sources:
- `GET /api/agents`
- `GET /api/companies`
- `GET /api/departments`
- `GET /api/agent-runtimes`
- `GET /api/cards`
- `GET /api/approvals?status=pending`
- `POST /api/companies`
- `PUT /api/companies/:id`
- `POST /api/departments`
- Agent action endpoints shared with `/agents`

Elements:
- Company registry list
- New Company button
- Company settings: company selector, company name, dispatch interval seconds, auto-dispatch toggle, mission textarea, Save Company
- Department settings: new department name, department slug, Add Department, department list
- Lifecycle closure summary: top members, middle layer, leaf executors, pending approvals
- Top-down queue list
- Bottom-up review list
- Agent quick-create strip
- Department org lanes
- Unassigned department lane
- Selected agent detail panel with full agent editor and actions

Inline selected-agent panel elements:
- Effective adapter config summary, including runtime-inherited values and per-agent overrides
- Name, slug, identity label, title, profile
- Adapter and runtime preset selectors
- Department and reports-to selectors
- Capabilities, per-task budget, monthly budget
- Soul textarea
- Adapter override fields, adapter-type aware
- Direct reports, assigned work, review queue
- Save, Test, Pause/Resume, Reset Session, Fire

Dialogs:
- Fire uses direct action; no confirmation dialog currently.
- Toast notifications appear for create/save/test/pause/resume/reset/delete outcomes.

## Agents

Route:
- `/agents`

Component:
- `OrgChart` with `surface="agents"`

Data sources:
- Same agent/company/runtime/card/approval sources as `/companies`

Elements:
- Company context selector
- Agent quick-create strip:
  - Agent name
  - Slug
  - Profile
  - Identity label
  - Title
  - Soul/work style
  - Capabilities
  - Per-task budget USD
  - Monthly budget USD
  - Department
  - Reports to
  - Adapter
  - Runtime preset
  - New button
- Department org lanes
- Unassigned department lane
- Selected agent detail panel as described above

No separate modal overlay.

## Direct Chat

Route:
- `/chat`

Data sources:
- `GET /api/companies`
- `GET /api/projects`
- `GET /api/agents`
- `GET /api/chat/sessions`
- `GET /api/chat/sessions/:id/messages`
- `POST /api/chat/sessions`
- `POST /api/chat/sessions/:id/messages`

Elements:
- Three-column chat layout
- Companies/projects/agents rail:
  - Company selector
  - Project filter: all projects, no project, or a specific project
  - Agent list
- Sessions rail:
  - Existing chat sessions
  - New session icon button
- Chat thread:
  - Selected agent/session header
  - Message list
  - Optimistic outgoing user message
  - Agent typing/generating indicator
  - Message composer textarea
  - Send button

No modal overlays.

## Kanban

Route:
- `/kanban`

Data sources:
- Board load: `GET /api/cards`, `/api/agents`, `/api/companies`, `/api/departments`, `/api/projects`, `/api/goals`
- Card update: `PUT /api/cards/:id`
- Task run: `POST /api/cards/:id/run`
- Review: `POST /api/cards/:id/review`
- Decompose: `POST /api/cards/:id/decompose`
- Cancel: `POST /api/cards/:id/cancel`
- Delete/archive: `DELETE /api/cards/:id`
- Comments: `GET/POST /api/cards/:id/comments`
- Logs: `GET /api/cards/:id/logs`
- API event related lookup: `GET /api/system-logs`
- Work products: `GET/POST /api/cards/:id/work-products`

Top toolbar elements:
- Search input
- Status filter
- Assignee filter
- Project filter: all projects, no project, specific project
- Refresh button
- New Card button

Board elements:
- Columns: `todo`, `in_progress`, `in_review`, `needs_review`, `done`, `blocked`, `cancelled`
- Draggable cards
- Card badges: requires review, retry count, cost, tags
- Priority color/label

### Kanban Modal: New Card

Overlay:
- `overlay` + `modal`

Elements:
- Title input
- Description textarea
- Company selector
- Department selector
- Project selector
- Goal selector, scoped by company/department/project
- Assignee selector, company-scoped
- Reviewer selector, company-scoped
- Priority selector
- Tags input, comma-separated
- Dependencies multi-select, company-scoped
- Requires approval checkbox
- Create button
- Close button

Writes:
- `POST /api/cards`

### Kanban Drawer: Card Detail Panel

Drawer tabs:
- Details
- Message board
- Logs
- Work products
- Subtasks

Details tab elements:
- Title input
- Stage selector
- Full Detail textarea
- Assignee selector
- Reviewer selector
- Department selector
- Project selector
- Goal selector
- Priority selector
- Tags input
- Dependencies multi-select
- Max retries input
- Requires approval checkbox
- Metadata grid: UUID, stage, priority, cost, session, retries, active run, execution lock
- Review feedback output
- Actions: Save, Revert, Run Now, Review, Split into Sub-tasks, Pause with Comment, Cancel Task, Delete Task

Message board tab elements:
- Author selector: user or company agent
- Action selector: comment only, agent note, stop agent and block task, escalate to reviewer, send to agent context, continue run
- Message textarea
- Add Message button
- Cached message list

Logs tab elements:
- Latest execution output
- Cached task logs
- Related API lifecycle events
- Loading/refreshing indicators

Work products tab elements:
- Add Work Product form:
  - Type
  - Title
  - URL
  - Pull request URL
  - Repo provider
  - Repo URL
  - Branch
  - Commit SHA
  - Summary
  - Add work product button
- Work product list with PR/URL/commit open button

Subtasks tab elements:
- Subtask rows
- Row click switches selected card

Dialog/confirmation:
- Delete Task uses `window.confirm`.
- Toast notification appears for create/update/run/review/decompose/comment/work-product/cancel/delete outcomes.

Cache/live behavior:
- Card comments, logs, API logs, and work products are cached in browser `sessionStorage`.
- React Query is used for board and tab data.
- Live events refresh card comments, task logs, work products, and board state.

## Budget

Route:
- `/budget`

Data sources:
- `GET /api/agents`
- `GET /api/cards`
- `GET /api/companies`
- `GET /api/dashboard`
- `GET /api/cost-events`
- `GET /api/budget-policies`
- `GET /api/approvals?status=pending`
- `POST /api/budget-policies`
- `PUT /api/budget-policies/:id`
- `DELETE /api/budget-policies/:id`
- `PUT /api/approvals/:id`

Elements:
- Stat cards: total recorded cost, policies, pending approvals, cost events
- New/Edit budget policy form:
  - Company
  - Agent scope
  - Name
  - Monthly limit USD
  - Per-task limit USD
  - Warn at percent
  - Hard stop checkbox
  - Policy active checkbox
  - Save policy
  - New/reset button when editing
- Agent budgets list with utilization bar
- Active policies list with edit/delete actions
- Pending approvals list with approve/reject
- Recent cost events
- Recent task costs

Dialog/confirmation:
- Delete policy uses `window.confirm`.
- Toast/status pill appears for save/delete/approval decisions.

## Logs

Route:
- `/logs`

Data sources:
- `GET /api/system-logs`
- `GET /api/activity`
- `GET /api/heartbeat-runs`
- `GET /api/task-runs`
- `GET /api/cron/status`
- `POST /api/cron/run`

Elements:
- Filter logs input
- Cron heartbeat card:
  - Status
  - Run now button
  - Interval
  - Last started/completed
  - Error
  - Recent cron run details
- Activity list
- Task runs list:
  - Card ID
  - Agent ID
  - Attempt
  - Cost/duration
  - Heartbeat run ID
  - Adapter session ID
  - Adapter turn ID
  - Error
- Heartbeat runs list
- API lifecycle list with request/response payloads

No modal overlays.

## Knowledge

Route:
- `/knowledge`

Data sources:
- `GET /api/companies`
- `GET /api/knowledge-docs`
- `POST /api/knowledge-docs`
- `PUT /api/knowledge-docs/:id`
- `DELETE /api/knowledge-docs/:id`

Elements:
- New doc button
- Company selector
- Title input
- Tags input
- Markdown body textarea
- Save knowledge doc button
- Company docs list with Edit and Delete

Dialog/confirmation:
- Delete uses `window.confirm`.

## Workspaces

Route:
- `/workspaces`

Data sources:
- `GET /api/companies`
- `GET /api/departments`
- `GET /api/projects`
- `POST /api/projects`
- `PUT /api/projects/:id`
- `GET /api/goals`
- `POST /api/goals`

Elements:
- Company selector
- Project list:
  - No project row
  - Project rows
- Project editor:
  - Project name
  - Description
  - Repo provider
  - Default branch
  - Repository URL
  - Project work path
  - Protected branches
  - Work branch pattern
  - Pull before every run checkbox
  - Push after completion checkbox
  - Completion policy
  - Setup command
  - Test command
  - Runtime services JSON
  - Runtime-local path hint
  - Add project / Save project
- Repository Protocol summary
- Goal Scope form:
  - Scope selector: company, department, project
  - Department selector when department scope
  - Selected project display when project scope
  - Goal title
  - Goal body
  - Add goal
- Effective Goals list

No modal overlays.

## Settings

Route:
- `/settings`

Data sources:
- `GET/POST/PUT/DELETE /api/agent-runtimes`
- `GET /api/agent-runtimes/health`
- `GET/POST/PUT /api/companies`
- `GET/POST /api/departments`
- `GET/POST/PUT /api/company-memberships`
- `DELETE /api/company-memberships/:id`

Elements:
- Agent runtimes editor:
  - Runtime company
  - Runtime name
  - Adapter type
  - Local workspace root
  - Local scratch root
  - Active checkbox
  - Adapter-specific config fields:
    - Hermes Portainer fields
    - Hermes SSH fields
    - Hermes Gateway fields
    - Codex App Server fields
    - Webhook/OpenClaw fields
  - Advanced config JSON
  - Save runtime
  - Runtime list with Edit/Delete
- Runtime health summary
- Company settings:
  - Company selector
  - Company name
  - Mission
  - Dispatch interval seconds
  - Auto dispatch checkbox
  - Save company
  - New department fields and Add department
  - Department list
- Company members:
  - Email/User selector
  - Role selector
  - Status selector
  - Add/update member
  - Member list with role update and disable action

Dialog/confirmation:
- Delete runtime uses `window.confirm`.
- Toast/status pill appears for save/delete/member actions.

## Help

Route:
- `/help`

Data sources:
- `GET /api/help`
- `GET /api/help.md`

Elements:
- Search input
- API stat cards
- Agent API entrypoint panel
- Copy/open endpoint affordances
- Grouped endpoint cards:
  - Method
  - Path
  - Auth
  - Required role
  - Params
  - Query
  - Body
  - Response
  - Schema
  - Example
  - Rate limit
  - Notes

No modal overlays.

## Admin

Route:
- `/admin`

Data sources:
- `GET /api/admin/settings`
- `PUT /api/admin/settings`
- `GET /api/admin/users`
- `PUT /api/admin/users/:id`
- `GET /api/companies`
- `POST /api/auth/invites`

Elements:
- Signup control:
  - Signup enabled checkbox
  - Save settings
  - Bootstrap admin note
- Account summary:
  - Total accounts
  - Active admins
  - Signup status
- Company Invite:
  - Company selector
  - Email input
  - Name input
  - Company role selector
  - Expires in days
  - Create invite
  - Copy accept URL
  - Last invite metadata: email, role, status, expiry, accept URL, raw token
- Accounts list:
  - Email and UUID
  - Name input
  - Global role selector
  - Status selector
  - Reset password input
  - Company membership badges
  - Save account button

No modal overlays.

## UI / DB / API Alignment Audit

This pass compared UI fields with the shared schemas, API route handlers, and DB schema.

### Fixed during this pass

The following backend-supported fields or actions were missing or incomplete in the UI and are now surfaced:

- `agents.capabilities`: added to shared schema, server create/update routes, API help, agent quick-create UI, and selected-agent edit UI.
- `agents.budget_per_task`: added to agent quick-create UI and selected-agent edit UI.
- `projects.protected_branches`: added to Workspaces project editor and Repository Protocol summary.
- `projects.runtime_services`: added to Workspaces project editor as validated JSON.
- Workspaces No Project reset: now resets `workPath`, protected branches, and runtime services state.
- `budget_policies.warn_at_percent`, `hard_stop`, `is_active`: added to Budget policy form.
- `PUT/DELETE /api/budget-policies/:id`: added edit/delete controls to Budget.
- `user_invites`: added Admin Company Invite form with accept URL/token display.
- `kanban_cards.priority`, `tags`, `dependency_card_ids`: added to New Card modal and Details tab.
- `POST /api/cards/:id/work-products`: added Work Products form in Kanban detail drawer.
- `task_runs.adapter_session_id`, `adapter_turn_id`: added to Logs task run cards.
- `POST /api/agents` help body: updated with `capabilities`.

### No unsupported UI writes found

After the patch, the visible form fields reviewed in this pass write to existing API endpoints and schema-backed payloads. No obvious UI control was found that writes a field the backend rejects or ignores.

### Intentionally system-only or indirect

These DB surfaces are intentionally not presented as primary editable UI fields:

- `users.password_hash`: only reset through Admin password field.
- `user_invites.token_hash`: raw invite token is returned once; only hash is stored.
- `app_settings`: only `signup_enabled` is surfaced; other future settings should get explicit controls before use.
- `groups`: present in DB, not part of the current active UI model.
- `api_events`: inspected through Logs/API lifecycle, not editable.
- `cron_runs`: inspected through Logs/Cron heartbeat, not editable.
- `activity_log`: inspected through Dashboard/Logs, not editable.
- `adapter_sessions`: indirectly visible through task run adapter session/turn IDs; direct session management is via agent Reset Session.
- `heartbeat_runs` and `task_runs`: visible through Logs/Kanban, normally controlled by run/review/cancel/retry flows rather than manual field editing.
- `cost_events`: visible in Budget, not editable.
- `approvals`: visible in Budget and acted on through approve/reject, not arbitrary field editing.

### Refactor candidates

These are not bugs, but they are likely places to simplify the future UI:

- Companies and Agents share `OrgChart`; this is efficient but makes the component large. Split into `CompanyRegistry`, `AgentCreateBar`, `OrgLanes`, and `AgentDetailPanel` before major redesign.
- Settings and Companies both edit company/departments. Decide whether Settings should remain operational config only, with company structure owned by Companies.
- Admin and Settings both touch membership-related flows. Admin now owns global accounts/invites; Settings owns company membership maintenance.
- Kanban detail drawer is now feature-complete but dense. A future redesign should split Details into task metadata, execution controls, review/escalation, and evidence/work product sections.
