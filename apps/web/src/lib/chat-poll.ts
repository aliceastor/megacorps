import { ApiError } from './api.ts';

type JobLike = { status: string };

export function chatJobPollInterval(jobs: JobLike[] | undefined): number | false {
  return jobs?.some((job) => job.status === 'queued' || job.status === 'running') ? 2_000 : false;
}

export function shouldRetryChatPoll(failureCount: number, error: unknown): boolean {
  return error instanceof ApiError && error.status === 429 ? failureCount < 3 : failureCount < 1;
}

export function chatPollRetryDelay(failureCount: number, error: unknown): number {
  if (error instanceof ApiError && error.status === 429 && error.retryAfterMs != null) return error.retryAfterMs;
  return Math.min(1_000 * 2 ** failureCount, 10_000);
}
