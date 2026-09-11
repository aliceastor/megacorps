import { and, eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, a2aExecutions, a2aExecutionAliases } from './db/schema.ts';
import type { A2aInvocationStore, A2aInvocationRecord } from './a2a-polling.ts';
import { sanitizeCompanyOutput } from './output-secrets.ts';
import { assertAgentRemoteAvailable, assertA2aSubmissionAuthority } from './a2a-remote-reconciliation.ts';

type Executor = Pick<typeof db, 'select' | 'insert' | 'update'>;
async function findExecution(key: string, tx: Executor) {
  const [alias] = await tx.select().from(a2aExecutionAliases).where(eq(a2aExecutionAliases.key, key)).limit(1);
  const [row] = await tx.select().from(a2aExecutions).where(eq(a2aExecutions.key, alias?.executionKey ?? key)).limit(1);
  return row;
}

/** Durable submission ownership. Never silently fall back to an in-memory store. */
export function createA2aExecutionStore(agentId: string): A2aInvocationStore {
  return {
    async begin(seed) {
      return db.transaction(async tx => {
        // The existing agent row serializes first submissions across replicas.
        const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).limit(1).for('update');
        if (!agent) throw new Error('a2a_agent_not_found');
        const known = await findExecution(seed.key, tx);
        if (known) {
          if (known.agentId !== agentId || known.scope !== seed.scope) throw new Error('a2a_invocation_identity_mismatch');
          return { record: known.record, created: false };
        }
        const [pending] = await tx.select().from(a2aExecutions).where(and(eq(a2aExecutions.agentId, agentId), eq(a2aExecutions.scope, seed.scope), eq(a2aExecutions.active, true))).limit(1);
        if (pending) {
          await tx.insert(a2aExecutionAliases).values({ key: seed.key, executionKey: pending.key });
          return { record: pending.record, created: false };
        }
        await assertA2aSubmissionAuthority(seed.key, agentId, tx);
        await assertAgentRemoteAvailable(agentId, tx);
        const record: A2aInvocationRecord = { ...seed, revision: 0 };
        await tx.insert(a2aExecutions).values({ key: seed.key, agentId, companyId: agent.companyId, scope: seed.scope, active: true, record });
        await tx.insert(a2aExecutionAliases).values({ key: seed.key, executionKey: seed.key });
        return { record, created: true };
      });
    },
    async get(key) {
      const row = await findExecution(key, db);
      return row?.agentId === agentId ? row.record : null;
    },
    async compareAndSet(key, revision, patch) {
      const known = await findExecution(key, db);
      if (!known || known.agentId !== agentId) return null;
      const sanitized = patch.outcome ? await sanitizeCompanyOutput(known.companyId, patch.outcome) : null;
      const safePatch = patch.outcome && sanitized ? { ...patch, outcome: {
        ...sanitized,
        // Protocol identities are opaque correlation values, never display text.
        contextId: patch.outcome.contextId, taskId: patch.outcome.taskId, state: patch.outcome.state,
        artifacts: sanitized.artifacts.map((artifact, index) => ({ ...artifact, artifactId: patch.outcome!.artifacts[index]!.artifactId })),
        ...(sanitized.usage ? { usage: { ...sanitized.usage, providerEventId: patch.outcome.usage?.providerEventId } } : {}),
      } } : patch;
      return db.transaction(async tx => {
        if (patch.phase === 'sending') await assertA2aSubmissionAuthority(known.key, agentId, tx);
        const [row] = await tx.select().from(a2aExecutions).where(and(eq(a2aExecutions.key, known.key), eq(a2aExecutions.agentId, agentId))).limit(1).for('update');
        if (!row || row.record.revision !== revision) return null;
        const record = { ...row.record, ...safePatch, revision: revision + 1 };
        await tx.update(a2aExecutions).set({ record, updatedAt: new Date() }).where(eq(a2aExecutions.key, row.key));
        return record;
      });
    },
  };
}

/** Call after the platform has handled the result, never on an HTTP timeout. */
export async function acknowledgeA2aExecution(key: string, executor?: Executor): Promise<void> {
  const acknowledge = async (tx: Executor) => {
    const known = await findExecution(key, tx);
    if (!known) return;
    const [row] = await tx.select().from(a2aExecutions).where(eq(a2aExecutions.key, known.key)).limit(1).for('update');
    if (row?.record.phase === 'terminal' && row.record.outcome?.state !== 'canceled') await tx.update(a2aExecutions).set({ active: false, updatedAt: new Date() }).where(eq(a2aExecutions.key, row.key));
  };
  if (executor) await acknowledge(executor);
  else await db.transaction(acknowledge);
}
