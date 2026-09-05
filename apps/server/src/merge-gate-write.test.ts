import assert from 'node:assert/strict';
import test from 'node:test';
import { retryMergeGateWrite } from './db/merge-gate-write.ts';

test('gate write retries the whole DB operation for wrapped lock contention only', async () => {
  let attempts = 0;
  const result = await retryMergeGateWrite(async () => {
    attempts++;
    if (attempts < 3) throw new Error('query failed', { cause: { code: attempts === 1 ? '55P03' : '40P01' } });
    return 'committed';
  });
  assert.equal(result, 'committed'); assert.equal(attempts, 3);
  for (const code of ['MC409', '23503', '08006']) {
    attempts = 0;
    const error = Object.assign(new Error('not retryable'), { code });
    await assert.rejects(retryMergeGateWrite(async () => { attempts++; throw error; }), (caught) => caught === error);
    assert.equal(attempts, 1);
  }
});

test('persistent gate contention exhausts five attempts with an actionable conflict', async () => {
  let attempts = 0;
  await assert.rejects(retryMergeGateWrite(async () => { attempts++; throw { code: '55P03' }; }), (error: any) => {
    assert.equal(error.statusCode, 409); assert.equal(error.code, 'merge_gate_write_busy');
    assert.match(error.message, /retry/i); return true;
  });
  assert.equal(attempts, 5);
});
