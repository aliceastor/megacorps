import { z } from 'zod';

export const cardStatuses = ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'waiting_on_client', 'waiting_on_brainstorm', 'done', 'blocked', 'cancelled'] as const;
export type CardStatus = (typeof cardStatuses)[number];
export const legacyCardStatusAliases = { backlog: 'todo' } as const;
const cardStatusInputs = ['backlog', ...cardStatuses] as const;
// zod 4 keeps applying a field's create-time default inside .partial(), so a
// PUT that omits `tags` would silently reset them to []. Update schemas are
// therefore derived with the defaults stripped: an omitted key stays undefined
// and the route leaves the column untouched.
type StripDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
type PartialWithoutDefaults<S extends z.ZodRawShape> = z.ZodObject<{ [K in keyof S]: z.ZodOptional<StripDefault<S[K]>> }>;
export function partialWithoutDefaults<S extends z.ZodRawShape>(schema: z.ZodObject<S>): PartialWithoutDefaults<S> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const inner = (field instanceof z.ZodDefault ? field.removeDefault() : field) as z.ZodTypeAny;
    shape[key] = inner.optional();
  }
  return z.object(shape) as unknown as PartialWithoutDefaults<S>;
}

export const agentAdapterTypes = ['hermes-ssh', 'hermes-gateway', 'codex-app', 'openclaw', 'webhook', 'a2a'] as const;
export type AgentAdapterType = (typeof agentAdapterTypes)[number];
export const cardActorTypes = ['user', 'machine', 'system', 'agent:worker', 'agent:reviewer', 'agent:leader'] as const;
export type CardActorType = (typeof cardActorTypes)[number];
export const cardTransitionActions = ['claim', 'submit_review', 'request_help', 'wait_external', 'external_success', 'external_failure', 'ask_client', 'client_answered', 'open_brainstorm', 'brainstorm_closed', 'approve', 'reject', 'complete', 'block', 'cancel', 'release', 'resume', 'reopen', 'manual_move'] as const;
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
  // Client checkpoint: the CEO or a department head parks the card until the
  // human client answers a direction or interim-output question.
  ask_client: { from: ['in_progress', 'in_review'], to: 'waiting_on_client', allow: ['machine', 'system', 'agent:worker', 'agent:leader', 'user'] },
  client_answered: { from: ['waiting_on_client'], to: 'in_progress', allow: ['user', 'system'] },
  // Brainstorm round: the CEO or a department head broadcasts one question to
  // named department heads and waits for their proposals before planning.
  open_brainstorm: { from: ['in_progress'], to: 'waiting_on_brainstorm', allow: ['machine', 'system', 'agent:worker', 'agent:leader', 'user'] },
  brainstorm_closed: { from: ['waiting_on_brainstorm'], to: 'in_progress', allow: ['system', 'user'] },
  approve: { from: ['in_review', 'needs_review'], to: 'done', allow: ['machine', 'system', 'agent:reviewer', 'agent:leader', 'user'] },
  reject: { from: ['in_review', 'needs_review'], to: 'todo', allow: ['machine', 'system', 'agent:reviewer', 'agent:leader', 'user'] },
  complete: { from: ['in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'cancelled'], to: 'done', allow: ['machine', 'system', 'agent:reviewer', 'agent:leader', 'user'] },
  block: { from: ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'waiting_on_client', 'waiting_on_brainstorm'], to: 'blocked', allow: ['machine', 'system', 'agent:worker', 'agent:reviewer', 'agent:leader', 'user'] },
  cancel: { from: ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'waiting_on_client', 'waiting_on_brainstorm', 'blocked'], to: 'cancelled', allow: ['machine', 'system', 'agent:leader', 'user'] },
  release: { from: ['in_progress'], to: 'todo', allow: ['machine', 'system', 'agent:worker', 'agent:leader', 'user'] },
  resume: { from: ['blocked', 'cancelled', 'waiting_on_external', 'waiting_on_client', 'waiting_on_brainstorm'], to: 'todo', allow: ['machine', 'system', 'agent:leader', 'user'] },
  reopen: { from: ['done'], to: 'todo', allow: ['agent:leader', 'user'] },
  manual_move: { from: cardStatuses, to: 'todo', allow: ['user', 'system'] },
};

const allowedTransitions: Record<CardStatus, CardStatus[]> = {
  todo: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['in_review', 'needs_review', 'waiting_on_external', 'waiting_on_client', 'waiting_on_brainstorm', 'done', 'blocked', 'cancelled'],
  in_review: ['waiting_on_external', 'waiting_on_client', 'done', 'todo', 'in_progress', 'blocked', 'cancelled'],
  needs_review: ['todo', 'in_progress', 'done', 'blocked', 'cancelled'],
  waiting_on_external: ['in_review', 'in_progress', 'done', 'todo', 'blocked', 'cancelled'],
  waiting_on_client: ['in_progress', 'todo', 'blocked', 'cancelled'],
  waiting_on_brainstorm: ['in_progress', 'todo', 'blocked', 'cancelled'],
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

// Collaboration mode is a hint/constraint on the card, not a workflow switch:
// auto (owner decides within the split rules), solo (no split, no delegation),
// pair (ask the reviewer at every checkpoint), swarm (split homogeneous slices
// in parallel). Legacy values are accepted and persisted as sent; dispatch still
// maps them through normalizeDecisionMode (forced 'delegate' reads as auto).
export const decisionModes = ['auto', 'solo', 'pair', 'swarm'] as const;
export type DecisionMode = (typeof decisionModes)[number];
const legacyDecisionModes = { execute: 'solo', delegate: 'auto', hybrid: 'auto', review: 'auto', integrate: 'auto' } as const;
export const decisionModeSchema = z.enum([...decisionModes, 'execute', 'delegate', 'hybrid', 'review', 'integrate']);
export function normalizeDecisionMode(value: string | null | undefined): DecisionMode {
  if (!value) return 'auto';
  if ((decisionModes as readonly string[]).includes(value)) return value as DecisionMode;
  return legacyDecisionModes[value as keyof typeof legacyDecisionModes] ?? 'auto';
}

// Blind review panel (company pipeline design §17): single = one reviewer
// (the default path); panel = two blind reviewers whose findings are merged.
// The company default decides when a single-mode card still gets a panel.
export const reviewModes = ['single', 'panel'] as const;
export type ReviewMode = (typeof reviewModes)[number];
export const panelReviewDefaults = ['critical_only', 'always', 'never'] as const;
export type PanelReviewDefault = (typeof panelReviewDefaults)[number];

const createCardBaseSchema = z.object({
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
  // Blind review panel (company pipeline §17). critical marks work that touches
  // persisted data or performs an irreversible external action; with the
  // company default critical_only that alone puts the card on a panel.
  // reviewerIds names the panel (max 2); empty means the server composes it at
  // review time from the org chart.
  reviewMode: z.enum(reviewModes).default('single'),
  critical: z.boolean().default(false),
  reviewerIds: z.array(z.string().uuid()).max(2).default([]),
  // Brainstorm controls (company pipeline §5): force a round before any split,
  // and the departments the client wants consulted at minimum.
  forceBrainstorm: z.boolean().default(false),
  brainstormDepartmentIds: z.array(z.string().uuid()).max(20).default([]),
  maxRetries: z.number().int().min(1).max(10).default(3),
  decisionMode: decisionModeSchema.nullable().optional(),
  rollupStatus: z.enum(['planning', 'delegated', 'waiting_on_children', 'waiting_on_dependencies', 'waiting_on_external', 'waiting_on_client', 'waiting_on_brainstorm', 'integrating', 'ready_for_review', 'done', 'blocked']).nullable().optional(),
  requiredChildPolicy: z.enum(['all_required_accepted', 'all_non_cancelled_accepted', 'threshold', 'manual']).default('all_required_accepted'),
  childRequirementLevel: z.enum(['required', 'optional', 'follow_up']).default('required'),
  estimatedWeight: z.number().nonnegative().nullable().optional(),
  estimatedDurationMinutes: z.number().int().nonnegative().nullable().optional(),
  taskBudgetLimit: z.number().nonnegative().nullable().optional(),
  revisionCount: z.number().int().nonnegative().default(0),
  maxRevisions: z.number().int().min(1).max(20).default(3),
  requiredToolIds: z.array(z.string().uuid()).default([]),
  timeoutSeconds: z.number().int().min(30).max(14_400).nullable().optional(),
  scheduleAt: z.coerce.date().nullable().optional(),
  recurEveryMinutes: z.number().int().min(5).max(43_200).nullable().optional(),
});

// Every card has exactly one reviewer and it is never the assignee. The
// reviewer is either an agent (reviewerId) or the human client
// (requiresApproval = true). No card is exempt: the review is the cheapest
// insurance in the pipeline and the only source of CV scores.
export const createCardSchema = createCardBaseSchema
  .refine((card) => Boolean(card.reviewerId) || card.requiresApproval === true, { message: 'A reviewer is required: set reviewerId (an agent) or requiresApproval (the human client reviews).', path: ['reviewerId'] })
  .refine((card) => !card.reviewerId || !card.assigneeId || card.reviewerId !== card.assigneeId, { message: 'The reviewer must not be the assignee.', path: ['reviewerId'] });

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

export const updateMachineRunnerSchema = partialWithoutDefaults(createMachineRunnerSchema).extend({
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
  report: z.unknown().optional(),
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
  nfsShareUrl: z.string().trim().max(1000).nullable().optional(),
  // Live child cards allowed per card when an agent splits (hard cap 5).
  maxChildrenPerCard: z.number().int().min(1).max(5).optional(),
  // When a single-mode card still gets a blind review panel: only critical
  // cards (default), every card, or never (explicit reviewMode=panel only).
  panelReviewDefault: z.enum(panelReviewDefaults).optional(),
  dispatchIntervalSeconds: z.number().int().min(5).max(3600).default(10),
  autoDispatchEnabled: z.boolean().default(true),
});

export const createDepartmentSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  headAgentId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});
export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  headAgentId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

export const createPositionSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  prompt: z.string().trim().max(8000).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  // Review domain (code, content, ...) under which this position scores reviews; feeds the agent CV.
  reviewDomain: z.string().trim().max(40).nullable().optional(),
  rank: z.number().int().min(0).max(10000).default(100),
  isCompanyBoss: z.boolean().default(false),
  canDelegateAcrossDepartments: z.boolean().default(false),
  defaultDepartmentId: z.string().uuid().nullable().optional(),
  managerPositionId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
});

// Derived from the unrefined base: a partial update legitimately omits the
// reviewer fields, so the create-time reviewer rule must not apply here.
export const updateCardSchema = partialWithoutDefaults(createCardBaseSchema).extend({
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
  maxConcurrent: z.number().int().min(1).max(16).optional(),
  // Per-agent task timeout: card override > this > global Kanban timeout.
  defaultTimeoutSeconds: z.number().int().min(30).max(14_400).nullable().optional(),
  memoryConfig: z.object({
    enabled: z.boolean().optional(),
    idleMinutes: z.number().int().min(1).max(1440).optional(),
    dailyLimit: z.number().int().min(1).max(24).optional(),
  }).optional(),
});

export const updateAgentSchema = partialWithoutDefaults(createAgentSchema.omit({ adapterType: true, capabilities: true })).extend({
  adapterType: z.enum(agentAdapterTypes).optional(),
  capabilities: z.array(z.string().trim().min(1).max(80)).optional(),
});

// A2A-aligned structured agent report (docs/a2a-adapter-design.md §3.2).
// Carried as a DataPart in A2A messages, or as the optional `report` field of
// the task-complete webhook. Prose DELEGATE blocks remain a legacy fallback.
export const agentReportDelegationSchema = z.object({
  to: z.string().trim().max(80).optional(),
  objective: z.string().trim().min(1).max(2000),
  outputFormat: z.string().trim().max(1000).optional(),
  boundaries: z.string().trim().max(1000).optional(),
  effort: z.enum(['small', 'medium', 'large']).optional(),
  mode: z.enum(['subroutine', 'handoff']).default('subroutine'),
});
// Peer question: ask another agent (by slug) something without delegating work
// to them. MegaCorps posts it to the card message board and schedules a small
// answer turn for the target agent; the answer lands in the same thread.
// Child card request: split an independent deliverable off to a direct
// report, with its own reviewer. Bounded server-side by the org-shaped split
// rules (direct reports only, live-children cap, rounds).
export const agentReportChildSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(40, 'child card body must state the deliverable and acceptance criteria').max(20_000),
  assigneeSlug: z.string().trim().min(1).max(120),
  reviewerSlug: z.string().trim().min(1).max(120).optional(),
  priority: prioritySchema.optional(),
  // Indexes (0-based) of other children in the same request this one waits for.
  dependsOn: z.array(z.number().int().min(0).max(4)).max(4).optional(),
  // The child touches persisted data or performs an irreversible external
  // action: with the company default it gets a blind review panel.
  critical: z.boolean().optional(),
});
export type AgentReportChild = z.infer<typeof agentReportChildSchema>;
// Blind review panel (company pipeline design §17). A panel reviewer reports
// findings; the author answers each with a disposition; the same reviewers
// verify the dispositions; an author who cannot fix reports an escalation.
export const findingSeverities = ['P0', 'P1', 'P2'] as const;
export type FindingSeverity = (typeof findingSeverities)[number];
export const agentReportFindingSchema = z.object({
  id: z.string().trim().min(1).max(40).optional(),
  severity: z.enum(findingSeverities),
  file: z.string().trim().max(500).optional(),
  line: z.number().int().min(0).optional(),
  title: z.string().trim().min(1).max(200),
  evidence: z.string().trim().min(1).max(2000),
  requiredFix: z.string().trim().min(1).max(2000),
  // The reviewer believes the author cannot fix it: a takeover trigger when
  // every reviewer of the round flags the same P0.
  reassign: z.boolean().optional(),
});
export type AgentReportFinding = z.infer<typeof agentReportFindingSchema>;
export const agentReportVerificationSchema = z.object({
  findingKey: z.string().trim().min(1).max(80),
  status: z.enum(['verified', 'still_open']),
  note: z.string().trim().max(2000).optional(),
});
export type AgentReportVerification = z.infer<typeof agentReportVerificationSchema>;
export const agentReportDispositionSchema = z.object({
  findingKey: z.string().trim().min(1).max(80),
  disposition: z.enum(['adopted', 'rejected', 'merged']),
  reason: z.string().trim().max(2000).optional(),
  mergedInto: z.string().trim().max(80).optional(),
  codeEvidence: z.string().trim().max(2000).optional(),
  testEvidence: z.string().trim().max(2000).optional(),
});
export type AgentReportDisposition = z.infer<typeof agentReportDispositionSchema>;
export const agentReportEscalationSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});
export type AgentReportEscalation = z.infer<typeof agentReportEscalationSchema>;
// Client checkpoint: the CEO or a department head asks the human client for a
// direction decision or a look at interim output. The card parks as
// waiting_on_client until the client answers; the answer is injected back.
export const agentReportCheckpointSchema = z.object({
  kind: z.enum(['direction', 'interim']),
  question: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
  recommendation: z.string().trim().max(200).optional(),
  artifactRefs: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
});
export type AgentReportCheckpoint = z.infer<typeof agentReportCheckpointSchema>;
// Brainstorm broadcast: one question to the heads of the named departments.
export const agentReportBroadcastSchema = z.object({
  departments: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
  question: z.string().trim().min(1).max(2000),
});
export type AgentReportBroadcast = z.infer<typeof agentReportBroadcastSchema>;
export const agentReportMentionSchema = z.object({
  to: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(2000),
});
export const workProductTypes = ['report', 'file', 'preview_url', 'pull_request', 'commit', 'screenshot', 'artifact', 'external'] as const;
export type WorkProductType = (typeof workProductTypes)[number];

// Reported evidence contains content only; ownership is assigned by the server.
export const reportedWorkProductSchema = z.object({
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
export type ReportedWorkProduct = z.infer<typeof reportedWorkProductSchema>;
export const agentReportRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('permission'), question: agentReportCheckpointSchema.shape.question }),
  z.object({ kind: z.literal('help'), question: agentReportCheckpointSchema.shape.question }),
  agentReportCheckpointSchema.omit({ kind: true }).extend({
    kind: z.literal('checkpoint'),
    checkpointKind: z.enum(['direction', 'interim']).default('direction'),
  }),
]);
export const agentReportSchema = z.object({
  kind: z.literal('megacorps-report'),
  version: z.literal(1).default(1),
  status: z.enum(['completed', 'progress', 'in_progress', 'input_required', 'failed', 'rejected']).transform((status) => status === 'in_progress' ? 'progress' as const : status),
  request: agentReportRequestSchema.optional(),
  workProducts: z.array(reportedWorkProductSchema).optional(),
  verdict: z.enum(['approved', 'revision_requested', 'escalate']).optional(),
  summary: z.string().trim().min(1).max(4000),
  questions: z.array(z.string().trim().min(1).max(1000)).max(10).optional(),
  delegations: z.array(agentReportDelegationSchema).max(8).optional(),
  mentions: z.array(agentReportMentionSchema).max(3).optional(),
  // Conversation notes: posted to the card message board as agent comments;
  // @<slug> inside a note wakes that agent, @client pings the human client.
  notes: z.array(z.string().trim().min(1).max(2000)).max(3).optional(),
  children: z.array(agentReportChildSchema).max(5).optional(),
  checkpoint: agentReportCheckpointSchema.optional(),
  broadcast: agentReportBroadcastSchema.optional(),
  // Reviewer score for the work under review (0-10 rubric); feeds the agent CV.
  score: z.number().int().min(0).max(10).optional(),
  // Blind review panel: a panel reviewer files findings; the same reviewers
  // later file verifications; the author answers findings with dispositions
  // or escalates when the fix is beyond their ability or authority.
  findings: z.array(agentReportFindingSchema).max(30).optional(),
  verifications: z.array(agentReportVerificationSchema).max(60).optional(),
  dispositions: z.array(agentReportDispositionSchema).max(60).optional(),
  escalation: agentReportEscalationSchema.optional(),
  artifactRefs: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
});
export type AgentReportMention = z.infer<typeof agentReportMentionSchema>;
export type AgentReportDelegation = z.infer<typeof agentReportDelegationSchema>;
export type AgentReport = z.infer<typeof agentReportSchema>;

// Direct Chat is a separate world from the Kanban board: an agent asked in
// chat to "add that to the board" has no session cookie and cannot call
// POST /api/cards itself. Instead it emits this block in its reply and the
// server applies it on the chatting user's behalf, the same way a DELEGATE
// block is turned into delegation requests server-side.
export const chatWorkItemActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create_card'),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    assigneeSlug: z.string().trim().min(1).max(120).nullable().optional(),
  }),
  z.object({
    action: z.literal('update_card'),
    cardId: z.string().uuid(),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
    status: z.enum(cardStatuses).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  }),
  // A self-note: "agreed with the user to use the v2 format". Feeds the
  // cross-surface activity digest so the agent's next Kanban run knows what
  // was concluded in chat.
  z.object({
    action: z.literal('note'),
    body: z.string().trim().min(1).max(2000),
    cardId: z.string().uuid().nullable().optional(),
  }),
]);
export const chatWorkItemsSchema = z.object({
  kind: z.literal('megacorps-chat-actions'),
  actions: z.array(chatWorkItemActionSchema).min(1).max(10),
});
export type ChatWorkItemAction = z.infer<typeof chatWorkItemActionSchema>;
export type ChatWorkItems = z.infer<typeof chatWorkItemsSchema>;

export const createAgentRuntimeSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  adapterType: z.enum(agentAdapterTypes),
  localWorkspaceRoot: z.string().trim().max(1000).nullable().optional(),
  localScratchRoot: z.string().trim().max(1000).nullable().optional(),
  nfsMountRoot: z.string().trim().max(1000).nullable().optional(),
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
  action: z.enum(['comment', 'agent_note', 'pause_agent', 'send_to_agent', 'continue_run', 'escalate_to_reviewer', 'delegate_to_agent']).default('comment'),
  agentId: z.string().uuid().nullable().optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  reviewerAgentId: z.string().uuid().nullable().optional(),
  reviewerScope: z.enum(['phase', 'final']).nullable().optional(),
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

function withCompanyIdAlias(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  if (body.companyId == null && typeof body.company_id === 'string') return { ...body, companyId: body.company_id };
  return value;
}

const createProjectObjectSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).optional(),
  repoProvider: z.enum(['github', 'gitlab', 'gitea', 'gitea-local', 'generic']).default('github'),
  repoUrl: z.string().trim().max(1000).nullable().optional(),
  workPath: projectWorkPathSchema.nullable().optional(),
  defaultBranch: z.string().trim().min(1).max(120).default('main'),
  protectedBranches: z.array(z.string().trim().min(1).max(120)).default(['main', 'master']),
  workBranchPattern: z.string().trim().min(1).max(200).default('megacorps/card-{cardId}-{agentSlug}'),
  pullBeforeRun: z.boolean().default(true),
  pushAfterRun: z.boolean().default(true),
  completionPolicy: z.enum(['push_branch', 'pull_request', 'push_or_pr', 'manual']).default('push_or_pr'),
  // Merge closure (company pipeline §19): when true an approved card parks on
  // waiting_on_external until the exact authorized head lands on the default
  // branch. No default here so a partial PUT cannot silently flip it; POST
  // /api/projects turns it on for new gitea-local projects.
  completionRequiresMerge: z.boolean().optional(),
  setupCommand: z.string().trim().max(2000).nullable().optional(),
  testCommand: z.string().trim().max(2000).nullable().optional(),
  runtimeServices: z.record(z.string(), z.unknown()).default({}),
  workspacePathHint: z.string().trim().max(1000).nullable().optional(),
  publishRepoUrl: z.string().trim().max(1000).nullable().optional(),
  publishToken: z.string().trim().max(500).nullable().optional(),
});
export const createProjectSchema = z.preprocess(withCompanyIdAlias, createProjectObjectSchema);

export const createGoalSchema = z.object({
  companyId: z.string().uuid().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(4000).optional(),
});

export const createWorkProductSchema = reportedWorkProductSchema.extend({
  cardId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  taskRunId: z.string().uuid().nullable().optional(),
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

export const updateToolSchema = partialWithoutDefaults(createToolSchema).extend({
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
  status: z.enum(['approved', 'rejected', 'revision_requested', 'cancelled', 'answered']),
  decisionNote: z.string().trim().max(4000).optional(),
  // Client checkpoint answers: a picked option and/or free text.
  answer: z.string().trim().max(4000).optional(),
  selectedOption: z.string().trim().max(200).optional(),
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
  kanbanTaskTimeoutSeconds: z.number().int().min(30).max(14_400).optional(),
  chatTaskTimeoutSeconds: z.number().int().min(30).max(14_400).optional(),
  apiTokenAction: z.enum(['rotate', 'revoke']).optional(),
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
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
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

// Update schemas for routes that used to call createXSchema.partial() inline.
export const updateCompanySchema = partialWithoutDefaults(createCompanySchema);
export const updateProjectSchema = partialWithoutDefaults(createProjectObjectSchema);
export const updatePositionSchema = partialWithoutDefaults(createPositionSchema);
export const updateAgentRuntimeSchema = partialWithoutDefaults(createAgentRuntimeSchema);
export const updateBudgetPolicySchema = partialWithoutDefaults(createBudgetPolicySchema);
export const updateKnowledgeDocSchema = partialWithoutDefaults(createKnowledgeDocSchema);
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
