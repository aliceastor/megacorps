# MegaCorps UI Flow

Generated: 2026-06-09

This document is a textual inventory of every current web UI surface, including route pages, shell controls, drawers, modal overlays, confirmation dialogs, tabs, and major page elements. It also records the DB/API alignment audit performed during this pass.

## Global Shell

Routes inside the app shell use `apps/web/src/components/shell.tsx`.

Primary navigation:
- Dashboard: `/dashboard`
- Companies: `/companies`
- Departments: `/departments`
- Agents: `/agents`
- Projects: `/projects`
- Workspace: `/workspaces`
- Knowledge: `/knowledge`
- Kanban: `/kanban`
- Direct Chat: `/chat`
- Cron: `/cron`
- Logs: `/logs`

Utility navigation:
- Help: `/help`, topbar icon
- Settings: `/settings`
- Admin: `/admin`, visible only when `/api/me` returns global role `admin`

Persistent elements:
- Sidebar collapse/expand button
- MegaCorps brand link
- Theme toggle
- Language selector
- User menu with logout
- Heartbeat/status text
- Fixed independent sidebar scroll; content scrolling does not move or reveal empty space below the left rail.
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
- `CompaniesPage`

Data sources:
- `GET /api/companies`
- `GET /api/departments`
- `GET /api/agents`
- `GET /api/projects`
- `GET /api/cards`
- `GET /api/goals`
- `POST /api/companies`
- `PUT /api/companies/:id`
- `DELETE /api/companies/:id`
- `POST /api/goals`

Elements:
- Company list
- New Company button
- Company editor:
  - Company name
  - Slug
  - Dispatch interval seconds
  - Auto-dispatch toggle
  - Mission textarea
  - Save Company
  - Delete Company
- Company Goals panel:
  - Goal title
  - Goal body
  - Add Company Goal
  - Company goal list
- Company stats:
  - Departments
  - Agents
  - Projects
  - Kanban cards
- Links to Departments and Agents pages

Dialog/confirmation:
- Delete Company uses `window.confirm` and only succeeds for an empty company. The API returns `company_not_empty.blocking` when company-owned rows still exist.

## Departments

Route:
- `/departments`

Component:
- `DepartmentsPage`

Data sources:
- `GET /api/companies`
- `GET /api/departments`
- `GET /api/agents`
- `GET /api/goals`
- `POST /api/departments`
- `POST /api/goals`
- `PUT /api/agents/:id`

Elements:
- Company selector
- New department name and slug
- Add Department button, disabled until a company exists and department fields are filled
- Department list, including `No department`
- Member Assignment table:
  - Agent
  - Department selector
  - Reports-to selector
  - Status
- Interactive Org Canvas:
  - All company agents
  - Inline Department selector
  - Inline Reports-to selector
- Department Goals panel:
  - Goal title
  - Goal body
  - Add Department Goal
  - Department goal list
- Selected department/no-department agent cards

## Agents

Route:
- `/agents`

Component:
- `OrgChart` with `surface="agents"`

Data sources:
- Same agent/company/runtime/card/approval sources as `/companies`

Elements:
- Company context selector with existing companies only; no New Company placeholder on the Agents page
- Agent creation panel with New Agent button
- Department org lanes
- Unassigned department lane
- Selected agent detail panel as described above

### Agents Modal: New Agent

Overlay:
- `overlay` + `agent-wizard-modal`

Step 1: Identity
- Name
- Slug
- Title
- Identity label
- Soul/persona
- Capability checkboxes

Step 2: Assignment
- Company
- Department
- Reports to
- Profile

Step 3: Runtime and budget
- Adapter
- Runtime preset
- Per-task budget USD
- Monthly budget USD

Selected-agent panel elements:
- Effective adapter config summary, including runtime-inherited values and per-agent overrides
- Name, slug, identity label, title, profile
- Adapter and runtime preset selectors
- Department and reports-to selectors
- Capabilities, per-task budget, monthly budget
- Soul textarea
- Adapter override fields, adapter-type aware
- Direct reports, assigned work, review queue
- Save, Test, Pause/Resume, Reset Session, Fire

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
- Company dropdown filter
- Assignee filter
- Project filter: all projects, no project, specific project
- Sort selector: priority, company, newest, oldest, updated
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
- Ticket Thread timeline combining comments, task lifecycle logs, and work products
- Author selector: user or company agent
- Action selector: comment only, agent note, stop agent and block task, escalate to reviewer, send to agent context, continue run
- Message textarea
- Add Message button

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

Navigation:
- Direct route only in the current IA. Budget is not in the primary sidebar.

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

## Cron

Route:
- `/cron`

Data sources:
- `GET /api/cron/status`
- `GET /api/cron/runs`
- `GET /api/companies`
- `GET /api/agents`
- `POST /api/cron/run`
- `PUT /api/companies/:id`

Elements:
- Stat cards:
  - Loop status
  - Base interval
  - Running now
  - Last status
- Job selector:
  - Dispatch Heartbeat
  - Daily Report
  - Health Check
- Job Detail panel:
  - Company scope selector
  - Runner selector
  - Schedule type
  - Interval seconds
  - Cron expression
- Company dispatch interval editor
  - Company interval seconds
  - Auto-dispatch toggle
  - Save company interval
  - Run now
- Company Heartbeat list:
  - Company name
  - Auto-dispatch state
  - Company interval
  - Last tick
- Run History list
- Selected Run details and JSON payload

No modal overlays.

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

## Projects

Route:
- `/projects`

Data sources:
- `GET /api/companies`
- `GET /api/projects`
- `POST /api/projects`
- `PUT /api/projects/:id`
- `GET /api/goals`
- `POST /api/goals`

Elements:
- Company selector
- Unified Project Authority workbench:
  - New project row
  - Project rows
  - Save/Add action in the editor header
- Project identity section:
  - Project name
  - Description
- Repository Authority section:
  - Repo provider
  - Default branch
  - Repository URL
  - Project work path
  - Protected branches
  - Work branch pattern
  - Pull before every run checkbox
  - Push after completion checkbox
  - Completion policy
- Runtime Commands section:
  - Setup command
  - Test command
  - Runtime services JSON
  - Runtime-local path hint
- Project Goals section:
  - Goal title
  - Goal body
  - Add Project Goal
  - Project goal list

No modal overlays.

## Workspace

Route:
- `/workspaces`

Data sources:
- `GET /api/companies`
- `GET /api/projects`

Elements:
- Workspace company selector
- Read-only authority root, `/workspaces/{company-slug}/`
- New folder/file name input
- New Folder button
- New File button
- Upload button, disabled until backend storage is implemented
- Company/project file tree:
  - Project group headings
  - Starter README file
  - Starter `meeting-notes/` folder
  - Starter `deliverables/` folder
  - Locally added folders/files
- Selected node detail:
  - Path
  - Authority owner
  - Root
  - Mode
  - File preview or folder empty state
  - Edit and Download buttons, disabled until backend storage exists
  - Delete local node button

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
- Tabs:
  - Runtimes
  - Company
  - Members
  - Advanced
- Runtimes tab:
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
- Company tab:
  - Company selector
  - Company name
  - Mission
  - Dispatch interval seconds
  - Auto dispatch checkbox
  - Save company
  - New department fields
  - Add department button, disabled until a company exists and fields are filled
  - Department list
- Members tab:
  - Email/User selector
  - Role selector
  - Add/update member
  - Member list with role update and disable action
- Advanced tab:
  - Future budget/secrets/company/runtime metadata panel

Dialog/confirmation:
- Delete runtime uses `window.confirm`.
- Toast/status pill appears for save/delete/member actions.

## Help

Route:
- `/help`

Data sources:
- `GET /api/help`
- `GET /api/help?format=markdown`

Elements:
- Search input
- API stat cards
- Current Architecture panel:
  - Surface cards for Dashboard, Companies, Departments, Agents, Projects, Workspace, Knowledge, Kanban, Direct Chat, Cron, Logs, Admin, Settings, Help
  - Source-of-truth notes
  - Multi-agent operating notes
  - Remaining production gaps
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
- Tabs:
  - General
  - Accounts
  - Invites
- General tab signup control:
  - Signup enabled checkbox
  - Save settings
  - Bootstrap admin note
- Account summary:
  - Total accounts
  - Active admins
  - Signup status
- Invites tab:
  - Company selector
  - Email input
  - Name input
  - Company role selector
  - Expires in days
  - Create invite
  - Copy accept URL
  - Last invite metadata: email, role, status, expiry, accept URL, raw token
- Accounts tab table:
  - One row per account
  - Email and UUID
  - Name
  - Global role badge
  - Status badge
  - Membership count
  - Edit action
- Expanded account edit row:
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

- `agents.capabilities`: added to shared schema, server create/update routes, API help, guided agent wizard, and selected-agent edit UI.
- `agents.budget_per_task`: added to guided agent wizard and selected-agent edit UI.
- `projects.protected_branches`: added to Projects editor and Repository Protocol summary.
- `projects.runtime_services`: added to Projects editor as validated JSON.
- Projects No Project reset: now resets `workPath`, protected branches, and runtime services state.
- `DELETE /api/companies/:id`: added to Companies with a full company-owned-content guard.
- Kanban toolbar: removed status filter, added company multi-select filtering and sort by company/date/priority.
- Workspace page: changed from project editor to company folder manager and authority path surface.
- `budget_policies.warn_at_percent`, `hard_stop`, `is_active`: added to Budget policy form.
- `PUT/DELETE /api/budget-policies/:id`: added edit/delete controls to Budget.
- `user_invites`: added Admin Company Invite form with accept URL/token display.
- `kanban_cards.priority`, `tags`, `dependency_card_ids`: added to New Card modal and Details tab.
- `POST /api/cards/:id/work-products`: added Work Products form in Kanban detail drawer.
- `task_runs.adapter_session_id`, `adapter_turn_id`: added to Logs task run cards.
- `POST /api/agents` help body: updated with `capabilities`.
- Browser API transport: added same-origin `/api/proxy` first, with direct browser-host and baked URL as fallbacks.
- Departments: added direct agent department assignment, no-department assignment, reports-to editing, and clickable org-canvas agent editing.
- Projects: replaced the three-card layout with a unified Project Authority workbench and kept repo/path/project goals on the Projects page.
- Cron: replaced scaffold-only rows with runnable `dispatch-heartbeat`, `daily-report`, and `health-check` jobs, each with company/runner metadata.
- Kanban company filter: changed from multi-select list to a normal dropdown while preserving sort by company.
- I18N: rebuilt corrupted zh-TW/en/ja locale dictionaries and wired sidebar/topbar labels to locale keys.

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

- Agents still use a large `OrgChart` component. Split it into `AgentWizard`, `OrgLanes`, and `AgentDetailPanel` before the next major agent redesign.
- Settings and Companies both edit company settings; decide whether Settings should remain operational config only, with company structure owned by Companies/Departments.
- Admin and Settings both touch membership-related flows. Admin now owns global accounts/invites; Settings owns company membership maintenance.
- Kanban detail drawer is now feature-complete but dense. A future redesign should split Details into task metadata, execution controls, review/escalation, and evidence/work product sections.
