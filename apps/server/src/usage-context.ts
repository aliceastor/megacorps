import { AsyncLocalStorage } from 'node:async_hooks';

// Correlation only; this value is never an authentication credential.
const context = new AsyncLocalStorage<{ attemptKey: string }>();
export const currentUsageAttempt = () => context.getStore()?.attemptKey;
export const withUsageAttempt = <T>(attemptKey: string, operation: () => Promise<T>) => context.run({ attemptKey }, operation);
