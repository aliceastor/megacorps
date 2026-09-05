import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from './db/client.ts';
import { knowledgeDocs } from './db/schema.ts';
import { companyStructure } from './company-workflow.ts';
import { playbookFor } from './role-playbooks.ts';
import { formatAgentPositionPrompt } from './agent-position-prompt.ts';
import { sanitizeCompanyOutput } from './output-secrets.ts';

export const KNOWLEDGE_TOTAL_CHARS = 20_000;
export const KNOWLEDGE_DOC_CHARS = 4_000;
export function relevantKnowledgeTags(docTags: string[] | null, tags: string[]): boolean {
  const normalized = (docTags ?? []).map(t => t.trim().toLowerCase()).filter(Boolean);
  const wanted = new Set(tags.map(t => t.trim().toLowerCase()));
  return !normalized.length || normalized.some(t => t === 'general' || wanted.has(t));
}

export async function buildCompanyKnowledge(companyId: string, tags: string[] = []) {
  const wanted = [...new Set(['general', ...tags.map(t => t.trim().toLowerCase())])];
  // Select relevant documents in PostgreSQL before ordering/limiting; newer
  // unrelated departments must never evict the relevant older charter.
  const rows = await db.select().from(knowledgeDocs).where(and(eq(knowledgeDocs.companyId, companyId), sql`(
    coalesce(cardinality(${knowledgeDocs.tags}), 0) = 0 OR
    NOT EXISTS (SELECT 1 FROM unnest(${knowledgeDocs.tags}) AS knowledge_tag WHERE trim(knowledge_tag) <> '') OR
    EXISTS (SELECT 1 FROM unnest(${knowledgeDocs.tags}) AS knowledge_tag WHERE lower(trim(knowledge_tag)) = ANY(ARRAY[${sql.join(wanted.map(tag => sql`${tag}`), sql`, `)}]::text[]))
  )`)).orderBy(desc(knowledgeDocs.updatedAt), knowledgeDocs.id).limit(21);
  const selected: Array<{ id: string; title: string; updatedAt: string | null; truncated: boolean }> = [];
  let text = 'Company knowledge (current selected documents):\n';
  let omitted = rows.length > 20;
  for (const doc of rows.slice(0, 20)) {
    if (doc.companyId !== companyId || !relevantKnowledgeTags(doc.tags, tags)) continue;
    const header = `\n## ${doc.title} [id=${doc.id}; updatedAt=${doc.updatedAt?.toISOString() ?? 'unknown'}]\n`;
    const room = Math.min(KNOWLEDGE_DOC_CHARS, KNOWLEDGE_TOTAL_CHARS - text.length - header.length - 180);
    if (room <= 0) { omitted = true; break; }
    const truncated = doc.body.length > room;
    text += header + doc.body.slice(0, room) + (truncated ? '\n[document truncated]' : '') + '\n';
    selected.push({ id: doc.id, title: doc.title, updatedAt: doc.updatedAt?.toISOString() ?? null, truncated });
  }
  text += `\n[Selection: ${selected.length} documents; ${omitted ? 'additional matching documents omitted by context budget' : 'no matching documents omitted'}; per document limit 4,000 chars; total limit 20,000 chars.]`;
  return { text, selected, omitted };
}

/** Common bootstrap/refresh context for all execution surfaces. Credentials
 * are supplied separately to the runtime, never through shared knowledge. */
export async function buildCommonCompanyContext(companyId: string, agentId?: string | null, tags: string[] = []) {
  const structure = await companyStructure(companyId);
  const agent = structure.members.find(a => a.id === agentId);
  const role = agent ? structure.roleOf(agent.id) : null;
  const department = structure.divisions.find(d => d.headAgentId === agentId) ?? structure.divisions.find(d => d.id === agent?.departmentId);
  const knowledge = await buildCompanyKnowledge(companyId, [...tags, department?.slug ?? '', department?.name ?? ''].filter(Boolean));
  const position = structure.roles.find(p => p.id === agent?.positionId);
  const custom = role === 'ceo' ? structure.company?.bossRolePrompt : role === 'department_head' ? department?.headRolePrompt : null;
  return sanitizeCompanyOutput(companyId, [
    'Current company role and knowledge context (replaces earlier versions):',
    `Company: ${structure.company?.name ?? companyId}; department: ${department?.name ?? 'unassigned'}; structural role: ${role ?? 'unassigned'}.`,
    role ? playbookFor(role) : '',
    custom ? `Additional role instructions (additive; platform delegation, evidence, review, permission and approval gates remain mandatory):\n${custom.slice(0, 8000)}` : '',
    formatAgentPositionPrompt({ positionName: position?.name, departmentName: department?.name, companyName: structure.company?.name, customPrompt: position?.prompt }),
    knowledge.text,
  ].filter(Boolean).join('\n\n'));
}
