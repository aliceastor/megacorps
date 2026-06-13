import { agentAdapterTypes, cardStatuses, legacyCardStatusAliases } from '@megacorps/shared';

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

type ApiEndpoint = {
  method: ApiMethod;
  path: string;
  group: string;
  auth: 'none' | 'session' | 'runner' | 'agent-session';
  requiredRole?: 'none' | 'viewer' | 'operator' | 'admin';
  summary: string;
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  response?: string;
  responseSchema?: unknown;
  responseExample?: unknown;
  rateLimit?: string;
  notes?: string[];
};

type ApiHelpEndpoint = ApiEndpoint & {
  responseSchema: unknown;
  responseExample: unknown;
  rateLimit: string;
  requiredRole: 'none' | 'viewer' | 'operator' | 'admin';
};

type CliCommand = {
  command: string;
  summary: string;
  auth: 'session' | 'runner' | 'none';
  flags: Record<string, string>;
  env: string[];
  example: string;
  lifecycle: string[];
};

const defaultRateLimit = 'In-app IP-based rate limiting is enforced by route bucket unless RATE_LIMIT_ENABLED=false. Defaults: auth 12/min, chat 40/min, webhook 120/min, runner 240/min, agent-session 240/min, operator 20/min, writes 120/min, reads 600/min.';

const cliHelp = {
  package: 'packages/cli',
  binary: 'megacorps',
  runWithNpm: 'npm run dev -w packages/cli -- <command>',
  env: [
    'MEGACORPS_API_URL: API base URL, default http://localhost:4000.',
    'MEGACORPS_SESSION: raw session cookie value returned by login for session-authenticated commands.',
    'MEGACORPS_RUNNER_KEY: raw machine runner key returned once by runner register or rotate-key.',
    'MEGACORPS_RUNNER_WORKSPACE_ROOT: default local root used by runner daemon worktrees.',
  ],
  manifestExample: [
    'defaultCompany: default',
    'companies:',
    '  - name: Default Company',
    '    slug: default',
    'departments:',
    '  - company: default',
    '    name: Engineering',
    '    slug: engineering',
    'positions:',
    '  - company: default',
    '    name: CTO',
    '    slug: cto',
    '    prompt: Own technical direction, architecture choices, and escalation boundaries.',
    'projects:',
    '  - company: default',
    '    name: Web App',
    '    repoUrl: https://github.com/org/repo',
    '    workPath: apps/web',
    'agents:',
    '  - company: default',
    '    department: engineering',
    '    position: cto',
    '    name: Builder',
    '    slug: builder',
    '    role: worker',
    '    adapterType: hermes-ssh',
    'cards:',
    '  - company: default',
    '    project: Web App',
    '    assignee: builder',
    '    title: Smoke task',
    '    body: Run the project smoke test.',
    '    dependencies: []',
  ].join('\n'),
  commands: [
    {
      command: 'login',
      summary: 'Authenticate with email/password and print the raw session cookie value for MEGACORPS_SESSION.',
      auth: 'none',
      flags: { '--email': 'Login email.', '--password': 'Login password.', '--api-url': 'Optional API URL override.' },
      env: ['MEGACORPS_API_URL'],
      example: 'npm run dev -w packages/cli -- login --api-url http://localhost:4000 --email admin@example.com --password "password"',
      lifecycle: ['Calls POST /api/auth/login.', 'Prints only the session token so scripts can export MEGACORPS_SESSION.'],
    },
    {
      command: 'apply',
      summary: 'Apply a YAML company template for companies, departments, positions, projects, agents, goals, and cards.',
      auth: 'session',
      flags: { '-f, --file': 'YAML manifest path.', '--session': 'Optional raw session cookie override.', '--api-url': 'Optional API URL override.' },
      env: ['MEGACORPS_API_URL', 'MEGACORPS_SESSION'],
      example: 'npm run dev -w packages/cli -- apply -f megacorps.yml --api-url http://localhost:4000',
      lifecycle: ['Reads visible companies first.', 'Upserts companies, positions, projects, agents, and cards where supported.', 'Resolves department/position/agent/project references by slug/name/id.', 'Resolves card dependencies after all manifest cards are known.'],
    },
    {
      command: 'runner register',
      summary: 'Create a machine runner and print its raw one-time API key with redacted runner metadata.',
      auth: 'session',
      flags: { '--name': 'Runner display name.', '--slug': 'Company-unique runner slug.', '--company-id': 'Optional target company UUID.', '--supported-runtimes': 'Comma-separated runtime labels.', '--max-concurrent': 'Optional capacity.', '--workspace-root': 'Optional runner-local workspace root.', '--scratch-root': 'Optional runner-local scratch root.', '--session': 'Optional raw session cookie override.', '--api-url': 'Optional API URL override.' },
      env: ['MEGACORPS_API_URL', 'MEGACORPS_SESSION'],
      example: 'npm run dev -w packages/cli -- runner register --name "Local Runner" --slug local-runner --supported-runtimes hermes-ssh,codex-app',
      lifecycle: ['Calls POST /api/machine-runners.', 'Stores only the runner key hash in the database.', 'Operator role is required for the target company.'],
    },
    {
      command: 'runner daemon',
      summary: 'Run a scaffold-capable machine runner loop that heartbeats, claims task-runs, prepares Git worktrees, and completes scaffold runs.',
      auth: 'runner',
      flags: { '--runner-key': 'Raw machine runner key.', '--workspace-root': 'Local runner worktree root.', '--supported-runtimes': 'Comma-separated runtime labels reported during heartbeat, e.g. hermes-ssh,codex-app.', '--interval-ms': 'Runner claim polling interval, default 5000.', '--once': 'Claim at most one task-run then exit.', '--no-complete': 'Leave claimed task-runs running for an external worker.', '--scaffold-status': 'Completion status for scaffold mode, default needs_review. Can be waiting_on_external.', '--scaffold-poll-interval-seconds': 'Optional pollIntervalSeconds sent when scaffold-status=waiting_on_external, minimum 30.', '--api-url': 'Optional API URL override.' },
      env: ['MEGACORPS_API_URL', 'MEGACORPS_RUNNER_KEY', 'MEGACORPS_RUNNER_WORKSPACE_ROOT'],
      example: 'npm run dev -w packages/cli -- runner daemon --once --workspace-root C:\\megacorps-runner --scaffold-status waiting_on_external --scaffold-poll-interval-seconds 300',
      lifecycle: ['Calls POST /api/runner/heartbeat.', 'Claims queued dispatch/review task-runs from POST /api/runner/task-runs/claim.', 'Creates or updates Git worktrees from Project Authority fields.', 'Completes with POST /api/runner/task-runs/:id/complete unless --no-complete is set.', 'When scaffold-status=waiting_on_external, --scaffold-poll-interval-seconds is sent as pollIntervalSeconds so external polling is not tied to the global dispatch heartbeat.'],
    },
  ] satisfies CliCommand[],
};

const endpoints: ApiEndpoint[] = [
  { method: 'GET', path: '/health', group: 'System', auth: 'none', summary: 'Read server health.', response: '{ ok: true }' },
  { method: 'GET', path: '/api/help', group: 'System', auth: 'none', summary: 'List MegaCorps API endpoints, CLI commands, current architecture, and usage.', query: { format: 'Optional. Use markdown or md for text/markdown output.' }, responseSchema: { service: 'string', help: 'object', architecture: 'object', auth: 'object', rateLimits: 'object', kanban: 'object', adapters: 'string[]', cli: 'CliHelp', endpoints: 'ApiHelpEndpoint[]' }, responseExample: { service: 'MegaCorps API', architecture: { surfaces: [{ name: 'Projects', purpose: 'Repo/work-path authority.' }] }, cli: { commands: [{ command: 'apply', auth: 'session' }] }, endpoints: [{ method: 'GET', path: '/health', responseSchema: { ok: 'boolean' }, responseExample: { ok: true } }] } },
  { method: 'GET', path: '/api/live', group: 'System', auth: 'session', summary: 'WebSocket live event stream for React Query cache invalidation. Events are filtered to the authenticated user company memberships.' },
  { method: 'GET', path: '/api/auth/status', group: 'Auth', auth: 'none', summary: 'Read public onboarding state. Signup is DB-configured and defaults to enabled; signup becomes admin when no active admin exists.' },
  { method: 'POST', path: '/api/auth/bootstrap', group: 'Auth', auth: 'none', summary: 'Bootstrap or recover the global admin account when BOOTSTRAP_TOKEN is configured and no active admin exists.', body: { token: 'BOOTSTRAP_TOKEN value or send X-MegaCorps-Bootstrap-Token header', email: 'admin@example.com', name: 'Admin', password: 'at least 8 chars' } },
  { method: 'POST', path: '/api/auth/signup', group: 'Auth', auth: 'none', summary: 'Create a user when DB auth.signup_enabled=true. If no active admin exists, this account becomes global admin and default-company admin.', body: { email: 'user@example.com', name: 'Operator', password: 'at least 8 chars' } },
  { method: 'POST', path: '/api/auth/login', group: 'Auth', auth: 'none', summary: 'Log in and set the session cookie.', body: { email: 'user@example.com', password: 'password' } },
  { method: 'POST', path: '/api/auth/logout', group: 'Auth', auth: 'session', summary: 'Clear the session cookie.' },
  { method: 'POST', path: '/api/auth/invites', group: 'Auth', auth: 'session', requiredRole: 'admin', summary: 'Create a one-time company invite token. The raw token is returned once and only its SHA-256 hash is stored.', body: { companyId: 'uuid', email: 'operator@example.com', name: 'Optional name', role: 'viewer | operator | admin', expiresInDays: 7 } },
  { method: 'POST', path: '/api/auth/accept-invite', group: 'Auth', auth: 'none', summary: 'Accept a one-time invite token and create or activate the user membership.', body: { token: 'invite token', name: 'Optional display name', password: 'at least 12 chars' } },
  { method: 'GET', path: '/api/me', group: 'Auth', auth: 'session', summary: 'Read the current authenticated user.' },
  { method: 'GET', path: '/api/admin/settings', group: 'Admin', auth: 'session', requiredRole: 'admin', summary: 'Read global admin settings such as DB-backed signup enablement and direct API token status.' },
  { method: 'PUT', path: '/api/admin/settings', group: 'Admin', auth: 'session', requiredRole: 'admin', summary: 'Update global admin settings. apiTokenAction=rotate returns a raw API token once; revoke disables direct Bearer token access.', body: { signupEnabled: true, apiTokenAction: 'rotate | revoke optional' } },
  { method: 'GET', path: '/api/admin/users', group: 'Admin', auth: 'session', requiredRole: 'admin', summary: 'List all user accounts and company memberships.' },
  { method: 'PUT', path: '/api/admin/users/:id', group: 'Admin', auth: 'session', requiredRole: 'admin', summary: 'Update an account name, global role, active/disabled status, or reset password. The last active admin cannot be demoted or disabled.', params: { id: 'User UUID.' }, body: { name: 'Operator', role: 'viewer | operator | admin', status: 'active | disabled', password: 'optional reset password' } },

  { method: 'GET', path: '/api/dashboard', group: 'Overview', auth: 'session', summary: 'Read dashboard stats, stage counts, recent task logs, and recent API events.' },
  { method: 'GET', path: '/api/system-logs', group: 'Logs', auth: 'session', summary: 'Read persisted API lifecycle logs for the current user.', query: { limit: '1-500, default 100.' } },
  { method: 'GET', path: '/api/prompt-logs', group: 'Logs', auth: 'session', summary: 'Read redacted outbound prompt snapshots sent to adapters for visible companies. metadata.contextMode shows full_bootstrap, adapter_session_continuation, or adapter_session_delta.', query: { companyId: 'Optional company UUID.', cardId: 'Optional task UUID.', agentId: 'Optional agent UUID.', source: 'dispatch | review | chat | test.', limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/activity', group: 'Logs', auth: 'session', summary: 'Read product activity/audit events.', query: { companyId: 'Optional company UUID.', entityType: 'Optional entity type.', limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/heartbeat-runs', group: 'Logs', auth: 'session', summary: 'Read agent heartbeat/run history.', query: { companyId: 'Optional company UUID.', cardId: 'Optional task UUID.', agentId: 'Optional agent UUID.', status: 'Optional run status.', limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/task-runs', group: 'Logs', auth: 'session', summary: 'Read queued/running/completed task-run attempts.', query: { companyId: 'Optional company UUID.', cardId: 'Optional task UUID.', agentId: 'Optional agent UUID.', kind: 'dispatch | review.', status: 'queued | running | success | failed | cancelled.', limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/cost-events', group: 'Budget', auth: 'session', summary: 'Read recorded model/runtime cost events.', query: { companyId: 'Optional company UUID.', agentId: 'Optional agent UUID.', cardId: 'Optional task UUID.', limit: '1-500, default 200.' } },

  { method: 'GET', path: '/api/companies', group: 'Companies', auth: 'session', summary: 'List companies visible to the current user memberships.' },
  { method: 'POST', path: '/api/companies', group: 'Companies', auth: 'session', summary: 'Create a company.', body: { name: 'Acme AI', slug: 'acme-ai', mission: 'Build useful things.', dispatchIntervalSeconds: 10, autoDispatchEnabled: true } },
  { method: 'PUT', path: '/api/companies/:id', group: 'Companies', auth: 'session', summary: 'Update company settings.', params: { id: 'Company UUID.' }, body: { name: 'Acme AI', slug: 'acme-ai', mission: 'Updated mission.', dispatchIntervalSeconds: 30, autoDispatchEnabled: true } },
  { method: 'DELETE', path: '/api/companies/:id', group: 'Companies', auth: 'session', requiredRole: 'admin', summary: 'Delete an empty company. Existing company-owned content blocks deletion and is returned in company_not_empty.blocking.', params: { id: 'Company UUID.' } },
  { method: 'GET', path: '/api/company-memberships', group: 'Companies', auth: 'session', summary: 'List memberships for visible companies.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/company-memberships', group: 'Companies', auth: 'session', requiredRole: 'admin', summary: 'Add or update a company membership by userId or email.', body: { companyId: 'uuid', email: 'operator@example.com', role: 'viewer | operator | admin', status: 'active' } },
  { method: 'PUT', path: '/api/company-memberships/:id', group: 'Companies', auth: 'session', requiredRole: 'admin', summary: 'Update a company membership role/status.', params: { id: 'Membership UUID.' }, body: { role: 'viewer | operator | admin', status: 'active | disabled' } },
  { method: 'DELETE', path: '/api/company-memberships/:id', group: 'Companies', auth: 'session', requiredRole: 'admin', summary: 'Disable a company membership.', params: { id: 'Membership UUID.' } },
  { method: 'GET', path: '/api/departments', group: 'Departments', auth: 'session', summary: 'List departments visible to the current user.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/departments', group: 'Departments', auth: 'session', summary: 'Create a department. Assign agents through PUT /api/agents/:id with departmentId and bossId.', body: { companyId: 'uuid', name: 'Engineering', slug: 'engineering' } },
  { method: 'GET', path: '/api/positions', group: 'Positions', auth: 'session', summary: 'List reusable company positions visible to the current user. Position prompts and authority metadata are injected into Direct Chat and Kanban dispatch for assigned agents.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/positions', group: 'Positions', auth: 'session', summary: 'Create a company-scoped position prompt and authority profile. Only one active position per company can be marked isCompanyBoss.', body: { companyId: 'uuid', name: 'CTO', slug: 'cto', description: 'Own technical direction.', rank: 10, isCompanyBoss: false, canDelegateAcrossDepartments: false, defaultDepartmentId: 'department uuid | null', managerPositionId: 'position uuid | null', prompt: 'Own technical direction, architecture decisions, escalation style, and limits.' } },
  { method: 'PUT', path: '/api/positions/:id', group: 'Positions', auth: 'session', summary: 'Update a company-scoped position prompt and authority profile. The company cannot be changed after creation; deleting the active company boss is blocked.', params: { id: 'Position UUID.' }, body: { name: 'CTO', slug: 'cto', description: 'Updated description', rank: 10, isCompanyBoss: false, canDelegateAcrossDepartments: true, defaultDepartmentId: 'department uuid | null', managerPositionId: 'position uuid | null', prompt: 'Updated role-specific prompt.', isActive: true } },
  { method: 'DELETE', path: '/api/positions/:id', group: 'Positions', auth: 'session', summary: 'Delete a position prompt and clear positionId from assigned agents. Active company boss positions cannot be deleted.', params: { id: 'Position UUID.' } },

  { method: 'GET', path: '/api/cards', group: 'Kanban', auth: 'session', summary: 'List Kanban tasks visible to the current user.', query: { companyId: 'Optional company UUID.', status: `Optional. One of ${cardStatuses.join(', ')}. Legacy backlog maps to todo.`, assigneeId: 'Optional agent UUID.', projectId: 'Optional project UUID, or none for no-project tasks.', tag: 'Optional tag.', priority: 'urgent | high | normal | low.', limit: 'Default 100.', offset: 'Default 0.' } },
  { method: 'POST', path: '/api/cards', group: 'Kanban', auth: 'session', summary: 'Create a Kanban task. New tasks default to todo. departmentId/projectId/goalId determine the company, department, project, and selected-goal prompt context.', body: { companyId: 'uuid optional', departmentId: null, projectId: null, goalId: null, title: 'Task title', body: 'Full task detail', priority: 'normal', tags: ['backend'], assigneeId: null, reviewerId: null, requiresApproval: false, decisionMode: 'execute | delegate | hybrid | review | integrate optional', requiredChildPolicy: 'all_required_accepted | all_non_cancelled_accepted | threshold | manual', childRequirementLevel: 'required | optional | follow_up', estimatedWeight: 1, estimatedDurationMinutes: 30, taskBudgetLimit: 2.5, maxRevisions: 3 } },
  { method: 'PUT', path: '/api/cards/:id', group: 'Kanban', auth: 'session', summary: 'Update a Kanban task. Include updatedAt for optimistic locking. Goal selection is validated against the card company, department, and project. Same-card Message Board DELEGATE / REVIEWER records are the active collaboration workflow; legacy child-card fields are preserved only for old data compatibility.', params: { id: 'Task UUID.' }, body: { title: 'Updated title', body: 'Updated detail', columnStatus: 'todo | in_progress | in_review | needs_review | waiting_on_external | done | blocked | cancelled', rollupStatus: 'planning | delegated | waiting_on_children | waiting_on_dependencies | waiting_on_external | integrating | ready_for_review | done | blocked | null', projectId: 'uuid | null', goalId: 'uuid | null', decisionMode: 'execute | delegate | hybrid | review | integrate | null', requiredChildPolicy: 'legacy compatibility only', childRequirementLevel: 'legacy compatibility only', estimatedWeight: 1, estimatedDurationMinutes: 30, taskBudgetLimit: 2.5, revisionCount: 1, maxRevisions: 3, updatedAt: 'ISO datetime from existing card' } },
  { method: 'POST', path: '/api/cards/:id/cancel', group: 'Kanban', auth: 'session', summary: 'Cancel an active or queued task without archiving its history. Releases execution locks and cancels queued/running task-runs.', params: { id: 'Task UUID.' }, body: { reason: 'Optional cancellation reason.' } },
  { method: 'DELETE', path: '/api/cards/:id', group: 'Kanban', auth: 'session', summary: 'Archive a task while preserving historical logs, runs, and cost records.', params: { id: 'Task UUID.' } },
  { method: 'GET', path: '/api/cards/:id/logs', group: 'Kanban', auth: 'session', summary: 'Read paged task logs. Use limit/offset for cards with large retry or review histories.', params: { id: 'Task UUID.' }, query: { limit: '1-500, default 100.', offset: 'Default 0.' } },
  { method: 'GET', path: '/api/cards/:id/subtree', group: 'Kanban', auth: 'session', summary: 'Legacy read-only child-card diagnostics for old tasks. New Kanban collaboration uses same-card Message Board DELEGATE / REVIEWER records instead of child cards.', params: { id: 'Task UUID.' }, query: { limit: '1-5000, default 1000.' } },
  { method: 'GET', path: '/api/cards/:id/actions', group: 'Kanban', auth: 'session', summary: 'Read the normalized card action timeline. This records lifecycle actions, actors, from/to status, human-readable detail, runner/session ids, and metadata separately from raw task logs.', params: { id: 'Task UUID.' }, query: { limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/cards/:id/delegation-summary', group: 'Kanban', auth: 'session', summary: 'Read lightweight current Message Board delegation metadata for the card detail header, including phase assignee and phase reviewer without loading full comments.', params: { id: 'Task UUID.' } },
  { method: 'GET', path: '/api/cards/:id/rollup', group: 'Kanban Lifecycle', auth: 'session', summary: 'Read task rollup and legacy child-card compatibility counts when old data exists. Active collaboration status should be read from Message Board delegation/reviewer records.', params: { id: 'Task UUID.' } },
  { method: 'GET', path: '/api/cards/:id/context', group: 'Kanban Lifecycle', auth: 'session', summary: 'Read the TaskContextPackage for a card: root mission, parent chain, current card, flow map, main cast, message digest, log digest, action timeline, and rollup.', params: { id: 'Task UUID.' } },
  { method: 'GET', path: '/api/cards/:id/context-snapshots', group: 'Kanban Lifecycle', auth: 'session', summary: 'Read stored context snapshots for a card so operators can inspect what context was available at decision time.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/context-snapshots', group: 'Kanban Lifecycle', auth: 'session', summary: 'Store a current TaskContextPackage snapshot for audit/debugging.', params: { id: 'Task UUID.' }, body: { mode: 'dispatch | review | integrate | manual', agentId: 'optional agent UUID', taskRunId: 'optional task-run UUID', summaryJson: { note: 'optional operator metadata' } } },
  { method: 'GET', path: '/api/cards/:id/context-requests', group: 'Kanban Lifecycle', auth: 'session', summary: 'Read agent/operator requests for additional scoped context on a card.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/context-requests', group: 'Kanban Lifecycle', auth: 'session', summary: 'Create a request for extra context when the current TaskContextPackage is insufficient. Requested card ids must belong to the same company.', params: { id: 'Task UUID.' }, body: { agentId: 'optional agent UUID', requestedCardIds: ['related card uuid'], requestedLogKinds: ['task_logs', 'comments', 'actions'], reason: 'Why this extra context is needed.' } },
  { method: 'PUT', path: '/api/context-requests/:id', group: 'Kanban Lifecycle', auth: 'session', summary: 'Resolve or update a context request status after the requested context has been handled.', params: { id: 'Context request UUID.' }, body: { status: 'open | approved | rejected | resolved | cancelled' } },
  { method: 'GET', path: '/api/cards/:id/comments', group: 'Kanban', auth: 'session', summary: 'Read task message board comments.', params: { id: 'Task UUID.' } },
  { method: 'GET', path: '/api/cards/:id/work-products', group: 'Kanban', auth: 'session', summary: 'Read reviewable work products for a task: PRs, commits, preview URLs, reports, screenshots, and artifacts.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/work-products', group: 'Kanban', auth: 'session', summary: 'Attach a reviewable work product to a task. Prefer Git/URL metadata over local-only paths for multi-system agents.', params: { id: 'Task UUID.' }, body: { type: 'pull_request | commit | preview_url | report | screenshot | artifact | file | external', title: 'PR #42', summary: 'What changed', url: 'https://...', repoUrl: 'https://github.com/org/repo', branch: 'megacorps/card-1234-alice', commitSha: 'abc123', pullRequestUrl: 'https://github.com/org/repo/pull/42' } },
  { method: 'GET', path: '/api/cards/:id/external-waits', group: 'External Events', auth: 'session', summary: 'Read external waits for a card, such as CI/CD, deployment, export, or external approval blockers.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/external-waits', group: 'External Events', auth: 'session', summary: 'Move a card to waiting_on_external, release execution locks, and record what external system should wake it.', params: { id: 'Task UUID.' }, body: { waitingFor: 'GitHub Actions CI', provider: 'github', externalId: 'run-id optional', externalUrl: 'https://github.com/org/repo/actions/runs/123', timeoutAt: 'optional ISO datetime', pollIntervalSeconds: 'Optional agent/operator chosen polling interval, 30-86400 seconds.' } },
  { method: 'GET', path: '/api/cards/:id/required-tools', group: 'Tools', auth: 'session', summary: 'Read deterministic tools required by a leaf card.', params: { id: 'Task UUID.' } },
  { method: 'PUT', path: '/api/cards/:id/required-tools', group: 'Tools', auth: 'session', summary: 'Replace deterministic tools required by a leaf card. Tools must be active and required-eligible.', params: { id: 'Task UUID.' }, body: { toolIds: ['tool uuid'], reason: 'Why the agent must call these tools.' } },
  { method: 'GET', path: '/api/cards/:id/integrations', group: 'Kanban Lifecycle', auth: 'session', summary: 'Read parent-card integration outputs, accepted/dropped child work products, and conflict notes.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/integrations', group: 'Kanban Lifecycle', auth: 'session', summary: 'Create a parent integration output or logical merge-conflict record for child outputs.', params: { id: 'Task UUID.' }, body: { integratorAgentId: 'optional agent UUID', sourceChildCardIds: ['child card uuid'], summary: 'Integrated output summary', acceptedWorkProductIds: [], droppedWorkProductIds: [], conflictNotes: 'optional logical merge conflict notes', status: 'draft | accepted | rejected | superseded' } },
  { method: 'POST', path: '/api/cards/:id/comments', group: 'Kanban', auth: 'session', summary: 'Add a task message board comment, intervention, or same-card delegation request. delegate_to_agent creates a Message Board delegation run with phase/final reviewer metadata without creating a child Kanban card. escalate_to_reviewer moves the card to needs_review and queues a help review when an independent reviewer exists; otherwise it blocks the card.', params: { id: 'Task UUID.' }, body: { body: 'Instruction, blocker, delegated work, or reviewer question', action: 'comment | agent_note | pause_agent | send_to_agent | continue_run | escalate_to_reviewer | delegate_to_agent', agentId: 'optional agent UUID for agent-authored note', assigneeAgentId: 'required for delegate_to_agent', reviewerAgentId: 'optional for delegate_to_agent', reviewerScope: 'phase | final optional' } },
  { method: 'POST', path: '/api/cards/:id/run', group: 'Kanban', auth: 'session', summary: 'Queue a dispatch task-run attempt for the background worker. First adapter turn gets full context; later scoped adapter sessions for codex-app/hermes-ssh get a fresh DB delta prompt.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/review', group: 'Kanban', auth: 'session', summary: 'Queue a review task-run attempt for the background worker. First review turn gets full context; later scoped adapter sessions for codex-app/hermes-ssh get a fresh DB delta prompt.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/decompose', group: 'Kanban', auth: 'session', summary: 'Disabled legacy endpoint. Returns 410 child_cards_disabled; use Message Board DELEGATE / REVIEWER records instead of creating child cards.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/webhook/task-complete', group: 'Kanban', auth: 'none', summary: 'External agent callback to report task progress, same-card Message Board delegation, review, external wait, or completion. Send taskRunId for idempotent processing. A strict DELEGATE: bullet block in summary/output creates Message Board delegation requests for active direct reports and keeps the parent in_progress; task runtimes should not call session-auth /api/cards themselves. message/message_review task runs update only the delegation chain, not the Kanban card stage. status=done/in_review queues quality review instead of marking done when a distinct reviewer exists. status=waiting_on_external releases locks while a PR/CI/deploy/approval waits; include pollIntervalSeconds when the agent wants polling instead of a tight global heartbeat; status=needs_review means the assignee cannot finish and needs reviewer guidance; blocked with guidance/escalation wording is also promoted to help review when a reviewer exists, or accepted as done when there is no higher reviewer/manager.', body: { cardId: 'uuid', taskRunId: 'task-run uuid from prompt', status: 'done | blocked | needs_review | in_review | in_progress | waiting_on_external | todo | cancelled', summary: 'Short result, delegation summary, or needs reviewer guidance. Include DELEGATE: here or in output to create Message Board delegation requests.', output: 'Full output/log with attempted methods, blocker, reviewer questions, partial output, or DELEGATE: bullet list', costUsd: 0.05, pollIntervalSeconds: 'Optional 30-86400 seconds when status=waiting_on_external.', workProducts: [{ type: 'pull_request', title: 'PR for task', pullRequestUrl: 'https://github.com/org/repo/pull/42', branch: 'megacorps/card-1234-alice', commitSha: 'abc123' }] } },
  { method: 'GET', path: '/api/external-events', group: 'External Events', auth: 'session', summary: 'List external CI/CD, deploy, approval, or generic webhook events visible to the current user.', query: { companyId: 'Optional company UUID.', cardId: 'Optional task UUID.', provider: 'Optional provider.', limit: 'Default 200.' } },
  { method: 'POST', path: '/api/external-events', group: 'External Events', auth: 'session', summary: 'Record an external event and wake a waiting card. success moves to in_review/done, failure returns to in_progress/blocked, timeout blocks.', body: { cardId: 'uuid', provider: 'github', eventType: 'workflow_run.completed', status: 'success | failure | cancelled | waiting | timeout | info', externalId: 'run-id optional', externalUrl: 'https://...', payloadSummary: 'CI passed', payload: {} } },

  { method: 'GET', path: '/api/agents', group: 'Agents', auth: 'session', summary: 'List agents visible to the current user.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/agents', group: 'Agents', auth: 'session', summary: 'Create an agent. positionId attaches a reusable company position prompt; the web UI keeps the legacy role field as worker for backward compatibility.', body: { companyId: 'uuid optional', departmentId: 'uuid optional', positionId: 'uuid optional', name: 'Builder', slug: 'builder', role: 'worker', adapterType: 'hermes-ssh | hermes-gateway | codex-app | webhook | openclaw', runtimeId: 'uuid optional', bossId: null, budgetPerTask: 1, budgetMonthly: 20 } },
  { method: 'PUT', path: '/api/agents/:id', group: 'Agents', auth: 'session', summary: 'Update an agent, adapter config, runtime, department assignment, position prompt, and reporting line. Org-only updates can send just departmentId, positionId, and/or bossId; runtime adapter validation only runs when runtimeId or adapterType is included.', params: { id: 'Agent UUID.' }, body: { name: 'optional', slug: 'optional', role: 'optional legacy compatibility label', departmentId: 'uuid | null', positionId: 'position uuid | null', bossId: 'agent uuid | null', adapterType: 'optional adapter type', runtimeId: 'runtime uuid | null' }, notes: ['Use departmentId=null for no department, positionId=null for no position prompt, and bossId=null for top-level agent.', 'When positionId is set, Direct Chat and Kanban inject: You are <position> in <department> department of firm <company>, followed by the custom position prompt.', 'Projects are not edited from Agents; use /api/projects for repo/work-path authority.'] },
  { method: 'DELETE', path: '/api/agents/:id', group: 'Agents', auth: 'session', summary: 'Archive an agent and release current task assignments while preserving historical runs.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/pause', group: 'Agents', auth: 'session', summary: 'Pause an agent.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/resume', group: 'Agents', auth: 'session', summary: 'Resume an agent.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/reset-session', group: 'Agents', auth: 'session', summary: 'Clear an agent session id.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/test-connection', group: 'Agents', auth: 'session', summary: 'Test the selected adapter/runtime connection.', params: { id: 'Agent UUID.' } },
  { method: 'GET', path: '/api/agent-runtimes', group: 'Agents', auth: 'session', summary: 'List company-scoped runtime presets.', query: { companyId: 'Optional company UUID.' } },
  { method: 'GET', path: '/api/agent-runtimes/health', group: 'Agents', auth: 'session', summary: 'Read runtime health summaries, attached agent counts, last run status, and adapter capabilities.' },
  { method: 'POST', path: '/api/agent-runtimes', group: 'Agents', auth: 'session', summary: 'Create a runtime preset. localWorkspaceRoot/localScratchRoot are runtime-owned local paths for that machine; project repo/workPath remain the shared project policy. codex-app supports stdio or authenticated WebSocket app-server transport.', body: { name: 'Codex App Server', adapterType: 'codex-app', localWorkspaceRoot: '/home/alice/workspaces', localScratchRoot: '/tmp/megacorps', isActive: true, config: { codexTransport: 'stdio | websocket', codexCommand: 'codex', codexArgs: 'app-server', codexAppServerUrl: 'ws://codex-runner.example:4500', codexWsToken: 'secret bearer token for websocket', codexModel: 'optional model', codexCwd: '/home/alice/workspaces/project', codexSandbox: 'workspace-write' } } },
  { method: 'PUT', path: '/api/agent-runtimes/:id', group: 'Agents', auth: 'session', summary: 'Update a runtime preset, including adapter config and runtime-local workspace/scratch roots.', params: { id: 'Runtime UUID.' } },
  { method: 'DELETE', path: '/api/agent-runtimes/:id', group: 'Agents', auth: 'session', summary: 'Delete a runtime preset.', params: { id: 'Runtime UUID.' } },
  { method: 'GET', path: '/api/tools', group: 'Tools', auth: 'session', summary: 'List deterministic tool definitions for visible companies. Tools can be attached to leaf cards as required verified transformations.', query: { companyId: 'Optional company UUID.', projectId: 'Optional project UUID.', active: 'true | false optional.' } },
  { method: 'POST', path: '/api/tools', group: 'Tools', auth: 'session', summary: 'Create a deterministic tool definition with input/output schema and required-tool eligibility.', body: { companyId: 'uuid', projectId: null, name: 'Normalize OUT code', version: '1.0.0', description: 'Parse OUT-1704C1 style strings.', inputSchema: {}, outputSchema: {}, isRequiredEligible: true, isActive: true } },
  { method: 'PUT', path: '/api/tools/:id', group: 'Tools', auth: 'session', summary: 'Update deterministic tool metadata, schemas, owner, activity, or required-tool eligibility.', params: { id: 'Tool UUID.' } },
  { method: 'DELETE', path: '/api/tools/:id', group: 'Tools', auth: 'session', summary: 'Disable a deterministic tool definition without deleting historical card references.', params: { id: 'Tool UUID.' } },
  { method: 'GET', path: '/api/machine-runners', group: 'Runners', auth: 'session', summary: 'List machine runners visible to the current user. API key hashes are never returned.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/machine-runners', group: 'Runners', auth: 'session', summary: 'Create a machine runner and return its raw API key once. Store the key in the runner process as MEGACORPS_RUNNER_KEY.', body: { companyId: 'uuid optional', name: 'Runner host', slug: 'runner-host', supportedRuntimes: ['hermes-ssh', 'codex-app'], maxConcurrent: 2, localWorkspaceRoot: '/srv/megacorps/workspaces', localScratchRoot: '/srv/megacorps/scratch' } },
  { method: 'PUT', path: '/api/machine-runners/:id', group: 'Runners', auth: 'session', summary: 'Update runner metadata, capacity, status, runtime support, or local roots. Does not rotate the API key.', params: { id: 'Machine runner UUID.' } },
  { method: 'POST', path: '/api/machine-runners/:id/rotate-key', group: 'Runners', auth: 'session', summary: 'Rotate a runner API key and return the new raw key once.', params: { id: 'Machine runner UUID.' } },
  { method: 'DELETE', path: '/api/machine-runners/:id', group: 'Runners', auth: 'session', summary: 'Disable and soft-delete a machine runner.', params: { id: 'Machine runner UUID.' } },
  { method: 'GET', path: '/api/runner/me', group: 'Runner Agent API', auth: 'runner', summary: 'Read the authenticated runner identity using Authorization: Bearer MEGACORPS_RUNNER_KEY or X-MegaCorps-Runner-Key.' },
  { method: 'POST', path: '/api/runner/heartbeat', group: 'Runner Agent API', auth: 'runner', summary: 'Update runner liveness, capacity, supported runtimes, runtime health, and local workspace roots.', body: { name: 'Runner host', version: '0.1.0', os: 'linux/x64', supportedRuntimes: ['hermes-ssh', 'codex-app'], maxConcurrent: 2, activeSlots: 1, runtimeStatuses: { 'codex-app': 'ready' } } },
  { method: 'POST', path: '/api/runner/agent-sessions', group: 'Runner Agent API', auth: 'runner', summary: 'Open an agent session with a public Ed25519 JWK or PEM key. Agents can then call the agent-session API with a signed JWT whose sub is the session id and aid is the agent id. When cardId is set, card APIs are restricted to that card.', body: { agentId: 'agent uuid', cardId: 'optional card uuid', taskRunId: 'optional task-run uuid', sessionKind: 'task | review | chat | leader', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'base64url' } } },
  { method: 'POST', path: '/api/runner/task-runs/claim', group: 'Runner Agent API', auth: 'runner', summary: 'Atomically claim the highest-priority queued task-run matching runner company and supported runtime.', body: { kinds: ['dispatch', 'review'] } },
  { method: 'POST', path: '/api/runner/task-runs/:id/complete', group: 'Runner Agent API', auth: 'runner', summary: 'Complete a runner-claimed task-run and attach work products such as branches, commits, PRs, reports, screenshots, or artifacts. Dispatch success/done queues quality review when the card has a distinct reviewer; review success approves to done. status=waiting_on_external releases the run lock while CI/CD, deploy, export, or outside approval continues, with optional pollIntervalSeconds chosen by the agent/runtime.', params: { id: 'Task-run UUID.' }, body: { status: 'success | failed | cancelled | done | blocked | needs_review | in_review | waiting_on_external', summary: 'Short result', output: 'Full output/log', costUsd: 0.01, pollIntervalSeconds: 'Optional 30-86400 seconds when status=waiting_on_external.', workProducts: [{ type: 'pull_request', title: 'PR #42', pullRequestUrl: 'https://github.com/org/repo/pull/42', branch: 'megacorps/card-1234-alice' }] } },
  { method: 'GET', path: '/api/agent/me', group: 'Agent Session API', auth: 'agent-session', summary: 'Read the active agent/session identity using an Ed25519-signed JWT from a runner-created agent session.' },
  { method: 'POST', path: '/api/agent/cards/:id/claim', group: 'Agent Session API', auth: 'agent-session', summary: 'Agent-session endpoint for a worker to claim its assigned card and move it to in_progress.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/agent/cards/:id/review', group: 'Agent Session API', auth: 'agent-session', summary: 'Agent-session endpoint for a worker to submit output for quality review or help review.', params: { id: 'Task UUID.' }, body: { summary: 'Short output', output: 'Full output/log', needsHelp: false } },
  { method: 'POST', path: '/api/agent/cards/:id/release', group: 'Agent Session API', auth: 'agent-session', summary: 'Agent-session endpoint for a worker to release a card back to todo and clear active locks.', params: { id: 'Task UUID.' } },

  { method: 'GET', path: '/api/chat/sessions', group: 'Chat', auth: 'session', summary: 'List direct-chat sessions. agentSessionId stores the active adapter/chat thread id when one exists.', query: { companyId: 'Optional company UUID.', agentId: 'Optional agent UUID.', projectId: 'Optional project UUID, or none for no-project chat.', limit: '1-200, default 100.' } },
  { method: 'POST', path: '/api/chat/sessions', group: 'Chat', auth: 'session', summary: 'Create a direct-chat session with an agent. projectId scopes the first-turn prompt goal context; null keeps the session in no-project chat.', body: { companyId: 'uuid', agentId: 'uuid', projectId: null, title: 'Session title optional' } },
  { method: 'GET', path: '/api/chat/sessions/:id/messages', group: 'Chat', auth: 'session', summary: 'Read chat messages.', params: { id: 'Chat session UUID.' } },
  { method: 'POST', path: '/api/chat/sessions/:id/messages', group: 'Chat', auth: 'session', summary: 'Send a message to an agent and store the response. First turn injects full company/goal/Kanban context; subsequent turns include a bounded recent transcript so Hermes/Codex can answer from the same Direct Chat session even when adapter resume memory is incomplete.', params: { id: 'Chat session UUID.' }, body: { body: 'Message for the agent' } },

  { method: 'GET', path: '/api/projects', group: 'Projects', auth: 'session', summary: 'List visible projects. Projects are the only Project Authority API surface for repo/work-path policy.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/projects', group: 'Projects', auth: 'session', summary: 'Create a project with optional repo binding and project-level work path. repoUrl is the shared Git truth; workPath is the repo/workspace-relative area agents should edit; each remote agent still uses its own runtime-local clone.', body: { companyId: 'uuid optional', name: 'Project name', description: 'Optional description', repoProvider: 'github', repoUrl: 'https://github.com/org/repo', workPath: 'apps/server or reports/final, null means project root', defaultBranch: 'main', workBranchPattern: 'megacorps/card-{cardId}-{agentSlug}', pullBeforeRun: true, pushAfterRun: true, completionPolicy: 'push_or_pr', setupCommand: 'npm install', testCommand: 'npm test', runtimeServices: { web: 'http://localhost:3000' }, workspacePathHint: 'optional runtime-local clone/folder hint only' } },
  { method: 'PUT', path: '/api/projects/:id', group: 'Projects', auth: 'session', summary: 'Update a project repo binding, project work path, branch policy, runtime services, setup/test commands, or description.', params: { id: 'Project UUID.' } },
  { method: 'DELETE', path: '/api/projects/:id', group: 'Projects', auth: 'session', summary: 'Delete a project that has no cards, work products, chat sessions, or cost events. Project goals are removed with the project.', params: { id: 'Project UUID.' } },
  { method: 'GET', path: '/api/goals', group: 'Goals', auth: 'session', summary: 'List visible goals. Goals belong directly to exactly one company, department, or project; there is no separate derived-goal API layer.', query: { companyId: 'Optional company UUID.', scope: 'company | department | project filter.', departmentId: 'Optional department UUID.', projectId: 'Optional project UUID.' } },
  { method: 'POST', path: '/api/goals', group: 'Goals', auth: 'session', summary: 'Create a company, department, or project goal. Do not send both departmentId and projectId.', body: { companyId: 'uuid optional', departmentId: null, projectId: null, title: 'Goal title', body: 'Goal detail' } },
  { method: 'GET', path: '/api/knowledge-docs', group: 'Knowledge', auth: 'session', summary: 'List visible knowledge documents.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/knowledge-docs', group: 'Knowledge', auth: 'session', summary: 'Create a knowledge document.', body: { companyId: 'uuid', title: 'Runbook', tags: ['ops'], body: 'Document body' } },
  { method: 'PUT', path: '/api/knowledge-docs/:id', group: 'Knowledge', auth: 'session', summary: 'Update a knowledge document.', params: { id: 'Knowledge document UUID.' } },
  { method: 'DELETE', path: '/api/knowledge-docs/:id', group: 'Knowledge', auth: 'session', summary: 'Delete a knowledge document.', params: { id: 'Knowledge document UUID.' } },

  { method: 'GET', path: '/api/budget-policies', group: 'Budget', auth: 'session', summary: 'List budget policies.', query: { companyId: 'Optional company UUID.', agentId: 'Optional agent UUID.' } },
  { method: 'POST', path: '/api/budget-policies', group: 'Budget', auth: 'session', summary: 'Create a budget policy.', body: { companyId: 'uuid', agentId: null, name: 'Monthly cap', monthlyLimitUsd: 100, perTaskLimitUsd: 2, warnAtPercent: 80, hardStop: true, isActive: true } },
  { method: 'PUT', path: '/api/budget-policies/:id', group: 'Budget', auth: 'session', summary: 'Update a budget policy.', params: { id: 'Policy UUID.' } },
  { method: 'DELETE', path: '/api/budget-policies/:id', group: 'Budget', auth: 'session', summary: 'Delete a budget policy.', params: { id: 'Policy UUID.' } },
  { method: 'GET', path: '/api/approvals', group: 'Budget', auth: 'session', summary: 'List approvals.', query: { companyId: 'Optional company UUID.', status: 'Optional approval status.', cardId: 'Optional task UUID.', limit: '1-500, default 200.' } },
  { method: 'PUT', path: '/api/approvals/:id', group: 'Budget', auth: 'session', summary: 'Decide an approval.', params: { id: 'Approval UUID.' }, body: { status: 'approved | rejected | revision_requested | cancelled', decisionNote: 'Optional note' } },

  { method: 'GET', path: '/api/cron/status', group: 'Cron', auth: 'session', requiredRole: 'viewer', summary: 'Read dispatch loop status.' },
  { method: 'GET', path: '/api/cron/runs', group: 'Cron', auth: 'session', requiredRole: 'viewer', summary: 'Read cron/heartbeat loop runs.', query: { limit: '1-200, default 50.' } },
  { method: 'POST', path: '/api/cron/run', group: 'Cron', auth: 'session', summary: 'Run one cron job now. dispatch-heartbeat can be scoped to a company; daily-report and health-check record completed manual runs with company/runner metadata.', body: { job: 'dispatch-heartbeat | daily-report | health-check', companyId: 'uuid optional/null', runnerAgentId: 'uuid optional/null', schedule: { type: 'every | cron | at', intervalSeconds: 10, expression: '*/10 * * * *' } } },
];

const currentArchitecture = {
  model: 'MegaCorps is a company-scoped multi-agent control plane. A company owns departments, authority positions, agents, projects, goals, knowledge, Kanban tasks, recursive task lifecycle records, deterministic tools, external events, cron runs, budget records, and logs. Agents are managed in Agents, assigned and connected through Departments, assigned reusable authority/position prompts through Positions/Agents, and dispatched against tasks/projects through Kanban and Chat.',
  sourceOfTruth: [
    'Companies: company CRUD, memberships, dispatch interval, company goals.',
    'Departments: department membership, no-department assignment, bossId reporting lines, clickable org canvas, department goals.',
    'Positions: reusable company-scoped authority and role prompts. Exactly one active boss position per company should be marked isCompanyBoss; new companies default to CEO. Agents can reference a positionId, and Direct Chat/Kanban inject the position sentence plus the custom position prompt.',
    'Agents: sortable management table, position assignment, runtime preset, adapter config, budgets, pause/resume/fire, direct reports, assigned work, and review queue. Agents do not own project CRUD.',
    'Projects: Project Authority for repo provider, repoUrl, project workPath, branch policy, runtime services, setup/test commands, workspacePathHint, and project goals.',
    'Workspace: company folder manager and authoritative non-coding project-file location paths; runtime-local clone paths are not shared truth.',
    'Knowledge: company-scoped markdown docs by tag for prompt context.',
    'Kanban: normalized task lifecycle, dependency graph, action timeline, assignee/reviewer, project/goal context, work products, same-card message board delegation/review comments, ticket-thread actions/logs, context snapshots, manual run/review, strict DELEGATE Message Board routing, and scoped adapter-session delta prompts for repeat turns. Legacy child-card data remains readable for old tasks but is not the active collaboration workflow.',
    'External Events: waiting_on_external cards release execution locks while CI/CD, deployment, exports, or outside approvals complete; external events wake cards into review, rework, done, or blocked. Agents/runners can provide pollIntervalSeconds so external polling cadence is task-specific rather than tied to the dispatch heartbeat.',
    'Tools: deterministic tool registry lets leaf cards require verified transformations instead of letting agents reimplement fragile parsing or spreadsheet logic by prompt.',
    'Runners: machine runner registry, hashed runner API keys, runner heartbeat/capacity/runtime health, runner task-run claim/complete, and agent-session Ed25519 JWT auth.',
    'Cron: dispatch-heartbeat, daily-report, health-check, company scope, runner metadata, and run history.',
  ],
  surfaces: [
    { name: 'Dashboard', route: '/dashboard', purpose: 'Operating overview, stage counts, recent task logs, recent API events.', primaryApi: ['/api/dashboard', '/api/activity', '/api/task-runs'] },
    { name: 'Companies', route: '/companies', purpose: 'Create/delete companies, memberships, dispatch interval, company goals.', primaryApi: ['/api/companies', '/api/company-memberships', '/api/goals'] },
    { name: 'Departments', route: '/departments', purpose: 'Assign agents to departments, set no-department state, edit reports-to lines, edit selected O-Chart agent properties, and manage department goals.', primaryApi: ['/api/departments', '/api/agents/:id', '/api/goals'] },
    { name: 'Positions', route: '/positions', purpose: 'Manage reusable company position prompts and authority flags including the unique boss position.', primaryApi: ['/api/positions', '/api/agents/:id'] },
    { name: 'Agents', route: '/agents', purpose: 'Sortable and findable table for creating and configuring agents, position assignment, runtime presets, adapter overrides, budgets, direct reports, assigned work, and review queue.', primaryApi: ['/api/agents', '/api/positions', '/api/agent-runtimes', '/api/agent-runtimes/health'] },
    { name: 'Projects', route: '/projects', purpose: 'Dedicated Project Authority workbench for repo/work-path policy, runtime services, branch policy, commands, and project goals.', primaryApi: ['/api/projects', '/api/goals'] },
    { name: 'Workspace', route: '/workspaces', purpose: 'Company folder manager and authority path surface for non-coding project files.', primaryApi: ['/api/companies', '/api/projects'] },
    { name: 'Knowledge', route: '/knowledge', purpose: 'Company-scoped markdown knowledge documents injected by tag/context.', primaryApi: ['/api/knowledge-docs'] },
    { name: 'Kanban', route: '/kanban', purpose: 'Task creation, lifecycle, assignment, project/goal context, message board, DELEGATE/REVIEWER records, ticket thread, work products, rollup, context snapshots/requests, external waits, required tools, integrations, run/review, and adapter-session delta prompts after the first turn.', primaryApi: ['/api/cards', '/api/cards/:id/run', '/api/cards/:id/review', '/api/cards/:id/comments', '/api/cards/:id/delegation-summary', '/api/cards/:id/work-products', '/api/cards/:id/rollup', '/api/cards/:id/context'] },
    { name: 'External Events', route: '/kanban', purpose: 'Track cards waiting on CI/CD, deployment, exports, or outside approvals and wake them through event records.', primaryApi: ['/api/cards/:id/external-waits', '/api/external-events'] },
    { name: 'Tools', route: '/settings', purpose: 'Register deterministic tools and attach required verified transformations to leaf cards.', primaryApi: ['/api/tools', '/api/cards/:id/required-tools'] },
    { name: 'Direct Chat', route: '/chat', purpose: 'Project-scoped or no-project agent chat sessions. First turn bootstraps full context; later turns include a bounded recent transcript while adapter sessions preserve older memory when supported.', primaryApi: ['/api/chat/sessions', '/api/chat/sessions/:id/messages'] },
    { name: 'Cron', route: '/cron', purpose: 'Manual scheduled dispatch heartbeat plus company/runner metadata and cron run history.', primaryApi: ['/api/cron/status', '/api/cron/run', '/api/cron/runs'] },
    { name: 'Logs', route: '/logs', purpose: 'API events, activity, outbound prompt snapshots, heartbeat runs, task runs, and cost events.', primaryApi: ['/api/system-logs', '/api/prompt-logs', '/api/activity', '/api/heartbeat-runs', '/api/task-runs', '/api/cost-events'] },
    { name: 'Admin', route: '/admin', purpose: 'Global account table, roles/status, signup switch, invites, password reset.', primaryApi: ['/api/admin/users', '/api/admin/settings', '/api/auth/invites'] },
    { name: 'Settings', route: '/settings', purpose: 'Tabbed runtime presets, adapter configuration, memberships, budget policy controls.', primaryApi: ['/api/agent-runtimes', '/api/company-memberships', '/api/budget-policies'] },
    { name: 'Help', route: '/help', purpose: 'API catalog, current architecture, adapter types, rate limits, endpoint schemas/examples.', primaryApi: ['/api/help'] },
  ],
  multiAgentNotes: [
    'Use project repoUrl and workPath as the shared coding authority; use runtime local roots only for machine-local clone/cache placement.',
    'Use company/department/project goals directly. There is no separate derived goal layer.',
    'Use company Positions for reusable role-specific prompt injection. Assigned agents receive "You are <position> in <department> department of firm <company>." followed by the custom position prompt.',
    'Use work products with URLs, repo metadata, branches, commits, PRs, previews, reports, screenshots, or artifacts so reviewers can inspect output across machines.',
    'Use waiting_on_external when a card has produced a PR/deploy/export and must wait for outside CI/CD or approval; do not keep execution locks while waiting. Include pollIntervalSeconds when polling is appropriate.',
    'Direct Chat uses full_bootstrap on the first turn and adapter_session_continuation on later turns when a chat adapter session exists. Continuations still include a bounded recent transcript so the agent can answer questions about the current session even if adapter resume memory is incomplete.',
    'Kanban dispatch/review uses full_bootstrap on the first scoped card session and adapter_session_delta on later turns for codex-app and hermes-ssh. The delta refreshes DB truth such as stage, lastError, review feedback, same-card delegation/reviewer records, legacy child-card/dependency state, messages, actions, logs, and work products.',
    'Use TaskContextPackage, context snapshots, and context requests to inspect root mission, parent chain, flow map, main cast, message digest, log digest, and explicit requests for extra scoped context.',
    'Use deterministic tools for fragile data conversion and schema validation; required tools must be registered and required-eligible before attaching them to cards.',
    'Use in_review for completed work that still needs quality review; webhook and runner completion do not bypass a distinct reviewer. Use needs_review for reviewer guidance when an assignee cannot complete a task and has an independent reviewer/manager; top-level dispatch guidance is accepted as done with output preserved.',
    'Use machine runners when work must execute outside the API process. Runner API keys authenticate machines; runner-created agent sessions authenticate agents with Ed25519 JWTs.',
    'Use PUT /api/agents/:id with only departmentId and/or bossId for org changes. Adapter/runtime validation is only applied when runtimeId or adapterType is sent.',
  ],
  remainingGaps: [
    'Persistent Workspace file/folder API is still a product gap; the current Workspace page derives local authority paths from companies/projects.',
    'Runner daemon is scaffold-capable, but production PR provider integration, streaming progress, external polling workers, sandbox policy, and secret-reference management still need deeper hardening.',
    'Hermes SSH receives scoped session ids for Direct Chat and Kanban delta prompts, but true resume behavior depends on the Hermes runtime honoring that session id.',
    'Fine-grained service-account roles beyond machine runners are still needed for external integrations that should not own a full user session.',
  ],
};

function entityFromEndpoint(endpoint: ApiEndpoint): string {
  if (endpoint.path.includes('/companies')) return 'company';
  if (endpoint.path.includes('/departments')) return 'department';
  if (endpoint.path.includes('/positions')) return 'position';
  if (endpoint.path.includes('/work-products')) return 'workProduct';
  if (endpoint.path.includes('/context-snapshots')) return 'taskContextSnapshot';
  if (endpoint.path.includes('/context')) return 'taskContextPackage';
  if (endpoint.path.includes('/rollup')) return 'cardRollup';
  if (endpoint.path.includes('/external-waits')) return 'externalWait';
  if (endpoint.path.includes('/external-events')) return 'externalEvent';
  if (endpoint.path.includes('/required-tools')) return 'cardRequiredTool';
  if (endpoint.path.includes('/integrations')) return 'cardIntegration';
  if (endpoint.path.includes('/tools')) return 'tool';
  if (endpoint.path.includes('/machine-runners')) return 'machineRunner';
  if (endpoint.path.includes('/agent-sessions')) return 'agentSession';
  if (endpoint.path.includes('/cards/:id/actions')) return 'cardAction';
  if (endpoint.path.includes('/cards/:id/delegation-summary')) return 'cardDelegationSummary';
  if (endpoint.path.includes('/api/live')) return 'liveEvent';
  if (endpoint.path.includes('/cards') || endpoint.path.includes('/webhook/task-complete')) return 'card';
  if (endpoint.path.includes('/agents') && !endpoint.path.includes('/agent-runtimes')) return 'agent';
  if (endpoint.path.includes('/agent-runtimes')) return 'agentRuntime';
  if (endpoint.path.includes('/company-memberships')) return 'companyMembership';
  if (endpoint.path.includes('/chat/sessions') && endpoint.path.includes('/messages')) return 'chatMessage';
  if (endpoint.path.includes('/chat/sessions')) return 'chatSession';
  if (endpoint.path.includes('/projects')) return 'project';
  if (endpoint.path.includes('/goals')) return 'goal';
  if (endpoint.path.includes('/knowledge-docs')) return 'knowledgeDoc';
  if (endpoint.path.includes('/budget-policies')) return 'budgetPolicy';
  if (endpoint.path.includes('/approvals')) return 'approval';
  if (endpoint.path.includes('/activity')) return 'activityEvent';
  if (endpoint.path.includes('/system-logs')) return 'apiEvent';
  if (endpoint.path.includes('/prompt-logs')) return 'promptLog';
  if (endpoint.path.includes('/heartbeat-runs')) return 'heartbeatRun';
  if (endpoint.path.includes('/task-runs')) return 'taskRun';
  if (endpoint.path.includes('/cost-events')) return 'costEvent';
  if (endpoint.path.includes('/cron')) return 'cronRun';
  return 'object';
}

function roleDefault(endpoint: ApiEndpoint): 'none' | 'viewer' | 'operator' | 'admin' {
  if (endpoint.auth !== 'session') return 'none';
  if (endpoint.requiredRole) return endpoint.requiredRole;
  if (endpoint.path === '/api/auth/logout') return 'viewer';
  if (endpoint.method !== 'GET') return 'operator';
  if (endpoint.path.endsWith('/test-connection') || endpoint.path.includes('/cron/run')) return 'operator';
  return 'viewer';
}

function responseDefaults(endpoint: ApiEndpoint): Pick<ApiHelpEndpoint, 'responseSchema' | 'responseExample' | 'rateLimit' | 'requiredRole'> {
  if (endpoint.responseSchema !== undefined && endpoint.responseExample !== undefined) {
    return {
      responseSchema: endpoint.responseSchema,
      responseExample: endpoint.responseExample,
      rateLimit: endpoint.rateLimit ?? defaultRateLimit,
      requiredRole: roleDefault(endpoint),
    };
  }

  if (endpoint.path === '/health') {
    return { responseSchema: { ok: 'boolean' }, responseExample: { ok: true }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path === '/api/dashboard') {
    return {
      responseSchema: { stats: 'object', stageCounts: 'Record<CardStatus, number>', recentTaskLogs: 'TaskLog[]', recentApiEvents: 'ApiEvent[]' },
      responseExample: { stats: { cards: 12, agents: 5, activeAgents: 4 }, stageCounts: { todo: 3, in_progress: 2, in_review: 1, needs_review: 1, done: 7, blocked: 1, cancelled: 0 }, recentTaskLogs: [], recentApiEvents: [] },
      rateLimit: endpoint.rateLimit ?? defaultRateLimit,
      requiredRole: roleDefault(endpoint),
    };
  }

  if (endpoint.path === '/api/me') {
    return { responseSchema: { user: { id: 'uuid', email: 'string', role: 'string' }, memberships: 'CompanyMembership[]' }, responseExample: { user: { id: 'user-uuid', email: 'user@example.com', role: 'admin' }, memberships: [{ companyId: 'company-uuid', role: 'admin', status: 'active' }] }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path === '/api/auth/status') {
    return { responseSchema: { signupEnabled: 'boolean', userCount: 'number', firstAccountWillBeAdmin: 'boolean', nextSignupWillBeAdmin: 'boolean' }, responseExample: { signupEnabled: true, userCount: 0, firstAccountWillBeAdmin: true, nextSignupWillBeAdmin: true }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/api/admin/settings')) {
    return {
      responseSchema: {
        signupEnabled: 'boolean',
        apiTokenConfigured: 'boolean',
        apiTokenPreview: 'string | null',
        apiTokenUpdatedAt: 'ISO datetime | null',
        apiTokenOwnerUserId: 'uuid | null',
        apiTokenOwnerEmail: 'string | null',
        apiToken: 'string returned once only after apiTokenAction=rotate',
      },
      responseExample: {
        signupEnabled: true,
        apiTokenConfigured: true,
        apiTokenPreview: 'mca_abcd...xyz789',
        apiTokenUpdatedAt: '2026-06-13T12:00:00.000Z',
        apiTokenOwnerUserId: 'user-uuid',
        apiTokenOwnerEmail: 'admin@example.com',
      },
      rateLimit: endpoint.rateLimit ?? defaultRateLimit,
      requiredRole: roleDefault(endpoint),
    };
  }

  if (endpoint.path.includes('/api/admin/users')) {
    const user = { id: 'user-uuid', email: 'admin@example.com', name: 'Admin', role: 'admin', status: 'active', memberships: [{ companyId: 'company-uuid', companyName: 'Default Company', role: 'admin', status: 'active' }] };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: user }, responseExample: [user], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: { user }, responseExample: { user }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/auth/signup') || endpoint.path.includes('/auth/login') || endpoint.path.includes('/auth/bootstrap')) {
    return { responseSchema: { user: { id: 'uuid', email: 'string', name: 'string', role: 'string' } }, responseExample: { user: { id: 'user-uuid', email: 'user@example.com', name: 'Operator', role: 'admin' } }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.method === 'DELETE' || endpoint.path.includes('/auth/logout')) {
    return { responseSchema: { ok: 'boolean' }, responseExample: { ok: true }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.endsWith('/test-connection')) {
    return { responseSchema: { success: 'boolean', output: 'string', sessionId: 'string', tokensUsed: 'number', costUsd: 'number', durationSeconds: 'number' }, responseExample: { success: true, output: 'OK', sessionId: '20260606_120000_alice', tokensUsed: 24, costUsd: 0.000072, durationSeconds: 3 }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/projects')) {
    const project = { id: 'project-uuid', companyId: 'company-uuid', name: 'Project name', repoProvider: 'github', repoUrl: 'https://github.com/org/repo', workPath: 'apps/server', defaultBranch: 'main', workBranchPattern: 'megacorps/card-{cardId}-{agentSlug}', workspacePathHint: 'optional runtime-local hint only' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: project }, responseExample: [project], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: project, responseExample: project, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/positions')) {
    const position = { id: 'position-uuid', companyId: 'company-uuid', name: 'CEO', slug: 'ceo', prompt: 'Own company-level delegation, escalation, and final confirmation.', description: 'Company boss position.', rank: 0, isCompanyBoss: true, canDelegateAcrossDepartments: true, defaultDepartmentId: null, managerPositionId: null, isActive: true, createdAt: '2026-06-09T00:00:00.000Z', updatedAt: '2026-06-09T00:00:00.000Z' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: position }, responseExample: [position], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: position, responseExample: position, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/external-events')) {
    const event = { id: 'external-event-uuid', cardId: 'card-uuid', provider: 'github', eventType: 'workflow_run.completed', status: 'success', externalUrl: 'https://...', processedAt: '2026-06-09T00:00:00.000Z' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: event }, responseExample: [event], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: { event, newStatus: 'in_review' }, responseExample: { event, newStatus: 'in_review' }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/external-waits')) {
    const wait = { id: 'external-wait-uuid', cardId: 'card-uuid', provider: 'github', waitingFor: 'GitHub Actions CI', status: 'waiting', externalUrl: 'https://...' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: wait }, responseExample: [wait], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: { wait, card: { id: 'card-uuid', columnStatus: 'waiting_on_external' } }, responseExample: { wait, card: { id: 'card-uuid', columnStatus: 'waiting_on_external' } }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/tools')) {
    const tool = { id: 'tool-uuid', companyId: 'company-uuid', name: 'Normalize OUT code', version: '1.0.0', isRequiredEligible: true, isActive: true };
    if (endpoint.path.includes('/required-tools')) return endpoint.method === 'GET'
      ? { responseSchema: { type: 'array', items: { cardTool: 'CardRequiredTool', tool: 'Tool' } }, responseExample: [{ cardTool: { cardId: 'card-uuid', toolId: 'tool-uuid', reason: 'Required parser.' }, tool }], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) }
      : { responseSchema: { ok: 'boolean', toolIds: 'uuid[]' }, responseExample: { ok: true, toolIds: ['tool-uuid'] }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: tool }, responseExample: [tool], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: tool, responseExample: tool, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/rollup')) {
    return { responseSchema: { cardId: 'uuid', childTotal: 'number', counts: 'Record<CardStatus, number>', waitingOnExternal: 'number', rollupPercent: 'number', rollupStatus: 'string', nextAction: 'object | null' }, responseExample: { cardId: 'card-uuid', childTotal: 3, counts: { done: 1, in_progress: 1, waiting_on_external: 1 }, waitingOnExternal: 1, rollupPercent: 70, rollupStatus: 'waiting_on_external', nextAction: { type: 'external', cardId: 'card-uuid' } }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/context-snapshots')) {
    const snapshot = { id: 'context-snapshot-uuid', currentCardId: 'card-uuid', mode: 'dispatch', contextHash: 'sha256', tokenEstimate: 2400 };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: snapshot }, responseExample: [snapshot], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: snapshot, responseExample: snapshot, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/context-requests')) {
    const contextRequest = { id: 'context-request-uuid', currentCardId: 'card-uuid', agentId: 'agent-uuid', requestedCardIds: ['related-card-uuid'], requestedLogKinds: ['task_logs'], reason: 'Need sibling implementation logs.', status: 'open', resolvedAt: null };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: contextRequest }, responseExample: [contextRequest], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: contextRequest, responseExample: contextRequest, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/context')) {
    return { responseSchema: { rootMission: 'object', parentChain: 'array', currentCard: 'object', flowMap: 'array', mainCast: 'array', messageDigest: 'array', logDigest: 'array', contextRequests: 'array', rollup: 'object' }, responseExample: { rootMission: { id: 'root-card-uuid', title: 'Large task' }, parentChain: [], flowMap: [], mainCast: [], messageDigest: [], logDigest: [], contextRequests: [], rollup: { rollupPercent: 50 } }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/integrations')) {
    const integration = { id: 'integration-uuid', parentCardId: 'card-uuid', summary: 'Integrated accepted legacy child-card outputs.', status: 'accepted', conflictNotes: null };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: integration }, responseExample: [integration], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: integration, responseExample: integration, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path === '/api/agent-runtimes/health') {
    const health = { runtimeId: 'runtime-uuid', name: 'Codex App Server', adapterType: 'codex-app', status: 'ready', isActive: true, agents: 1, activeAgents: 1, busyAgents: 0, lastRunAt: null, lastRunStatus: null, lastError: null, capabilities: ['codex-app-server', 'json-rpc', 'thread-turn-session'] };
    return { responseSchema: { type: 'array', items: health }, responseExample: [health], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/agent-runtimes')) {
    const runtime = { id: 'runtime-uuid', companyId: 'company-uuid', name: 'Codex App Server', adapterType: 'codex-app', localWorkspaceRoot: '/home/alice/workspaces', localScratchRoot: '/tmp/megacorps', config: { codexTransport: 'stdio', codexCommand: 'codex', codexArgs: 'app-server', codexModel: 'optional model' }, isActive: true };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: runtime }, responseExample: [runtime], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: runtime, responseExample: runtime, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/machine-runners')) {
    const runner = { id: 'runner-uuid', companyId: 'company-uuid', name: 'Runner host', slug: 'runner-host', status: 'online', supportedRuntimes: ['hermes-ssh', 'codex-app'], maxConcurrent: 2, activeSlots: 0, lastHeartbeatAt: '2026-06-09T00:00:00.000Z' };
    if (endpoint.path.endsWith('/rotate-key') || endpoint.method === 'POST') return { responseSchema: { runner, apiKey: 'string returned once when created/rotated' }, responseExample: { runner, apiKey: 'mcr_example' }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: runner }, responseExample: [runner], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: runner, responseExample: runner, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path === '/api/runner/me' || endpoint.path === '/api/runner/heartbeat') {
    const runner = { id: 'runner-uuid', companyId: 'company-uuid', name: 'Runner host', slug: 'runner-host', status: 'online', supportedRuntimes: ['hermes-ssh'], maxConcurrent: 2, activeSlots: 0 };
    return { responseSchema: runner, responseExample: runner, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/api/runner/agent-sessions')) {
    const session = { id: 'session-uuid', agentId: 'agent-uuid', machineRunnerId: 'runner-uuid', cardId: 'card-uuid | null', taskRunId: 'task-run-uuid | null', sessionKind: 'task', status: 'active', fingerprint: 'sha256-prefix' };
    return { responseSchema: session, responseExample: session, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path === '/api/agent/me') {
    return { responseSchema: { session: 'AgentSession', agent: 'Agent' }, responseExample: { session: { id: 'session-uuid', status: 'active' }, agent: { id: 'agent-uuid', name: 'Worker' } }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/api/agent/cards')) {
    return { responseSchema: { type: 'card', id: 'uuid', columnStatus: 'CardStatus' }, responseExample: { id: 'card-uuid', columnStatus: endpoint.path.endsWith('/claim') ? 'in_progress' : endpoint.path.endsWith('/release') ? 'todo' : 'in_review' }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/cards/:id/logs')) {
    return { responseSchema: { type: 'array', items: { cardId: 'uuid', agentId: 'uuid | null', type: 'string', status: 'queued | running | success | warning | failed', message: 'string', output: 'string | null' } }, responseExample: [{ cardId: 'card-uuid', type: 'stage', status: 'success', message: 'Stage changed from todo to in_progress.' }], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }
  if (endpoint.path.includes('/cards/:id/subtree')) {
    return { responseSchema: { type: 'array', items: { id: 'uuid', parentCardId: 'uuid', title: 'string', columnStatus: 'CardStatus', assigneeId: 'uuid | null', reviewerId: 'uuid | null', depth: 'number', childCount: 'number', updatedAt: 'ISO datetime' } }, responseExample: [{ id: 'legacy-child-card-uuid', parentCardId: 'card-uuid', title: 'Legacy child task', columnStatus: 'in_progress', assigneeId: 'agent-uuid', reviewerId: null, depth: 1, childCount: 2, updatedAt: '2026-06-09T00:00:00.000Z' }], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/cards/:id/actions')) {
    return { responseSchema: { type: 'array', items: { id: 'uuid', cardId: 'uuid', actorType: 'user | machine | agent:worker | agent:reviewer | system', actorId: 'uuid | system label', action: 'claim | submit_review | approve | manual_move | ...', fromStatus: 'CardStatus | null', toStatus: 'CardStatus | null', detail: 'string | null', metadata: 'object' } }, responseExample: [{ id: 'action-uuid', cardId: 'card-uuid', actorType: 'machine', actorId: 'runner-uuid', action: 'claim', fromStatus: 'todo', toStatus: 'in_progress', detail: 'Runner claimed dispatch task run.', metadata: { runnerId: 'runner-uuid' } }], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/cards/:id/delegation-summary')) {
    return {
      responseSchema: {
        phaseAssigneeId: 'uuid | null',
        phaseReviewerId: 'uuid | null',
        phaseStatus: 'queued | running | waiting | submitted | approved | rejected | failed | cancelled | null',
        phaseUpdatedAt: 'ISO datetime | null',
        phaseSourceAction: 'string | null',
        phaseSourceCommentId: 'uuid | null',
      },
      responseExample: {
        phaseAssigneeId: 'agent-uuid',
        phaseReviewerId: 'reviewer-uuid',
        phaseStatus: 'submitted',
        phaseUpdatedAt: '2026-06-06T00:00:00.000Z',
        phaseSourceAction: 'delegate_report',
        phaseSourceCommentId: 'comment-uuid',
      },
      rateLimit: endpoint.rateLimit ?? defaultRateLimit,
      requiredRole: roleDefault(endpoint),
    };
  }

  if (endpoint.path.includes('/cards/:id/comments')) {
    const comment = { id: 'comment-uuid', cardId: 'card-uuid', parentCommentId: 'comment-uuid | null', authorType: 'user | agent | system', agentId: 'uuid | null', assigneeAgentId: 'uuid | null', reviewerAgentId: 'uuid | null', reviewerScope: 'phase | final | null', delegationStatus: 'queued | running | waiting | submitted | approved | rejected | failed | null', body: 'Comment body', action: 'comment | delegate_request | delegate_report | phase_review_approved | final_review_approved', createdAt: '2026-06-06T00:00:00.000Z' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: comment }, responseExample: [comment], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: comment, responseExample: comment, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/cards/:id/work-products')) {
    const product = { id: 'work-product-uuid', cardId: 'card-uuid', type: 'pull_request', title: 'PR for task', url: 'https://...', repoUrl: 'https://github.com/org/repo', branch: 'megacorps/card-1234-alice', commitSha: 'abc123', pullRequestUrl: 'https://github.com/org/repo/pull/42' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: product }, responseExample: [product], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: product, responseExample: product, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.endsWith('/decompose')) {
    return { responseSchema: { error: 'child_cards_disabled', message: 'string' }, responseExample: { error: 'child_cards_disabled', message: 'Kanban no longer creates child cards. Use same-card Message Board DELEGATE / REVIEWER records instead.' }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/task-runs') || endpoint.path.endsWith('/run') || endpoint.path.endsWith('/review')) {
    const taskRun = { id: 'task-run-uuid', companyId: 'company-uuid', cardId: 'card-uuid', agentId: 'agent-uuid | null', heartbeatRunId: 'heartbeat-run-uuid | null', kind: 'dispatch | review', source: 'manual | loop | startup | queue', status: 'queued | running | success | failed | cancelled', attemptNumber: 1, createdAt: '2026-06-06T00:00:00.000Z' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: taskRun }, responseExample: [taskRun], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: taskRun, responseExample: taskRun, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/prompt-logs')) {
    const promptLog = { id: 'prompt-log-uuid', companyId: 'company-uuid', agentId: 'agent-uuid | null', cardId: 'card-uuid | null', chatSessionId: 'chat-session-uuid | null', source: 'dispatch | review | chat | test', adapterType: 'codex-app', title: 'Task title', prompt: 'Redacted outbound prompt snapshot.', promptHash: 'sha256', metadata: {}, createdAt: '2026-06-06T00:00:00.000Z' };
    return { responseSchema: { type: 'array', items: promptLog }, responseExample: [promptLog], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.endsWith('/cancel')) {
    return { responseSchema: { type: 'card', id: 'uuid', columnStatus: 'cancelled', updatedAt: 'ISO datetime' }, responseExample: { id: 'card-uuid', columnStatus: 'cancelled', lastError: 'Cancelled by operator.' }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/chat/sessions/:id/messages')) {
    const message = { id: 'message-uuid', sessionId: 'session-uuid', role: 'user | agent | system', body: 'Message body', createdAt: '2026-06-06T00:00:00.000Z' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: message }, responseExample: [message], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: { userMessage: message, agentMessage: message }, responseExample: { userMessage: { ...message, role: 'user' }, agentMessage: { ...message, role: 'agent', body: 'Agent reply' } }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/cron/status')) {
    return { responseSchema: { enabled: 'boolean', running: 'boolean', intervalMs: 'number', lastRunAt: 'string | null', companyTicks: 'Array<{ companyId, lastTickMs }>' }, responseExample: { enabled: true, running: false, intervalMs: 30000, lastRunAt: '2026-06-06T00:00:00.000Z', companyTicks: [] }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/cron/run')) {
    return { responseSchema: { name: 'string', status: 'success | failed', dispatched: 'number', reviewed: 'number', error: 'string | null' }, responseExample: { name: 'dispatch-heartbeat', status: 'success', dispatched: 1, reviewed: 0, error: null }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  const entity = entityFromEndpoint(endpoint);
  if (endpoint.method === 'GET' && !endpoint.path.includes(':id')) {
    return { responseSchema: { type: 'array', items: { type: entity, id: 'uuid', createdAt: 'ISO datetime' } }, responseExample: [], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/webhook/task-complete')) {
    return { responseSchema: { ok: 'boolean', duplicate: 'boolean optional', cardId: 'uuid', taskRunId: 'uuid optional', requestedStatus: 'CardStatus', newStatus: 'CardStatus | message delegation status', reviewerId: 'uuid | null optional', delegated: 'boolean optional', delegationFailed: 'boolean optional', messageDelegationCount: 'number optional' }, responseExample: { ok: true, cardId: 'card-uuid', taskRunId: 'task-run-uuid', requestedStatus: 'done', newStatus: 'in_review', reviewerId: 'reviewer-uuid', delegated: false, delegationFailed: false, messageDelegationCount: 0 }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  return {
    responseSchema: { type: entity, id: 'uuid', createdAt: 'ISO datetime', updatedAt: 'ISO datetime optional' },
    responseExample: { id: `${entity}-uuid`, createdAt: '2026-06-06T00:00:00.000Z' },
    rateLimit: endpoint.rateLimit ?? defaultRateLimit,
    requiredRole: roleDefault(endpoint),
  };
}

function endpointWithDefaults(endpoint: ApiEndpoint): ApiHelpEndpoint {
  return { ...endpoint, ...responseDefaults(endpoint) };
}

export function apiHelpCatalog() {
  const catalogEndpoints = endpoints.map(endpointWithDefaults);
  return {
    service: 'MegaCorps API',
    help: {
      json: 'GET /api/help',
      markdown: 'GET /api/help?format=markdown',
      ui: '/help',
    },
    architecture: currentArchitecture,
    auth: {
      mode: 'Cookie session with company membership role checks for human/API management. Admin-created direct API tokens can call session-auth management endpoints with Authorization: Bearer MEGACORPS_API_TOKEN and inherit the owner user memberships. Runner endpoints use Authorization: Bearer MEGACORPS_RUNNER_KEY or X-MegaCorps-Runner-Key against hashed machine runner keys. Agent-session endpoints use Ed25519-signed JWTs from runner-created sessions. Signup is DB-configured and defaults to enabled; if no active admin exists, the next signup becomes global admin and default-company admin. If BOOTSTRAP_TOKEN is configured, POST /api/auth/bootstrap can create or recover the admin account only while no active admin exists. Viewer can read data for visible companies; company operator/admin is required for company-scoped mutation, run/review, adapter tests, runtime edits, and budget decisions. Manual cron remains an operator system action.',
      login: 'POST /api/auth/login',
      apiToken: 'Set in Admin > general. Send Authorization: Bearer <token> to call session-auth endpoints without browser cookies.',
      signup: 'POST /api/auth/signup',
      bootstrap: 'POST /api/auth/bootstrap',
      admin: 'GET/PUT /api/admin/settings and GET/PUT /api/admin/users require global admin role.',
    },
    rateLimits: {
      enforced: process.env.RATE_LIMIT_ENABLED !== 'false',
      summary: defaultRateLimit,
      productionRecommendation: 'Keep reverse-proxy limits in front of the in-app limiter for production defense in depth, especially for auth, chat, webhooks, adapter tests, delete operations, and manual cron.',
    },
    kanban: {
      stages: cardStatuses,
      legacyAliases: legacyCardStatusAliases,
      note: 'backlog and todo are merged. Send todo for new work; legacy backlog input is accepted and normalized to todo. The web board visually groups in_review/needs_review/waiting_on_external and blocked/cancelled while the API preserves canonical statuses. Kanban adapter prompts use full_bootstrap for the first scoped card turn and adapter_session_delta for later codex-app/hermes-ssh turns.',
    },
    adapters: agentAdapterTypes,
    cli: cliHelp,
    endpoints: catalogEndpoints,
  };
}

function jsonBlock(value: unknown): string {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function fencedBlock(language: string, value: string): string {
  return `\n\`\`\`${language}\n${value}\n\`\`\``;
}

export function apiHelpMarkdown(): string {
  const catalog = apiHelpCatalog();
  const lines = [
    '# MegaCorps API Help',
    '',
    `JSON catalog: ${catalog.help.json}`,
    `Markdown catalog: ${catalog.help.markdown}`,
    `UI page: ${catalog.help.ui}`,
    '',
    '## Auth',
    catalog.auth.mode,
    '',
    '## Current Architecture',
    catalog.architecture.model,
    '',
    '### Source Of Truth',
    ...catalog.architecture.sourceOfTruth.map((item) => `- ${item}`),
    '',
    '### UI Surfaces',
    ...catalog.architecture.surfaces.map((surface) => `- ${surface.name} (${surface.route}): ${surface.purpose} APIs: ${surface.primaryApi.join(', ')}`),
    '',
    '### Multi-Agent Notes',
    ...catalog.architecture.multiAgentNotes.map((item) => `- ${item}`),
    '',
    '### Remaining Gaps',
    ...catalog.architecture.remainingGaps.map((item) => `- ${item}`),
    '',
    '## Rate Limits',
    `Enforced: ${catalog.rateLimits.enforced ? 'yes' : 'no'}`,
    catalog.rateLimits.summary,
    `Production recommendation: ${catalog.rateLimits.productionRecommendation}`,
    '',
    '## Kanban Stages',
    `Canonical stages: ${catalog.kanban.stages.join(', ')}`,
    'Legacy alias: backlog -> todo',
    '',
    '## CLI Commands',
    `Package: ${catalog.cli.package}`,
    `Run with npm: ${catalog.cli.runWithNpm}`,
    '',
    '### CLI Environment',
    ...catalog.cli.env.map((item) => `- ${item}`),
    '',
    '### YAML Manifest Example',
    fencedBlock('yaml', catalog.cli.manifestExample),
    '',
    ...catalog.cli.commands.flatMap((command) => [
      `### megacorps ${command.command}`,
      command.summary,
      `Auth: ${command.auth}`,
      `Env: ${command.env.join(', ') || 'none'}`,
      `Flags: ${JSON.stringify(command.flags)}`,
      'Example:',
      fencedBlock('powershell', command.example),
      'Lifecycle:',
      ...command.lifecycle.map((item) => `- ${item}`),
      '',
    ]),
    '',
    '## Endpoints',
  ];

  const groups = Array.from(new Set(catalog.endpoints.map((endpoint) => endpoint.group)));
  for (const group of groups) {
    lines.push('', `### ${group}`);
    for (const endpoint of catalog.endpoints.filter((item) => item.group === group)) {
      lines.push('', `#### ${endpoint.method} ${endpoint.path}`, endpoint.summary, `Auth: ${endpoint.auth}`, `Required role: ${endpoint.requiredRole}`);
      if (endpoint.params) lines.push(`Params: ${JSON.stringify(endpoint.params)}`);
      if (endpoint.query) lines.push(`Query: ${JSON.stringify(endpoint.query)}`);
      if (endpoint.body) lines.push('Body:', jsonBlock(endpoint.body));
      if (endpoint.response) lines.push(`Response: ${endpoint.response}`);
      lines.push('Response schema:', jsonBlock(endpoint.responseSchema), 'Response example:', jsonBlock(endpoint.responseExample), `Rate limit: ${endpoint.rateLimit}`);
      if (endpoint.notes?.length) lines.push(...endpoint.notes.map((note) => `- ${note}`));
    }
  }
  return `${lines.join('\n')}\n`;
}
