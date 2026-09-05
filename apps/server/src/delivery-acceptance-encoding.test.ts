import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db, sql as client } from './db/client.ts';
import { kanbanCards, workProducts } from './db/schema.ts';
import { memoryDb } from './test-support/memory-db.ts';
import { sealDeliveryAcceptance } from './delivery-acceptance.ts';

test('acceptance timestamp snapshot preserves PostgreSQL precision before postgres-js wire serialization', async t => {
  const updatedAt = new Date('2026-09-05T12:00:00.000Z');
  const acceptanceUpdatedAt = '2026-09-05 12:00:00.000123+00';
  const card: any = { id: 'child', companyId: 'c', projectId: null, columnStatus: 'done', assigneeId: 'worker', reviewerId: null, body: 'Findings', updatedAt, acceptanceUpdatedAt };
  memoryDb(t, [[kanbanCards, [card]], [workProducts, [{ id: 'p', cardId: card.id, companyId: 'c', projectId: null, agentId: 'worker', type: 'report', summary: 'Durable findings' }]]]);
  let writes = 0;
  t.mock.method(db, 'update', () => ({ set: () => ({ where: (condition: any) => {
    const query = new PgDialect().sqlToQuery(condition);
    const match = /"updated_at" IS NOT DISTINCT FROM \$(\d+)/.exec(query.sql);
    assert.ok(match, 'retain the null-safe optimistic timestamp guard');
    const encoded = query.params[Number(match[1]) - 1];
    // Drizzle replaces the driver's date serializer with identity. This is the
    // same Buffer boundary postgres/src/bytes.js uses for its Bind message.
    const serialize = client.options.serializers[1184]!;
    assert.throws(() => Buffer.byteLength(serialize(updatedAt) as string), { code: 'ERR_INVALID_ARG_TYPE' });
    assert.doesNotThrow(() => Buffer.byteLength(serialize(encoded) as string));
    assert.equal(encoded, acceptanceUpdatedAt);
    writes++;
    return Promise.resolve([]);
  } }) }) as any);
  await sealDeliveryAcceptance(card.id);
  assert.equal(writes, 1);
});
