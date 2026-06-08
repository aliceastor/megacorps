import { agentAdapterTypes, cardStatuses, legacyCardStatusAliases } from '@megacorps/shared';

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

type ApiEndpoint = {
  method: ApiMethod;
  path: string;
  group: string;
  auth: 'none' | 'session';
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

const defaultRateLimit = 'In-app IP-based rate limiting is enforced by route bucket unless RATE_LIMIT_ENABLED=false. Defaults: auth 12/min, chat 40/min, webhook 120/min, operator 20/min, writes 120/min, reads 600/min.';

const endpoints: ApiEndpoint[] = [
  { method: 'GET', path: '/health', group: 'System', auth: 'none', summary: 'Read server health.', response: '{ ok: true }' },
  { method: 'GET', path: '/api/help', group: 'System', auth: 'none', summary: 'List MegaCorps API endpoints and usage.', query: { format: 'Optional. Use markdown or md for text/markdown output.' }, responseSchema: { service: 'string', help: 'object', auth: 'object', rateLimits: 'object', kanban: 'object', adapters: 'string[]', endpoints: 'ApiHelpEndpoint[]' }, responseExample: { service: 'MegaCorps API', endpoints: [{ method: 'GET', path: '/health', responseSchema: { ok: 'boolean' }, responseExample: { ok: true } }] } },
  { method: 'GET', path: '/api/auth/status', group: 'Auth', auth: 'none', summary: 'Read public onboarding state. Signup is DB-configured and defaults to enabled; signup becomes admin when no active admin exists.' },
  { method: 'POST', path: '/api/auth/bootstrap', group: 'Auth', auth: 'none', summary: 'Bootstrap or recover the global admin account when BOOTSTRAP_TOKEN is configured and no active admin exists.', body: { token: 'BOOTSTRAP_TOKEN value or send X-MegaCorps-Bootstrap-Token header', email: 'admin@example.com', name: 'Admin', password: 'at least 8 chars' } },
  { method: 'POST', path: '/api/auth/signup', group: 'Auth', auth: 'none', summary: 'Create a user when DB auth.signup_enabled=true. If no active admin exists, this account becomes global admin and default-company admin.', body: { email: 'user@example.com', name: 'Operator', password: 'at least 8 chars' } },
  { method: 'POST', path: '/api/auth/login', group: 'Auth', auth: 'none', summary: 'Log in and set the session cookie.', body: { email: 'user@example.com', password: 'password' } },
  { method: 'POST', path: '/api/auth/logout', group: 'Auth', auth: 'session', summary: 'Clear the session cookie.' },
  { method: 'POST', path: '/api/auth/invites', group: 'Auth', auth: 'session', requiredRole: 'admin', summary: 'Create a one-time company invite token. The raw token is returned once and only its SHA-256 hash is stored.', body: { companyId: 'uuid', email: 'operator@example.com', name: 'Optional name', role: 'viewer | operator | admin', expiresInDays: 7 } },
  { method: 'POST', path: '/api/auth/accept-invite', group: 'Auth', auth: 'none', summary: 'Accept a one-time invite token and create or activate the user membership.', body: { token: 'invite token', name: 'Optional display name', password: 'at least 12 chars' } },
  { method: 'GET', path: '/api/me', group: 'Auth', auth: 'session', summary: 'Read the current authenticated user.' },
  { method: 'GET', path: '/api/admin/settings', group: 'Admin', auth: 'session', requiredRole: 'admin', summary: 'Read global admin settings such as DB-backed signup enablement.' },
  { method: 'PUT', path: '/api/admin/settings', group: 'Admin', auth: 'session', requiredRole: 'admin', summary: 'Update global admin settings.', body: { signupEnabled: true } },
  { method: 'GET', path: '/api/admin/users', group: 'Admin', auth: 'session', requiredRole: 'admin', summary: 'List all user accounts and company memberships.' },
  { method: 'PUT', path: '/api/admin/users/:id', group: 'Admin', auth: 'session', requiredRole: 'admin', summary: 'Update an account name, global role, active/disabled status, or reset password. The last active admin cannot be demoted or disabled.', params: { id: 'User UUID.' }, body: { name: 'Operator', role: 'viewer | operator | admin', status: 'active | disabled', password: 'optional reset password' } },

  { method: 'GET', path: '/api/dashboard', group: 'Overview', auth: 'session', summary: 'Read dashboard stats, stage counts, recent task logs, and recent API events.' },
  { method: 'GET', path: '/api/system-logs', group: 'Logs', auth: 'session', summary: 'Read persisted API lifecycle logs for the current user.', query: { limit: '1-500, default 100.' } },
  { method: 'GET', path: '/api/activity', group: 'Logs', auth: 'session', summary: 'Read product activity/audit events.', query: { companyId: 'Optional company UUID.', entityType: 'Optional entity type.', limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/heartbeat-runs', group: 'Logs', auth: 'session', summary: 'Read agent heartbeat/run history.', query: { companyId: 'Optional company UUID.', cardId: 'Optional task UUID.', agentId: 'Optional agent UUID.', status: 'Optional run status.', limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/task-runs', group: 'Logs', auth: 'session', summary: 'Read queued/running/completed task-run attempts.', query: { companyId: 'Optional company UUID.', cardId: 'Optional task UUID.', agentId: 'Optional agent UUID.', kind: 'dispatch | review.', status: 'queued | running | success | failed | cancelled.', limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/cost-events', group: 'Budget', auth: 'session', summary: 'Read recorded model/runtime cost events.', query: { companyId: 'Optional company UUID.', agentId: 'Optional agent UUID.', cardId: 'Optional task UUID.', limit: '1-500, default 200.' } },

  { method: 'GET', path: '/api/companies', group: 'Companies', auth: 'session', summary: 'List companies visible to the current user memberships.' },
  { method: 'POST', path: '/api/companies', group: 'Companies', auth: 'session', summary: 'Create a company.', body: { name: 'Acme AI', slug: 'acme-ai', mission: 'Build useful things.', dispatchIntervalSeconds: 10, autoDispatchEnabled: true } },
  { method: 'PUT', path: '/api/companies/:id', group: 'Companies', auth: 'session', summary: 'Update company settings.', params: { id: 'Company UUID.' }, body: { name: 'Acme AI', slug: 'acme-ai', mission: 'Updated mission.', dispatchIntervalSeconds: 30, autoDispatchEnabled: true } },
  { method: 'GET', path: '/api/company-memberships', group: 'Companies', auth: 'session', summary: 'List memberships for visible companies.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/company-memberships', group: 'Companies', auth: 'session', requiredRole: 'admin', summary: 'Add or update a company membership by userId or email.', body: { companyId: 'uuid', email: 'operator@example.com', role: 'viewer | operator | admin', status: 'active' } },
  { method: 'PUT', path: '/api/company-memberships/:id', group: 'Companies', auth: 'session', requiredRole: 'admin', summary: 'Update a company membership role/status.', params: { id: 'Membership UUID.' }, body: { role: 'viewer | operator | admin', status: 'active | disabled' } },
  { method: 'DELETE', path: '/api/company-memberships/:id', group: 'Companies', auth: 'session', requiredRole: 'admin', summary: 'Disable a company membership.', params: { id: 'Membership UUID.' } },
  { method: 'GET', path: '/api/departments', group: 'Companies', auth: 'session', summary: 'List departments visible to the current user.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/departments', group: 'Companies', auth: 'session', summary: 'Create a department.', body: { companyId: 'uuid', name: 'Engineering', slug: 'engineering' } },

  { method: 'GET', path: '/api/cards', group: 'Kanban', auth: 'session', summary: 'List Kanban tasks visible to the current user.', query: { companyId: 'Optional company UUID.', status: `Optional. One of ${cardStatuses.join(', ')}. Legacy backlog maps to todo.`, assigneeId: 'Optional agent UUID.', tag: 'Optional tag.', priority: 'urgent | high | normal | low.', limit: 'Default 100.', offset: 'Default 0.' } },
  { method: 'POST', path: '/api/cards', group: 'Kanban', auth: 'session', summary: 'Create a Kanban task. New tasks default to todo.', body: { companyId: 'uuid optional', title: 'Task title', body: 'Full task detail', priority: 'normal', tags: ['backend'], assigneeId: null, reviewerId: null, requiresApproval: false } },
  { method: 'PUT', path: '/api/cards/:id', group: 'Kanban', auth: 'session', summary: 'Update a Kanban task. Include updatedAt for optimistic locking.', params: { id: 'Task UUID.' }, body: { title: 'Updated title', body: 'Updated detail', columnStatus: 'todo', updatedAt: 'ISO datetime from existing card' } },
  { method: 'DELETE', path: '/api/cards/:id', group: 'Kanban', auth: 'session', summary: 'Archive a task while preserving historical logs, runs, and cost records.', params: { id: 'Task UUID.' } },
  { method: 'GET', path: '/api/cards/:id/logs', group: 'Kanban', auth: 'session', summary: 'Read full task logs.', params: { id: 'Task UUID.' } },
  { method: 'GET', path: '/api/cards/:id/comments', group: 'Kanban', auth: 'session', summary: 'Read task message board comments.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/comments', group: 'Kanban', auth: 'session', summary: 'Add a task message board comment or intervention.', params: { id: 'Task UUID.' }, body: { body: 'Instruction or comment', action: 'comment | agent_note | pause_agent | send_to_agent | continue_run', agentId: 'optional agent UUID for agent-authored note' } },
  { method: 'POST', path: '/api/cards/:id/run', group: 'Kanban', auth: 'session', summary: 'Queue a dispatch task-run attempt for the background worker.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/review', group: 'Kanban', auth: 'session', summary: 'Queue a review task-run attempt for the background worker.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/decompose', group: 'Kanban', auth: 'session', summary: 'Split a task into sub-tasks.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/webhook/task-complete', group: 'Kanban', auth: 'none', summary: 'External agent callback to report task progress/completion.', body: { cardId: 'uuid', status: 'done | blocked | in_review | in_progress | todo', summary: 'Short result', output: 'Full output/log', costUsd: 0.05 } },

  { method: 'GET', path: '/api/agents', group: 'Agents', auth: 'session', summary: 'List agents visible to the current user.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/agents', group: 'Agents', auth: 'session', summary: 'Create an agent.', body: { companyId: 'uuid optional', departmentId: 'uuid optional', name: 'Builder', slug: 'builder', role: 'worker', title: 'Backend Engineer', adapterType: 'mock', runtimeId: 'uuid optional', bossId: null, budgetPerTask: 1, budgetMonthly: 20 } },
  { method: 'PUT', path: '/api/agents/:id', group: 'Agents', auth: 'session', summary: 'Update an agent, adapter config, runtime, and reporting line.', params: { id: 'Agent UUID.' } },
  { method: 'DELETE', path: '/api/agents/:id', group: 'Agents', auth: 'session', summary: 'Archive an agent and release current task assignments while preserving historical runs.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/pause', group: 'Agents', auth: 'session', summary: 'Pause an agent.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/resume', group: 'Agents', auth: 'session', summary: 'Resume an agent.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/reset-session', group: 'Agents', auth: 'session', summary: 'Clear an agent session id.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/test-connection', group: 'Agents', auth: 'session', summary: 'Test the selected adapter/runtime connection.', params: { id: 'Agent UUID.' } },
  { method: 'GET', path: '/api/agent-runtimes', group: 'Agents', auth: 'session', summary: 'List company-scoped runtime presets.', query: { companyId: 'Optional company UUID.' } },
  { method: 'GET', path: '/api/agent-runtimes/health', group: 'Agents', auth: 'session', summary: 'Read runtime health summaries, attached agent counts, last run status, and adapter capabilities.' },
  { method: 'POST', path: '/api/agent-runtimes', group: 'Agents', auth: 'session', summary: 'Create a runtime preset.', body: { name: 'Hermes SSH', adapterType: 'hermes-ssh', isActive: true, config: { sshHost: 'hermes.example.internal', sshUser: 'root', sshPort: 22, sshKeyPath: '/home/megacorps/.ssh/id_ed25519', hermesCommand: 'hermes', megacorpsApiUrl: 'https://megacorps.example.com' } } },
  { method: 'PUT', path: '/api/agent-runtimes/:id', group: 'Agents', auth: 'session', summary: 'Update a runtime preset.', params: { id: 'Runtime UUID.' } },
  { method: 'DELETE', path: '/api/agent-runtimes/:id', group: 'Agents', auth: 'session', summary: 'Delete a runtime preset.', params: { id: 'Runtime UUID.' } },

  { method: 'GET', path: '/api/chat/sessions', group: 'Chat', auth: 'session', summary: 'List direct-chat sessions.', query: { companyId: 'Optional company UUID.', agentId: 'Optional agent UUID.', limit: '1-200, default 100.' } },
  { method: 'POST', path: '/api/chat/sessions', group: 'Chat', auth: 'session', summary: 'Create a direct-chat session with an agent.', body: { companyId: 'uuid', agentId: 'uuid', title: 'Session title optional' } },
  { method: 'GET', path: '/api/chat/sessions/:id/messages', group: 'Chat', auth: 'session', summary: 'Read chat messages.', params: { id: 'Chat session UUID.' } },
  { method: 'POST', path: '/api/chat/sessions/:id/messages', group: 'Chat', auth: 'session', summary: 'Send a message to an agent and store the response.', params: { id: 'Chat session UUID.' }, body: { body: 'Message for the agent' } },

  { method: 'GET', path: '/api/projects', group: 'Context', auth: 'session', summary: 'List visible projects.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/projects', group: 'Context', auth: 'session', summary: 'Create a project.', body: { companyId: 'uuid optional', name: 'Project name', description: 'Optional description' } },
  { method: 'GET', path: '/api/goals', group: 'Context', auth: 'session', summary: 'List visible goals.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/goals', group: 'Context', auth: 'session', summary: 'Create a goal.', body: { companyId: 'uuid optional', title: 'Goal title', body: 'Goal detail' } },
  { method: 'GET', path: '/api/knowledge-docs', group: 'Context', auth: 'session', summary: 'List visible knowledge documents.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/knowledge-docs', group: 'Context', auth: 'session', summary: 'Create a knowledge document.', body: { companyId: 'uuid', title: 'Runbook', tags: ['ops'], body: 'Document body' } },
  { method: 'PUT', path: '/api/knowledge-docs/:id', group: 'Context', auth: 'session', summary: 'Update a knowledge document.', params: { id: 'Knowledge document UUID.' } },
  { method: 'DELETE', path: '/api/knowledge-docs/:id', group: 'Context', auth: 'session', summary: 'Delete a knowledge document.', params: { id: 'Knowledge document UUID.' } },

  { method: 'GET', path: '/api/budget-policies', group: 'Budget', auth: 'session', summary: 'List budget policies.', query: { companyId: 'Optional company UUID.', agentId: 'Optional agent UUID.' } },
  { method: 'POST', path: '/api/budget-policies', group: 'Budget', auth: 'session', summary: 'Create a budget policy.', body: { companyId: 'uuid', agentId: null, name: 'Monthly cap', monthlyLimitUsd: 100, perTaskLimitUsd: 2, warnAtPercent: 80, hardStop: true, isActive: true } },
  { method: 'PUT', path: '/api/budget-policies/:id', group: 'Budget', auth: 'session', summary: 'Update a budget policy.', params: { id: 'Policy UUID.' } },
  { method: 'DELETE', path: '/api/budget-policies/:id', group: 'Budget', auth: 'session', summary: 'Delete a budget policy.', params: { id: 'Policy UUID.' } },
  { method: 'GET', path: '/api/approvals', group: 'Budget', auth: 'session', summary: 'List approvals.', query: { companyId: 'Optional company UUID.', status: 'Optional approval status.', cardId: 'Optional task UUID.', limit: '1-500, default 200.' } },
  { method: 'PUT', path: '/api/approvals/:id', group: 'Budget', auth: 'session', summary: 'Decide an approval.', params: { id: 'Approval UUID.' }, body: { status: 'approved | rejected | revision_requested | cancelled', decisionNote: 'Optional note' } },

  { method: 'GET', path: '/api/cron/status', group: 'Cron', auth: 'session', requiredRole: 'operator', summary: 'Read dispatch loop status.' },
  { method: 'GET', path: '/api/cron/runs', group: 'Cron', auth: 'session', requiredRole: 'operator', summary: 'Read cron/heartbeat loop runs.', query: { limit: '1-200, default 50.' } },
  { method: 'POST', path: '/api/cron/run', group: 'Cron', auth: 'session', summary: 'Run one dispatch/review heartbeat tick now.' },
];

function entityFromEndpoint(endpoint: ApiEndpoint): string {
  if (endpoint.path.includes('/companies')) return 'company';
  if (endpoint.path.includes('/departments')) return 'department';
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
  if (endpoint.path.includes('/heartbeat-runs')) return 'heartbeatRun';
  if (endpoint.path.includes('/task-runs')) return 'taskRun';
  if (endpoint.path.includes('/cost-events')) return 'costEvent';
  if (endpoint.path.includes('/cron')) return 'cronRun';
  return 'object';
}

function roleDefault(endpoint: ApiEndpoint): 'none' | 'viewer' | 'operator' | 'admin' {
  if (endpoint.auth === 'none') return 'none';
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
      responseExample: { stats: { cards: 12, agents: 5, activeAgents: 4 }, stageCounts: { todo: 3, in_progress: 2, in_review: 1, done: 7, blocked: 1 }, recentTaskLogs: [], recentApiEvents: [] },
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
    return { responseSchema: { signupEnabled: 'boolean' }, responseExample: { signupEnabled: true }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
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

  if (endpoint.path.includes('/cards/:id/logs')) {
    return { responseSchema: { type: 'array', items: { cardId: 'uuid', agentId: 'uuid | null', type: 'string', status: 'queued | running | success | failed', message: 'string', output: 'string | null' } }, responseExample: [{ cardId: 'card-uuid', type: 'stage', status: 'success', message: 'Stage changed from todo to in_progress.' }], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/cards/:id/comments')) {
    const comment = { id: 'comment-uuid', cardId: 'card-uuid', authorType: 'user | agent | system', body: 'Comment body', action: 'comment', createdAt: '2026-06-06T00:00:00.000Z' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: comment }, responseExample: [comment], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: comment, responseExample: comment, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/task-runs') || endpoint.path.endsWith('/run') || endpoint.path.endsWith('/review')) {
    const taskRun = { id: 'task-run-uuid', companyId: 'company-uuid', cardId: 'card-uuid', agentId: 'agent-uuid | null', heartbeatRunId: 'heartbeat-run-uuid | null', kind: 'dispatch | review', source: 'manual | loop | startup | queue', status: 'queued | running | success | failed | cancelled', attemptNumber: 1, createdAt: '2026-06-06T00:00:00.000Z' };
    if (endpoint.method === 'GET') return { responseSchema: { type: 'array', items: taskRun }, responseExample: [taskRun], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
    return { responseSchema: taskRun, responseExample: taskRun, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
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
    return { responseSchema: { name: 'string', status: 'success | failed', dispatched: 'number', reviewed: 'number', decomposed: 'number', error: 'string | null' }, responseExample: { name: 'dispatch-heartbeat', status: 'success', dispatched: 1, reviewed: 0, decomposed: 0, error: null }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  const entity = entityFromEndpoint(endpoint);
  if (endpoint.method === 'GET' && !endpoint.path.includes(':id')) {
    return { responseSchema: { type: 'array', items: { type: entity, id: 'uuid', createdAt: 'ISO datetime' } }, responseExample: [], rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
  }

  if (endpoint.path.includes('/webhook/task-complete')) {
    return { responseSchema: { ok: 'boolean' }, responseExample: { ok: true }, rateLimit: endpoint.rateLimit ?? defaultRateLimit, requiredRole: roleDefault(endpoint) };
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
    auth: {
      mode: 'Cookie session with company membership role checks. Signup is DB-configured and defaults to enabled; if no active admin exists, the next signup becomes global admin and default-company admin. If BOOTSTRAP_TOKEN is configured, POST /api/auth/bootstrap can create or recover the admin account only while no active admin exists. Viewer can read data for visible companies; company operator/admin is required for company-scoped mutation, run/review/decompose, adapter tests, runtime edits, and budget decisions. Manual cron remains an operator system action.',
      login: 'POST /api/auth/login',
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
      note: 'backlog and todo are merged. Send todo for new work; legacy backlog input is accepted and normalized to todo.',
    },
    adapters: agentAdapterTypes,
    endpoints: catalogEndpoints,
  };
}

function jsonBlock(value: unknown): string {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
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
    '## Rate Limits',
    `Enforced: ${catalog.rateLimits.enforced ? 'yes' : 'no'}`,
    catalog.rateLimits.summary,
    `Production recommendation: ${catalog.rateLimits.productionRecommendation}`,
    '',
    '## Kanban Stages',
    `Canonical stages: ${catalog.kanban.stages.join(', ')}`,
    'Legacy alias: backlog -> todo',
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
