import { z } from 'zod';

export const cardStatuses = ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'done', 'blocked', 'cancelled'] as const;
export type CardStatus = (typeof cardStatuses)[number];
export const legacyCardStatusAliases = { backlog: 'todo' } as const;
const cardStatusInputs = ['backlog', ...cardStatuses] as const;
export const agentAdapterTypes = ['hermes-ssh', 'hermes-gateway', 'codex-app', 'openclaw', 'webhook'] as const;
export type AgentAdapterType = (typeof agentAdapterTypes)[number];
export const cardActorTypes = ['user', 'machine', 'system', 'agent:worker', 'agent:reviewer', 'agent:leader'] as const;
export type CardActorType = (typeof cardActorTypes)[number];
export const cardTransitionActions = ['claim', 'submit_review', 'request_help', 'wait_external', 'external_success', 'external_failure', 'approve', 'reject', 'complete', 'block', 'cancel', 'release', 'resume', 'reopen', 'manual_move'] as const;
export type CardTransitionAction = (typeof cardTransitionActions)[number];

type CardTransitionDef = {
  from: readonly CardStatus[];
  to: CardStatus;
  allow: readonly CardActorType[];
};

const cardTransitionDefs: Record<CardTransitionAction, CardTransitionDef> = {
  claim: { from: ['todo'], to: 'in_progress', allow: ['machine', 'system', 'agent:worker', 'agent:leader', 'user'] },
  submit_review: { from: ['in_progress'], to: 'in_review', allow: ['machine', 'system', 'agent:worker', 'agent:leader', 'user'] },
  request_help: { from: ['in_progress', 'blocked'], to: 'needs_review', allow: ['machine', 'system', 'agent:worker', 'agent:leader', 'user'] },
  wait_external: { from: ['in_progress', 'in_review'], to: 'waiting_on_external', allow: ['machine', 'system', 'agent:worker', 'agent:leader', 'user'] },
  external_success: { from: ['waiting_on_external'], to: 'in_review', allow: ['machine', 'system', 'agent:reviewer', 'agent:leader', 'user'] },
  external_failure: { from: ['waiting_on_external'], to: 'in_progress', allow: ['machine', 'system', 'agent:worker', 'agent:leader', 'user'] },
  approve: { from: ['in_review', 'needs_review'], to: 'done', allow: ['machine', 'system', 'agent:reviewer', 'agent:leader', 'user'] },
  reject: { from: ['in_review', 'needs_review'], to: 'todo', allow: ['machine', 'system', 'agent:reviewer', 'agent:leader', 'user'] },
  complete: { from: ['in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'cancelled'], to: 'done', allow: ['machine', 'system', 'agent:reviewer', 'agent:leader', 'user'] },
  block: { from: ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external'], to: 'blocked', allow: ['machine', 'system', 'agent:worker', 'agent:reviewer', 'agent:leader', 'user'] },
  cancel: { from: ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'blocked'], to: 'cancelled', allow: ['machine', 'system', 'agent:leader', 'user'] },
  release: { from: ['in_progress'], to: 'todo', allow: ['machine', 'system', 'agent:worker', 'agent:leader', 'user'] },
  resume: { from: ['blocked', 'cancelled', 'waiting_on_external'], to: 'todo', allow: ['machine', 'system', 'agent:leader', 'user'] },
  reopen: { from: ['done'], to: 'todo', allow: ['agent:leader', 'user'] },
  manual_move: { from: cardStatuses, to: 'todo', allow: ['user', 'system'] },
};

const allowedTransitions: Record<CardStatus, CardStatus[]> = {
  todo: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['in_review', 'needs_review', 'waiting_on_external', 'done', 'blocked', 'cancelled'],
  in_review: ['waiting_on_external', 'done', 'todo', 'in_progress', 'blocked', 'cancelled'],
  needs_review: ['todo', 'in_progress', 'done', 'blocked', 'cancelled'],
  waiting_on_external: ['in_review', 'in_progress', 'done', 'todo', 'blocked', 'cancelled'],
  done: ['todo'],
  blocked: ['todo', 'cancelled'],
  cancelled: ['todo', 'done'],
};

export function canTransitionCard(from: CardStatus, to: CardStatus): boolean {
  if (from === to) return true;
  return allowedTransitions[from].includes(to);
}

export function getCardTransitionTarget(action: CardTransitionAction): CardStatus {
  return cardTransitionDefs[action].to;
}

export function inferCardTransitionAction(from: CardStatus, to: CardStatus): CardTransitionAction | null {
  if (from === to) return 'manual_move';
  for (const action of cardTransitionActions) {
    if (action === 'manual_move') continue;
    const def = cardTransitionDefs[action];
    if (def.to === to && def.from.includes(from)) return action;
  }
  return null;
}

export function validateCardTransition(action: CardTransitionAction, from: CardStatus, actorType: CardActorType, targetStatus?: CardStatus): { code: 'INVALID_TRANSITION' | 'FORBIDDEN'; message: string } | null {
  const def = cardTransitionDefs[action];
  if (!def.allow.includes(actorType)) return { code: 'FORBIDDEN', message: `${actorType} cannot perform ${action}` };
  if (action === 'manual_move') {
    if (!targetStatus) return { code: 'INVALID_TRANSITION', message: 'manual_move requires a target status' };
    if (!canTransitionCard(from, targetStatus)) return { code: 'INVALID_TRANSITION', message: `Cannot move card from ${from} to ${targetStatus}` };
    return null;
  }
  if (!def.from.includes(from)) return { code: 'INVALID_TRANSITION', message: `Cannot ${action} from ${from}; allowed from ${def.from.join(', ')}` };
  if (targetStatus && targetStatus !== def.to) return { code: 'INVALID_TRANSITION', message: `${action} targets ${def.to}, not ${targetStatus}` };
  return null;
}

export function normalizeCardStatus(value: string | null | undefined): CardStatus | undefined {
  if (!value) return undefined;
  if (value === 'backlog') return 'todo';
  return (cardStatuses as readonly string[]).includes(value) ? value as CardStatus : undefined;
}

export const prioritySchema = z.enum(['urgent', 'high', 'normal', 'low']);
export const cardStatusSchema = z.enum(cardStatusInputs).transform((status) => normalizeCardStatus(status) ?? 'todo');

export const createCardSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1, 'body must not be empty'),
  priority: prioritySchema.default('normal'),
  tags: z.array(z.string().trim().min(1).max(40)).default([]),
  companyId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  reviewerId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  parentCardId: z.string().uuid().nullable().optional(),
  dependencyCardIds: z.array(z.string().uuid()).default([]),
  requiresApproval: z.boolean().default(false),
  maxRetries: z.number().int().min(1).max(10).default(3),
  decisionMode: z.enum(['execute', 'delegate', 'hybrid', 'review', 'integrate']).nullable().optional(),
  rollupStatus: z.enum(['planning', 'delegated', 'waiting_on_children', 'waiting_on_dependencies', 'waiting_on_external', 'integrating', 'ready_for_review', 'done', 'blocked']).nullable().optional(),
  requiredChildPolicy: z.enum(['all_required_accepted', 'all_non_cancelled_accepted', 'threshold', 'manual']).default('all_required_accepted'),
  childRequirementLevel: z.enum(['required', 'optional', 'follow_up']).default('required'),
  estimatedWeight: z.number().nonnegative().nullable().optional(),
  estimatedDurationMinutes: z.number().int().nonnegative().nullable().optional(),
  taskBudgetLimit: z.number().nonnegative().nullable().optional(),
  revisionCount: z.number().int().nonnegative().default(0),
  maxRevisions: z.number().int().min(1).max(20).default(3),
  requiredToolIds: z.array(z.string().uuid()).default([]),
});

export const createMachineRunnerSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  supportedRuntimes: z.array(z.string().trim().min(1).max(80)).default([]),
  maxConcurrent: z.number().int().min(1).max(64).default(1),
  localWorkspaceRoot: z.string().trim().max(1000).nullable().optional(),
  localScratchRoot: z.string().trim().max(1000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const updateMachineRunnerSchema = createMachineRunnerSchema.partial().extend({
  status: z.enum(['online', 'offline', 'disabled']).optional(),
});

export const runnerHeartbeatSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  version: z.string().trim().max(80).optional(),
  os: z.string().trim().max(120).optional(),
  supportedRuntimes: z.array(z.string().trim().min(1).max(80)).optional(),
  maxConcurrent: z.number().int().min(1).max(64).optional(),
  activeSlots: z.number().int().min(0).max(64).optional(),
  localWorkspaceRoot: z.string().trim().max(1000).nullable().optional(),
  localScratchRoot: z.string().trim().max(1000).nullable().optional(),
  runtimeStatuses: z.record(z.string(), z.enum(['missing', 'unauthorized', 'unhealthy', 'limited', 'ready'])).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const createAgentSessionSchema = z.object({
  agentId: z.string().uuid(),
  cardId: z.string().uuid().nullable().optional(),
  taskRunId: z.string().uuid().nullable().optional(),
  sessionKind: z.enum(['task', 'review', 'chat', 'leader']).default('task'),
  publicKeyJwk: z.record(z.string(), z.unknown()).nullable().optional(),
  publicKey: z.string().trim().max(4000).nullable().optional(),
  fingerprint: z.string().trim().max(160).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const runnerTaskClaimSchema = z.object({
  companyId: z.string().uuid().optional(),
  kinds: z.array(z.enum(['dispatch', 'review'])).optional(),
});

export const runnerTaskCompleteSchema = z.object({
  status: z.enum(['success', 'failed', 'cancelled', 'done', 'blocked', 'needs_review', 'in_review', 'waiting_on_external']),
  summary: z.string().trim().max(2000).optional(),
  output: z.string().max(100_000).optional(),
  error: z.string().trim().max(4000).nullable().optional(),
  costUsd: z.number().nonnegative().optional(),
  pollIntervalSeconds: z.number().int().min(30).max(86_400).nullable().optional(),
  workProducts: z.array(z.object({
    type: z.enum(['report', 'file', 'preview_url', 'pull_request', 'commit', 'screenshot', 'artifact', 'external']).default('external'),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(2000).nullable().optional(),
    url: z.string().trim().max(2000).nullable().optional(),
    repoProvider: z.string().trim().max(80).nullable().optional(),
    repoUrl: z.string().trim().max(1000).nullable().optional(),
    branch: z.string().trim().max(200).nullable().optional(),
    commitSha: z.string().trim().max(120).nullable().optional(),
    pullRequestUrl: z.string().trim().max(1000).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
});

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  mission: z.string().trim().max(2000).optional(),
  dispatchIntervalSeconds: z.number().int().min(5).max(3600).default(10),
  autoDispatchEnabled: z.boolean().default(true),
});

export const createDepartmentSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
});

export const createPositionSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  prompt: z.string().trim().max(8000).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  rank: z.number().int().min(0).max(10000).default(100),
  isCompanyBoss: z.boolean().default(false),
  canDelegateAcrossDepartments: z.boolean().default(false),
  defaultDepartmentId: z.string().uuid().nullable().optional(),
  managerPositionId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
});

export const updateCardSchema = createCardSchema.partial().extend({
  columnStatus: cardStatusSchema.optional(),
  updatedAt: z.string().datetime().optional(),
});

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  role: z.string().trim().min(1).max(80),
  companyId: z.string().uuid().optional(),
  title: z.string().trim().max(120).optional(),
  soul: z.string().trim().max(8000).nullable().optional(),
  adapterType: z.enum(agentAdapterTypes).default('hermes-ssh'),
  adapterConfig: z.record(z.string(), z.unknown()).optional(),
  runtimeId: z.string().uuid().nullable().optional(),
  hermesProfile: z.string().trim().min(1).max(80).optional(),
  bossId: z.string().uuid().nullable().optional(),
  capabilities: z.array(z.string().trim().min(1).max(80)).default([]).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  positionId: z.string().uuid().nullable().optional(),
  budgetPerTask: z.number().nonnegative().optional(),
  budgetMonthly: z.number().nonnegative().optional(),
});

export const updateAgentSchema = createAgentSchema.omit({ adapterType: true, capabilities: true }).partial().extend({
  adapterType: z.enum(agentAdapterTypes).optional(),
  capabilities: z.array(z.string().trim().min(1).max(80)).optional(),
});

export const createAgentRuntimeSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  adapterType: z.enum(agentAdapterTypes),
  localWorkspaceRoot: z.string().trim().max(1000).nullable().optional(),
  localScratchRoot: z.string().trim().max(1000).nullable().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  isActive: z.boolean().default(true),
});

export const companyMemberRoleSchema = z.enum(['viewer', 'operator', 'admin']);
const emailSchema = z.string().email().transform((value) => value.toLowerCase());

export const createCompanyMembershipSchema = z.object({
  companyId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  email: emailSchema.optional(),
  role: companyMemberRoleSchema.default('viewer'),
  status: z.enum(['active', 'disabled']).default('active'),
}).refine((value) => value.userId || value.email, { message: 'userId or email is required', path: ['userId'] });

export const updateCompanyMembershipSchema = z.object({
  role: companyMemberRoleSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export const createCardCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  action: z.enum(['comment', 'agent_note', 'pause_agent', 'send_to_agent', 'continue_run', 'escalate_to_reviewer']).default('comment'),
  agentId: z.string().uuid().nullable().optional(),
});

export const createChatSessionSchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(160).optional(),
});

export const createChatMessageSchema = z.object({
  body: z.string().trim().min(1).max(10000),
});

export const createKnowledgeDocSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  tags: z.array(z.string().trim().min(1).max(40)).default([]),
  body: z.string().trim().min(1).max(20000),
});

const projectWorkPathSchema = z.string().trim().max(1000).refine((value) => {
  if (!value) return true;
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]+/).includes('..');
}, 'workPath must be a repo/workspace-relative path');

export const createProjectSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).optional(),
  repoProvider: z.enum(['github', 'gitlab', 'gitea', 'generic']).default('github'),
  repoUrl: z.string().trim().max(1000).nullable().optional(),
  workPath: projectWorkPathSchema.nullable().optional(),
  defaultBranch: z.string().trim().min(1).max(120).default('main'),
  protectedBranches: z.array(z.string().trim().min(1).max(120)).default(['main', 'master']),
  workBranchPattern: z.string().trim().min(1).max(200).default('megacorps/card-{cardId}-{agentSlug}'),
  pullBeforeRun: z.boolean().default(true),
  pushAfterRun: z.boolean().default(true),
  completionPolicy: z.enum(['push_branch', 'pull_request', 'push_or_pr', 'manual']).default('push_or_pr'),
  setupCommand: z.string().trim().max(2000).nullable().optional(),
  testCommand: z.string().trim().max(2000).nullable().optional(),
  runtimeServices: z.record(z.string(), z.unknown()).default({}),
  workspacePathHint: z.string().trim().max(1000).nullable().optional(),
});

export const createGoalSchema = z.object({
  companyId: z.string().uuid().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(4000).optional(),
});

export const workProductTypes = ['report', 'file', 'preview_url', 'pull_request', 'commit', 'screenshot', 'artifact', 'external'] as const;
export type WorkProductType = (typeof workProductTypes)[number];

export const createWorkProductSchema = z.object({
  cardId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  taskRunId: z.string().uuid().nullable().optional(),
  type: z.enum(workProductTypes).default('external'),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(4000).nullable().optional(),
  url: z.string().trim().max(2000).nullable().optional(),
  repoProvider: z.string().trim().max(80).nullable().optional(),
  repoUrl: z.string().trim().max(1000).nullable().optional(),
  branch: z.string().trim().max(240).nullable().optional(),
  commitSha: z.string().trim().max(80).nullable().optional(),
  pullRequestUrl: z.string().trim().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const createExternalWaitSchema = z.object({
  waitingFor: z.string().trim().min(1).max(200),
  provider: z.string().trim().min(1).max(80).default('generic'),
  externalId: z.string().trim().max(200).nullable().optional(),
  externalUrl: z.string().trim().max(2000).nullable().optional(),
  timeoutAt: z.string().datetime().nullable().optional(),
  pollIntervalSeconds: z.number().int().min(30).max(86_400).nullable().optional(),
});

export const createExternalEventSchema = z.object({
  companyId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().optional(),
  rootCardId: z.string().uuid().nullable().optional(),
  cardId: z.string().uuid(),
  provider: z.string().trim().min(1).max(80).default('generic'),
  eventType: z.string().trim().min(1).max(120),
  externalId: z.string().trim().max(200).nullable().optional(),
  externalUrl: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(['success', 'failure', 'cancelled', 'waiting', 'timeout', 'info']),
  payloadSummary: z.string().trim().max(4000).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const createToolSchema = z.object({
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(160),
  version: z.string().trim().min(1).max(80).default('1.0.0'),
  description: z.string().trim().max(4000).nullable().optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  ownerAgentId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  isRequiredEligible: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const updateToolSchema = createToolSchema.partial().extend({
  companyId: z.string().uuid().optional(),
});

export const cardRequiredToolsSchema = z.object({
  toolIds: z.array(z.string().uuid()).default([]),
  reason: z.string().trim().max(1000).nullable().optional(),
});

export const createCardIntegrationSchema = z.object({
  integratorAgentId: z.string().uuid().nullable().optional(),
  sourceChildCardIds: z.array(z.string().uuid()).default([]),
  summary: z.string().trim().min(1).max(8000),
  acceptedWorkProductIds: z.array(z.string().uuid()).default([]),
  droppedWorkProductIds: z.array(z.string().uuid()).default([]),
  conflictNotes: z.string().trim().max(8000).nullable().optional(),
  status: z.enum(['draft', 'accepted', 'rejected', 'superseded']).default('draft'),
});

export const createTaskContextSnapshotSchema = z.object({
  taskRunId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  mode: z.enum(['dispatch', 'review', 'integrate', 'manual']).default('manual'),
  summaryJson: z.record(z.string(), z.unknown()).default({}),
});

export const createTaskContextRequestSchema = z.object({
  agentId: z.string().uuid().nullable().optional(),
  requestedCardIds: z.array(z.string().uuid()).default([]),
  requestedLogKinds: z.array(z.string().trim().min(1).max(80)).default([]),
  reason: z.string().trim().min(1).max(4000),
});

export const updateTaskContextRequestSchema = z.object({
  status: z.enum(['open', 'approved', 'rejected', 'resolved', 'cancelled']),
});

export const createBudgetPolicySchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(160),
  monthlyLimitUsd: z.number().nonnegative().nullable().optional(),
  perTaskLimitUsd: z.number().nonnegative().nullable().optional(),
  warnAtPercent: z.number().int().min(1).max(100).default(80),
  hardStop: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

export const approvalDecisionSchema = z.object({
  status: z.enum(['approved', 'rejected', 'revision_requested', 'cancelled']),
  decisionNote: z.string().trim().max(4000).optional(),
});

export const taskLogTypes = ['dispatch', 'retry', 'review', 'escalation', 'decomposition', 'cascade', 'webhook', 'manual', 'stage', 'comment', 'lock', 'lock_expired', 'recovery', 'cancel', 'budget', 'approval', 'queue'] as const;
export type TaskLogType = (typeof taskLogTypes)[number];

export const taskLogSchema = z.object({
  cardId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  type: z.enum(taskLogTypes),
  status: z.enum(['queued', 'running', 'success', 'warning', 'failed']),
  message: z.string().trim().min(1).max(2000),
  output: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
});

export const signupSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const userStatusSchema = z.enum(['active', 'disabled']);

export const adminUpdateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['viewer', 'operator', 'admin']).optional(),
  status: userStatusSchema.optional(),
  password: z.string().min(8).max(200).optional(),
});

export const adminUpdateSettingsSchema = z.object({
  signupEnabled: z.boolean().optional(),
});

export const createInviteSchema = z.object({
  companyId: z.string().uuid(),
  email: emailSchema,
  name: z.string().trim().min(1).max(120).optional(),
  role: companyMemberRoleSchema.default('viewer'),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const acceptInviteSchema = z.object({
  token: z.string().trim().min(32).max(300),
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(12).max(200),
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type CreateAgentRuntimeInput = z.infer<typeof createAgentRuntimeSchema>;
export type CreateMachineRunnerInput = z.infer<typeof createMachineRunnerSchema>;
export type UpdateMachineRunnerInput = z.infer<typeof updateMachineRunnerSchema>;
export type RunnerHeartbeatInput = z.infer<typeof runnerHeartbeatSchema>;
export type CreateAgentSessionInput = z.infer<typeof createAgentSessionSchema>;
export type RunnerTaskClaimInput = z.infer<typeof runnerTaskClaimSchema>;
export type RunnerTaskCompleteInput = z.infer<typeof runnerTaskCompleteSchema>;
export type CreateCompanyMembershipInput = z.infer<typeof createCompanyMembershipSchema>;
export type UpdateCompanyMembershipInput = z.infer<typeof updateCompanyMembershipSchema>;
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;
export type AdminUpdateSettingsInput = z.infer<typeof adminUpdateSettingsSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type CreatePositionInput = z.infer<typeof createPositionSchema>;
export type CreateCardCommentInput = z.infer<typeof createCardCommentSchema>;
export type CreateChatSessionInput = z.infer<typeof createChatSessionSchema>;
export type CreateChatMessageInput = z.infer<typeof createChatMessageSchema>;
export type CreateKnowledgeDocInput = z.infer<typeof createKnowledgeDocSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type CreateWorkProductInput = z.infer<typeof createWorkProductSchema>;
export type CreateExternalWaitInput = z.infer<typeof createExternalWaitSchema>;
export type CreateExternalEventInput = z.infer<typeof createExternalEventSchema>;
export type CreateToolInput = z.infer<typeof createToolSchema>;
export type UpdateToolInput = z.infer<typeof updateToolSchema>;
export type CardRequiredToolsInput = z.infer<typeof cardRequiredToolsSchema>;
export type CreateCardIntegrationInput = z.infer<typeof createCardIntegrationSchema>;
export type CreateTaskContextSnapshotInput = z.infer<typeof createTaskContextSnapshotSchema>;
export type CreateTaskContextRequestInput = z.infer<typeof createTaskContextRequestSchema>;
export type UpdateTaskContextRequestInput = z.infer<typeof updateTaskContextRequestSchema>;
export type CreateBudgetPolicyInput = z.infer<typeof createBudgetPolicySchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type TaskLogInput = z.infer<typeof taskLogSchema>;
