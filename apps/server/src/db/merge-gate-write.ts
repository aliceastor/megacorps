function contentionCode(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
    const value = cause as { code?: string; cause?: unknown };
    if (value.code === '55P03' || value.code === '40P01') return true;
    cause = value.cause;
  }
  return false;
}

/** Only pass a complete DB statement or transaction. Never retry an outer
 * handler, a partial transaction, or a callback containing external effects.
 * NOWAIT/PG deadlock errors roll back that operation before we try again.
 */
export async function retryMergeGateWrite<T>(operation: () => PromiseLike<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!contentionCode(error)) throw error;
      if (attempt === 4) throw Object.assign(new Error('merge_gate_write_busy: Concurrent authorization changes did not settle. The database operation was rolled back; retry this change shortly.', { cause: error }), { code: 'merge_gate_write_busy', statusCode: 409 });
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}
