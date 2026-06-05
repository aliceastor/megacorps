import { agentAdapterTypes, cardStatuses, legacyCardStatusAliases } from '@megacorps/shared';

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

type ApiEndpoint = {
  method: ApiMethod;
  path: string;
  group: string;
  auth: 'none' | 'session';
  summary: string;
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  response?: string;
  notes?: string[];
};

const endpoints: ApiEndpoint[] = [
  { method: 'GET', path: '/health', group: 'System', auth: 'none', summary: 'Read server health.', response: '{ ok: true }' },
  { method: 'GET', path: '/api/help', group: 'System', auth: 'none', summary: 'List MegaCorps API endpoints and usage.', query: { format: 'Optional. Use markdown or md for text/markdown output.' } },
  { method: 'POST', path: '/api/auth/signup', group: 'Auth', auth: 'none', summary: 'Create an admin user and set the session cookie.', body: { email: 'user@example.com', name: 'Operator', password: 'at least 8 chars' } },
  { method: 'POST', path: '/api/auth/login', group: 'Auth', auth: 'none', summary: 'Log in and set the session cookie.', body: { email: 'user@example.com', password: 'password' } },
  { method: 'POST', path: '/api/auth/logout', group: 'Auth', auth: 'session', summary: 'Clear the session cookie.' },
  { method: 'GET', path: '/api/me', group: 'Auth', auth: 'session', summary: 'Read the current authenticated user.' },

  { method: 'GET', path: '/api/dashboard', group: 'Overview', auth: 'session', summary: 'Read dashboard stats, stage counts, recent task logs, and recent API events.' },
  { method: 'GET', path: '/api/system-logs', group: 'Logs', auth: 'session', summary: 'Read persisted API lifecycle logs.', query: { limit: '1-500, default 100.' } },
  { method: 'GET', path: '/api/activity', group: 'Logs', auth: 'session', summary: 'Read product activity/audit events.', query: { companyId: 'Optional company UUID.', entityType: 'Optional entity type.', limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/heartbeat-runs', group: 'Logs', auth: 'session', summary: 'Read agent heartbeat/run history.', query: { companyId: 'Optional company UUID.', cardId: 'Optional task UUID.', agentId: 'Optional agent UUID.', status: 'Optional run status.', limit: '1-500, default 200.' } },
  { method: 'GET', path: '/api/cost-events', group: 'Budget', auth: 'session', summary: 'Read recorded model/runtime cost events.', query: { companyId: 'Optional company UUID.', agentId: 'Optional agent UUID.', cardId: 'Optional task UUID.', limit: '1-500, default 200.' } },

  { method: 'GET', path: '/api/companies', group: 'Companies', auth: 'none', summary: 'List companies.' },
  { method: 'POST', path: '/api/companies', group: 'Companies', auth: 'session', summary: 'Create a company.', body: { name: 'Acme AI', slug: 'acme-ai', mission: 'Build useful things.', dispatchIntervalSeconds: 10, autoDispatchEnabled: true } },
  { method: 'PUT', path: '/api/companies/:id', group: 'Companies', auth: 'session', summary: 'Update company settings.', params: { id: 'Company UUID.' }, body: { name: 'Acme AI', slug: 'acme-ai', mission: 'Updated mission.', dispatchIntervalSeconds: 30, autoDispatchEnabled: true } },
  { method: 'GET', path: '/api/departments', group: 'Companies', auth: 'none', summary: 'List departments.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/departments', group: 'Companies', auth: 'session', summary: 'Create a department.', body: { companyId: 'uuid', name: 'Engineering', slug: 'engineering' } },

  { method: 'GET', path: '/api/cards', group: 'Kanban', auth: 'none', summary: 'List Kanban tasks.', query: { status: `Optional. One of ${cardStatuses.join(', ')}. Legacy backlog maps to todo.`, assigneeId: 'Optional agent UUID.', tag: 'Optional tag.', priority: 'urgent | high | normal | low.', limit: 'Default 100.', offset: 'Default 0.' } },
  { method: 'POST', path: '/api/cards', group: 'Kanban', auth: 'session', summary: 'Create a Kanban task. New tasks default to todo.', body: { companyId: 'uuid optional', title: 'Task title', body: 'Full task detail', priority: 'normal', tags: ['backend'], assigneeId: null, reviewerId: null, requiresApproval: false } },
  { method: 'PUT', path: '/api/cards/:id', group: 'Kanban', auth: 'session', summary: 'Update a Kanban task. Include updatedAt for optimistic locking.', params: { id: 'Task UUID.' }, body: { title: 'Updated title', body: 'Updated detail', columnStatus: 'todo', updatedAt: 'ISO datetime from existing card' } },
  { method: 'DELETE', path: '/api/cards/:id', group: 'Kanban', auth: 'session', summary: 'Delete a task and its comments/logs.', params: { id: 'Task UUID.' } },
  { method: 'GET', path: '/api/cards/:id/logs', group: 'Kanban', auth: 'none', summary: 'Read full task logs.', params: { id: 'Task UUID.' } },
  { method: 'GET', path: '/api/cards/:id/comments', group: 'Kanban', auth: 'none', summary: 'Read task message board comments.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/comments', group: 'Kanban', auth: 'session', summary: 'Add a task message board comment or intervention.', params: { id: 'Task UUID.' }, body: { body: 'Instruction or comment', action: 'comment | agent_note | pause_agent | send_to_agent | continue_run', agentId: 'optional agent UUID for agent-authored note' } },
  { method: 'POST', path: '/api/cards/:id/run', group: 'Kanban', auth: 'session', summary: 'Dispatch a task to its assigned/eligible agent immediately.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/review', group: 'Kanban', auth: 'session', summary: 'Run task review immediately.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/cards/:id/decompose', group: 'Kanban', auth: 'session', summary: 'Split a task into sub-tasks.', params: { id: 'Task UUID.' } },
  { method: 'POST', path: '/api/webhook/task-complete', group: 'Kanban', auth: 'none', summary: 'External agent callback to report task progress/completion.', body: { cardId: 'uuid', status: 'done | blocked | in_review | in_progress | todo', summary: 'Short result', output: 'Full output/log', costUsd: 0.05 } },

  { method: 'GET', path: '/api/agents', group: 'Agents', auth: 'none', summary: 'List agents.' },
  { method: 'POST', path: '/api/agents', group: 'Agents', auth: 'session', summary: 'Create an agent.', body: { companyId: 'uuid optional', departmentId: 'uuid optional', name: 'Builder', slug: 'builder', role: 'worker', title: 'Backend Engineer', adapterType: 'mock', runtimeId: 'uuid optional', bossId: null, budgetPerTask: 1, budgetMonthly: 20 } },
  { method: 'PUT', path: '/api/agents/:id', group: 'Agents', auth: 'session', summary: 'Update an agent, adapter config, runtime, and reporting line.', params: { id: 'Agent UUID.' } },
  { method: 'DELETE', path: '/api/agents/:id', group: 'Agents', auth: 'session', summary: 'Delete an agent.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/pause', group: 'Agents', auth: 'session', summary: 'Pause an agent.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/resume', group: 'Agents', auth: 'session', summary: 'Resume an agent.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/reset-session', group: 'Agents', auth: 'session', summary: 'Clear an agent session id.', params: { id: 'Agent UUID.' } },
  { method: 'POST', path: '/api/agents/:id/test-connection', group: 'Agents', auth: 'session', summary: 'Test the selected adapter/runtime connection.', params: { id: 'Agent UUID.' } },
  { method: 'GET', path: '/api/agent-runtimes', group: 'Agents', auth: 'none', summary: 'List runtime presets.' },
  { method: 'POST', path: '/api/agent-runtimes', group: 'Agents', auth: 'session', summary: 'Create a runtime preset.', body: { name: 'Hermes Gateway', adapterType: 'hermes-gateway', isActive: true, config: { hermesGatewayUrl: 'http://host:9119', publicApiUrl: 'http://host:4000' } } },
  { method: 'PUT', path: '/api/agent-runtimes/:id', group: 'Agents', auth: 'session', summary: 'Update a runtime preset.', params: { id: 'Runtime UUID.' } },
  { method: 'DELETE', path: '/api/agent-runtimes/:id', group: 'Agents', auth: 'session', summary: 'Delete a runtime preset.', params: { id: 'Runtime UUID.' } },

  { method: 'GET', path: '/api/chat/sessions', group: 'Chat', auth: 'session', summary: 'List direct-chat sessions.', query: { companyId: 'Optional company UUID.', agentId: 'Optional agent UUID.', limit: '1-200, default 100.' } },
  { method: 'POST', path: '/api/chat/sessions', group: 'Chat', auth: 'session', summary: 'Create a direct-chat session with an agent.', body: { companyId: 'uuid', agentId: 'uuid', title: 'Session title optional' } },
  { method: 'GET', path: '/api/chat/sessions/:id/messages', group: 'Chat', auth: 'session', summary: 'Read chat messages.', params: { id: 'Chat session UUID.' } },
  { method: 'POST', path: '/api/chat/sessions/:id/messages', group: 'Chat', auth: 'session', summary: 'Send a message to an agent and store the response.', params: { id: 'Chat session UUID.' }, body: { body: 'Message for the agent' } },

  { method: 'GET', path: '/api/projects', group: 'Context', auth: 'none', summary: 'List projects.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/projects', group: 'Context', auth: 'session', summary: 'Create a project.', body: { companyId: 'uuid optional', name: 'Project name', description: 'Optional description' } },
  { method: 'GET', path: '/api/goals', group: 'Context', auth: 'none', summary: 'List goals.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/goals', group: 'Context', auth: 'session', summary: 'Create a goal.', body: { companyId: 'uuid optional', title: 'Goal title', body: 'Goal detail' } },
  { method: 'GET', path: '/api/knowledge-docs', group: 'Context', auth: 'none', summary: 'List knowledge documents.', query: { companyId: 'Optional company UUID.' } },
  { method: 'POST', path: '/api/knowledge-docs', group: 'Context', auth: 'session', summary: 'Create a knowledge document.', body: { companyId: 'uuid', title: 'Runbook', tags: ['ops'], body: 'Document body' } },
  { method: 'PUT', path: '/api/knowledge-docs/:id', group: 'Context', auth: 'session', summary: 'Update a knowledge document.', params: { id: 'Knowledge document UUID.' } },
  { method: 'DELETE', path: '/api/knowledge-docs/:id', group: 'Context', auth: 'session', summary: 'Delete a knowledge document.', params: { id: 'Knowledge document UUID.' } },

  { method: 'GET', path: '/api/budget-policies', group: 'Budget', auth: 'session', summary: 'List budget policies.', query: { companyId: 'Optional company UUID.', agentId: 'Optional agent UUID.' } },
  { method: 'POST', path: '/api/budget-policies', group: 'Budget', auth: 'session', summary: 'Create a budget policy.', body: { companyId: 'uuid', agentId: null, name: 'Monthly cap', monthlyLimitUsd: 100, perTaskLimitUsd: 2, warnAtPercent: 80, hardStop: true, isActive: true } },
  { method: 'PUT', path: '/api/budget-policies/:id', group: 'Budget', auth: 'session', summary: 'Update a budget policy.', params: { id: 'Policy UUID.' } },
  { method: 'DELETE', path: '/api/budget-policies/:id', group: 'Budget', auth: 'session', summary: 'Delete a budget policy.', params: { id: 'Policy UUID.' } },
  { method: 'GET', path: '/api/approvals', group: 'Budget', auth: 'session', summary: 'List approvals.', query: { companyId: 'Optional company UUID.', status: 'Optional approval status.', cardId: 'Optional task UUID.', limit: '1-500, default 200.' } },
  { method: 'PUT', path: '/api/approvals/:id', group: 'Budget', auth: 'session', summary: 'Decide an approval.', params: { id: 'Approval UUID.' }, body: { status: 'approved | rejected | revision_requested | cancelled', decisionNote: 'Optional note' } },

  { method: 'GET', path: '/api/cron/status', group: 'Cron', auth: 'session', summary: 'Read dispatch loop status.' },
  { method: 'GET', path: '/api/cron/runs', group: 'Cron', auth: 'session', summary: 'Read cron/heartbeat loop runs.', query: { limit: '1-200, default 50.' } },
  { method: 'POST', path: '/api/cron/run', group: 'Cron', auth: 'session', summary: 'Run one dispatch/review heartbeat tick now.' },
];

export function apiHelpCatalog() {
  return {
    service: 'MegaCorps API',
    help: {
      json: 'GET /api/help',
      markdown: 'GET /api/help?format=markdown',
      ui: '/help',
    },
    auth: {
      mode: 'Cookie session. Most write/admin operations require login; read-only agent bootstrap endpoints are intentionally public where noted.',
      login: 'POST /api/auth/login',
      signup: 'POST /api/auth/signup',
    },
    kanban: {
      stages: cardStatuses,
      legacyAliases: legacyCardStatusAliases,
      note: 'backlog and todo are merged. Send todo for new work; legacy backlog input is accepted and normalized to todo.',
    },
    adapters: agentAdapterTypes,
    endpoints,
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
    '## Kanban Stages',
    `Canonical stages: ${catalog.kanban.stages.join(', ')}`,
    'Legacy alias: backlog -> todo',
    '',
    '## Endpoints',
  ];

  const groups = Array.from(new Set(endpoints.map((endpoint) => endpoint.group)));
  for (const group of groups) {
    lines.push('', `### ${group}`);
    for (const endpoint of endpoints.filter((item) => item.group === group)) {
      lines.push('', `#### ${endpoint.method} ${endpoint.path}`, endpoint.summary, `Auth: ${endpoint.auth}`);
      if (endpoint.params) lines.push(`Params: ${JSON.stringify(endpoint.params)}`);
      if (endpoint.query) lines.push(`Query: ${JSON.stringify(endpoint.query)}`);
      if (endpoint.body) lines.push('Body:', jsonBlock(endpoint.body));
      if (endpoint.response) lines.push(`Response: ${endpoint.response}`);
      if (endpoint.notes?.length) lines.push(...endpoint.notes.map((note) => `- ${note}`));
    }
  }
  return `${lines.join('\n')}\n`;
}
