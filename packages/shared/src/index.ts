import { z } from 'zod';

export const cardStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'] as const;
export type CardStatus = (typeof cardStatuses)[number];
export const agentAdapterTypes = ['hermes', 'hermes-gateway', 'openclaw', 'webhook', 'mock'] as const;
export type AgentAdapterType = (typeof agentAdapterTypes)[number];

const allowedTransitions: Record<CardStatus, CardStatus[]> = {
  backlog: ['todo', 'blocked'],
  todo: ['in_progress', 'blocked'],
  in_progress: ['in_review', 'blocked'],
  in_review: ['done', 'in_progress', 'blocked'],
  done: [],
  blocked: ['todo'],
};

export function canTransitionCard(from: CardStatus, to: CardStatus): boolean {
  if (from === to) return true;
  return allowedTransitions[from].includes(to);
}

export const prioritySchema = z.enum(['urgent', 'high', 'normal', 'low']);
export const cardStatusSchema = z.enum(cardStatuses);

export const createCardSchema = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1, 'body must not be empty'),
  priority: prioritySchema.default('normal'),
  tags: z.array(z.string().trim().min(1).max(40)).default([]),
  assigneeId: z.string().uuid().nullable().optional(),
  reviewerId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  parentCardId: z.string().uuid().nullable().optional(),
  dependencyCardIds: z.array(z.string().uuid()).default([]),
  requiresApproval: z.boolean().default(false),
  maxRetries: z.number().int().min(1).max(10).default(3),
});

export const updateCardSchema = createCardSchema.partial().extend({
  columnStatus: cardStatusSchema.optional(),
  updatedAt: z.string().datetime().optional(),
});

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(80),
  role: z.string().trim().min(1).max(80),
  title: z.string().trim().max(120).optional(),
  adapterType: z.enum(agentAdapterTypes).default('hermes'),
  hermesProfile: z.string().trim().min(1).max(80).optional(),
  bossId: z.string().uuid().nullable().optional(),
  budgetPerTask: z.number().nonnegative().optional(),
  budgetMonthly: z.number().nonnegative().optional(),
});

export const taskLogTypes = ['dispatch', 'retry', 'review', 'decomposition', 'cascade', 'webhook', 'manual', 'stage'] as const;
export type TaskLogType = (typeof taskLogTypes)[number];

export const taskLogSchema = z.object({
  cardId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  type: z.enum(taskLogTypes),
  status: z.enum(['queued', 'running', 'success', 'failed']),
  message: z.string().trim().min(1).max(2000),
  output: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
});

export const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type TaskLogInput = z.infer<typeof taskLogSchema>;
