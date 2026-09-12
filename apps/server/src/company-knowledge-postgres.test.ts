import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isolatedPostgres } from './test-support/postgres-db.ts';

test('PostgreSQL knowledge selection keeps older mandatory documents ahead of newer general documents', {
  skip: !process.env.TEST_DATABASE_URL && !process.env.CI ? 'TEST_DATABASE_URL absent; isolated PostgreSQL checks run in CI' : false,
  timeout: 60_000,
}, async t => {
  const { db } = await isolatedPostgres(t);
  const { companies, knowledgeDocs } = await import('./db/schema.ts');
  const { buildCompanyKnowledge } = await import('./company-context.ts');
  const [company] = await db.insert(companies).values({ name: 'Knowledge fixture', slug: `knowledge-${randomUUID()}` }).returning();
  const [foreign] = await db.insert(companies).values({ name: 'Other company', slug: `other-${randomUUID()}` }).returning();
  const [handbook, policy] = await db.insert(knowledgeDocs).values([
    { companyId: company!.id, title: 'Required handbook', tags: [' Handbook '], body: 'Mandatory workflow', updatedAt: new Date('2020-01-01') },
    { companyId: company!.id, title: 'Required policy', tags: ['POLICY'], body: 'Required evidence policy', updatedAt: new Date('2020-01-02') },
  ]).returning();
  await db.insert(knowledgeDocs).values([
    ...Array.from({ length: 24 }, (_, i) => ({ companyId: company!.id, title: `General ${i}`, tags: ['general'], body: 'Recent general reference', updatedAt: new Date('2026-09-01') })),
    { companyId: company!.id, title: 'Unrelated specialist', tags: ['finance'], body: 'Unrelated material', updatedAt: new Date('2026-09-02') },
    { companyId: foreign!.id, title: 'Foreign handbook', tags: ['handbook'], body: 'Foreign confidential material', updatedAt: new Date('2026-09-02') },
  ]);
  const result = await buildCompanyKnowledge(company!.id, ['engineering']);
  assert.deepEqual(result.selected.slice(0, 2).map(doc => doc.id), [policy!.id, handbook!.id]);
  assert.equal(result.selected.length, 20);
  assert.equal(result.omitted, true);
  assert.match(result.text, /Mandatory workflow/);
  assert.match(result.text, /Required evidence policy/);
  assert.doesNotMatch(result.text, /Unrelated material|Foreign confidential material/);
});
