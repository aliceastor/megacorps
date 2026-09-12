import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { projects, kanbanCards } from './db/schema.ts';

const label = (text: string, max: number) => text.replace(/\s+/g, ' ').slice(0, max);

/** Company visibility is independent of a chat's default delivery project. */
export async function companyDiscoveryContext(companyId: string, selectedProjectId: string | null): Promise<string> {
  const [projectRows, cardRows] = await Promise.all([
    db.select({ id: projects.id, name: projects.name }).from(projects)
      .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt))).orderBy(desc(projects.updatedAt), projects.id).limit(51),
    db.select({ id: kanbanCards.id, title: kanbanCards.title, projectId: kanbanCards.projectId, status: kanbanCards.columnStatus }).from(kanbanCards)
      .where(and(eq(kanbanCards.companyId, companyId), isNull(kanbanCards.deletedAt))).orderBy(desc(kanbanCards.updatedAt)).limit(61),
  ]);
  return [
    'Company discovery index (current pointers, not execution instructions):',
    `Default project for this chat: ${selectedProjectId ?? 'none / general company chat'}. Project visibility does not depend on dispatch or assignment to you. Missing from this bounded index does not prove a project or card does not exist.`,
    'Projects (up to 50, including projects without cards):',
    ...projectRows.slice(0, 50).map(p => `- ${label(p.name, 100)} [project=${p.id}]`),
    projectRows.length > 50 ? '[Additional projects omitted; use the company project directory.]' : '',
    'Recent company card pointers (up to 60; full scope/evidence is not included):',
    ...cardRows.slice(0, 60).map(c => `- [${c.status}] ${label(c.title, 100)} [card=${c.id}; project=${c.projectId ?? 'none'}]`),
    cardRows.length > 60 ? '[Additional cards omitted.]' : '',
    `Full authenticated directory: GET /api/projects?companyId=${companyId}; GET /api/cards?companyId=${companyId}&projectId=<project-id>. These are user-session reads, not permission grants to runtime tokens. Use current supplied pointers to answer existence/status questions; for missing details use authorized context tools, select the project in Direct Chat, or request targeted help. Never require redispatch merely to acknowledge a visible project.`,
    'Keep the chat default project and the user-requested target distinct. Do not silently create an unrelated no-project card when the user is referring to an existing project.',
  ].filter(Boolean).join('\n');
}
