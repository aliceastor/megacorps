// Card-related types and constants shared by the board, the detail panel and
// the pure conversation / situation modules. Moved verbatim out of
// kanban-board.tsx; this file must stay free of React so node:test can import it.

export const statuses = ['todo', 'in_progress', 'in_review', 'needs_review', 'waiting_on_external', 'waiting_on_client', 'waiting_on_brainstorm', 'done', 'blocked', 'cancelled'] as const;
export type CardStatus = (typeof statuses)[number];
export const priorities = ['urgent', 'high', 'normal', 'low'] as const;
export type CardPriority = (typeof priorities)[number];
export const workProductTypes = ['report', 'file', 'preview_url', 'pull_request', 'commit', 'screenshot', 'artifact', 'external'] as const;
export type WorkProductType = (typeof workProductTypes)[number];
export type LocaleLabels = Record<string, string>;
export const statusLabels: Record<CardStatus, LocaleLabels> = {
  todo: { 'zh-TW': '待辦', en: 'Todo', ja: '未着手' },
  in_progress: { 'zh-TW': '執行中', en: 'In Progress', ja: '進行中' },
  in_review: { 'zh-TW': '審核中', en: 'In Review', ja: 'レビュー中' },
  needs_review: { 'zh-TW': '求助審核', en: 'Needs Review', ja: '支援レビュー' },
  waiting_on_external: { 'zh-TW': '等待外部', en: 'Waiting External', ja: '外部待ち' },
  waiting_on_client: { 'zh-TW': '等你回答', en: 'Waiting Client', ja: 'クライアント待ち' },
  waiting_on_brainstorm: { 'zh-TW': '腦力激盪中', en: 'Brainstorming', ja: 'ブレスト中' },
  done: { 'zh-TW': '完成', en: 'Done', ja: '完了' },
  blocked: { 'zh-TW': '受阻', en: 'Blocked', ja: 'ブロック' },
  cancelled: { 'zh-TW': '已取消', en: 'Cancelled', ja: 'キャンセル' },
};

export type Card = {
  id: string;
  title: string;
  body: string;
  columnStatus: string;
  tags: string[];
  priority: number;
  companyId?: string;
  departmentId?: string | null;
  assigneeId?: string | null;
  reviewerId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  parentCardId?: string | null;
  dependencyCardIds?: string[];
  decisionMode?: string | null;
  requiresApproval?: boolean;
  retryCount?: number;
  maxRetries?: number;
  scheduleAt?: string | null;
  recurEveryMinutes?: number | null;
  recurNextAt?: string | null;
  scheduledFromCardId?: string | null;
  executionLog?: string | null;
  reviewFeedback?: string | null;
  sessionId?: string | null;
  costUsd?: string | null;
  executionLockId?: string | null;
  activeHeartbeatRunId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  workflowProcessAgentId?: string | null;
  workflowReviewAgentId?: string | null;
  rollupStatus?: string | null;
  splitRound?: number | null;
  brainstormRound?: number | null;
  forceBrainstorm?: boolean | null;
};
export type Agent = { id: string; companyId?: string; name: string; slug?: string; role?: string; adapterType?: string; isBusy?: boolean };
export type Company = { id: string; name: string };
export type Department = { id: string; companyId: string; name: string };
export type Project = { id: string; companyId: string; name: string };
export type Goal = { id: string; companyId: string; departmentId?: string | null; projectId?: string | null; title: string };
export type TaskLog = { id: string; type: string; status: string; message: string; output?: string; costUsd?: string; durationSeconds?: number; createdAt?: string };
export type TaskRun = { id: string; cardId: string; kind: string; status: string };
export type ApiEvent = { id: string; method: string; path: string; statusCode?: number; requestBody?: unknown; responseBody?: unknown; error?: string | null; durationMs?: number; createdAt?: string };
export type CardComment = {
  id: string;
  body: string;
  action: string;
  authorType: string;
  agentId?: string | null;
  authorId?: string | null;
  parentCommentId?: string | null;
  assigneeAgentId?: string | null;
  reviewerAgentId?: string | null;
  reviewerScope?: 'phase' | 'final' | null;
  delegationStatus?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
};
export type CardAction = { id: string; actorType: string; actorId: string; action: string; fromStatus?: string | null; toStatus?: string | null; detail?: string | null; metadata?: unknown; createdAt?: string };
export type WorkProduct = { id: string; cardId?: string | null; projectId?: string | null; agentId?: string | null; type: string; title: string; summary?: string | null; url?: string | null; repoProvider?: string | null; repoUrl?: string | null; branch?: string | null; commitSha?: string | null; pullRequestUrl?: string | null; createdAt?: string };
export type CardDelegationSummary = { phaseAssigneeId?: string | null; phaseReviewerId?: string | null; phaseStatus?: string | null; phaseUpdatedAt?: string | null; phaseSourceAction?: string | null; phaseSourceCommentId?: string | null };
export type CachedRows<T> = { rows: T[]; cachedAt: number };
export type CachedValue<T> = { value: T; cachedAt: number };
export type CardTabCache = {
  comments?: CachedRows<CardComment>;
  logs?: CachedRows<TaskLog>;
  actions?: CachedRows<CardAction>;
  apiLogs?: CachedRows<ApiEvent>;
  workProducts?: CachedRows<WorkProduct>;
  delegationSummary?: CachedValue<CardDelegationSummary>;
};
export type CardTabKey = keyof CardTabCache;
export type CardDetailTab = 'details' | 'comments' | 'delegation' | 'thread' | 'logs' | 'workProducts';
export type CommentActionMode = 'comment' | 'agent_note' | 'pause_agent' | 'send_to_agent' | 'continue_run' | 'escalate_to_reviewer' | 'delegate_to_agent';
export type ReviewerScope = 'phase' | 'final';
