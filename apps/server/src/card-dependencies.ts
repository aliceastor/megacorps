import { and, eq, inArray, sql as drizzleSql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { cardDependencies, kanbanCards } from './db/schema.ts';

const BATCH_SIZE = 90;

export async function getCardDependencyIds(cardId: string): Promise<string[]> {
  const rows = await db.select({ dependsOnCardId: cardDependencies.dependsOnCardId })
    .from(cardDependencies)
    .where(eq(cardDependencies.cardId, cardId));
  return rows.map((row) => row.dependsOnCardId);
}

export async function detectCardDependencyCycle(cardId: string, dependsOnCardIds: string[]): Promise<boolean> {
  if (dependsOnCardIds.includes(cardId)) return true;
  for (const depId of dependsOnCardIds) {
    const rows = await db.execute(drizzleSql`
      WITH RECURSIVE dep_chain(card_id) AS (
        SELECT ${depId}::uuid
        UNION
        SELECT cd.depends_on_card_id
        FROM dep_chain dc
        JOIN card_dependencies cd ON cd.card_id = dc.card_id
      )
      SELECT 1 FROM dep_chain WHERE card_id = ${cardId}::uuid LIMIT 1
    `);
    if (rows.length > 0) return true;
  }
  return false;
}

export async function setCardDependencies(cardId: string, dependsOnCardIds: string[]): Promise<void> {
  const unique = [...new Set(dependsOnCardIds)];
  if (await detectCardDependencyCycle(cardId, unique)) throw new Error('circular_card_dependency');
  await db.delete(cardDependencies).where(eq(cardDependencies.cardId, cardId));
  if (unique.length > 0) {
    await db.insert(cardDependencies).values(unique.map((dependsOnCardId) => ({ cardId, dependsOnCardId }))).onConflictDoNothing();
  }
  await db.update(kanbanCards).set({ dependencyCardIds: unique, updatedAt: new Date() }).where(eq(kanbanCards.id, cardId));
}

export async function computeBlockedByDependencies(cardIds: string[]): Promise<Set<string>> {
  const blocked = new Set<string>();
  for (let index = 0; index < cardIds.length; index += BATCH_SIZE) {
    const chunk = cardIds.slice(index, index + BATCH_SIZE);
    if (chunk.length === 0) continue;
    const rows = await db.select({ cardId: cardDependencies.cardId })
      .from(cardDependencies)
      .innerJoin(kanbanCards, eq(kanbanCards.id, cardDependencies.dependsOnCardId))
      .where(and(
        inArray(cardDependencies.cardId, chunk),
        drizzleSql`${kanbanCards.columnStatus} NOT IN ('done', 'cancelled')`,
      ));
    for (const row of rows) blocked.add(row.cardId);
  }
  return blocked;
}

export async function dependenciesMet(cardId: string): Promise<boolean> {
  const blocked = await computeBlockedByDependencies([cardId]);
  return !blocked.has(cardId);
}

export async function hydrateCardDependencyState<T extends { id: string; dependencyCardIds?: string[] | null }>(cards: T[]): Promise<Array<T & { dependencyCardIds: string[]; blockedByDependencies: boolean }>> {
  if (cards.length === 0) return [];
  const ids = cards.map((card) => card.id);
  const blocked = await computeBlockedByDependencies(ids);
  const deps = await db.select({ cardId: cardDependencies.cardId, dependsOnCardId: cardDependencies.dependsOnCardId })
    .from(cardDependencies)
    .where(inArray(cardDependencies.cardId, ids));
  const depsByCard = new Map<string, string[]>();
  for (const dep of deps) {
    const current = depsByCard.get(dep.cardId) ?? [];
    current.push(dep.dependsOnCardId);
    depsByCard.set(dep.cardId, current);
  }
  return cards.map((card) => ({
    ...card,
    dependencyCardIds: depsByCard.get(card.id) ?? card.dependencyCardIds ?? [],
    blockedByDependencies: blocked.has(card.id),
  }));
}
