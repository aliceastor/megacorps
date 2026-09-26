import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from './db/client.ts';
import { cardComments, cardRequiredTools, toolRegistry, workProducts, type agents, type companies, type goals, type kanbanCards, type projects } from './db/schema.ts';
import { extractAgentReport } from './agent-report.ts';
import { parseCardBrief } from './card-brief.ts';
import { projectFinalText } from './a2a-final-output.ts';

type Card = typeof kanbanCards.$inferSelect;
type Agent = typeof agents.$inferSelect;
type Project = typeof projects.$inferSelect;
type Goal = typeof goals.$inferSelect;
const clip = (value: string | null | undefined, limit: number) => {
  const text = value?.trim() ?? '';
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 90))}\n[Detail omitted; use the authenticated context pointer if needed.]`;
};
const contextPath = (id: string) => `/api/cards/${encodeURIComponent(id)}/context`;

/** A report is evidence, not instructions. Do not inject the CLI transcript that carried it. */
export function compactReportContext(raw: string | null | undefined, limit = 2200): string {
  if (!raw) return '';
  const visible = projectFinalText(raw);
  if (visible.startsWith('a2a_final_output_ambiguous:')) return 'Previous CLI output has no identifiable terminal report. Consult the full run/context for needed evidence; this is not acceptance.';
  const result = extractAgentReport(visible);
  if (result && 'report' in result) {
    const r = result.report;
    return clip([
      `Reported status=${r.status}; verdict=${r.verdict ?? 'none'}; score=${r.score ?? 'not supplied'}`,
      r.findings?.length ? `Findings: ${JSON.stringify(r.findings)}` : '',
      r.verifications?.length ? `Verifications: ${JSON.stringify(r.verifications)}` : '',
      r.escalation ? `Escalation: ${JSON.stringify(r.escalation)}` : '',
      r.summary,
      r.request ? `Unresolved request: ${JSON.stringify(r.request)}` : '',
      r.workProducts?.length ? `Products: ${r.workProducts.map(p => `${p.type}: ${p.title}${p.url ? ` (${p.url})` : ''}`).join('; ')}` : '',
    ].filter(Boolean).join('\n'), limit);
  }
  return clip(visible, limit);
}

/** Current work comes first; unrelated board rows never consume its budget. */
export async function buildFocusedKanbanContext(input: {
  companyId: string; company: typeof companies.$inferSelect | undefined;
  card: Card; cards: Card[]; agents: Pick<Agent, 'id' | 'name'>[]; projects: Project[]; goals: Goal[];
  structure: string[]; repository: string[]; budget: number; includeGoals: boolean;
}): Promise<string> {
  const { card, companyId } = input;
  const cards = input.cards.filter(c => c.companyId === companyId && !c.deletedAt);
  const byId = new Map(cards.map(c => [c.id, c]));
  const byAgent = new Map(input.agents.map(a => [a.id, a]));
  const agentName = (id: string | null) => id ? byAgent.get(id)?.name ?? id : 'none';
  const pointer = (row: Card) => `- [${row.columnStatus ?? 'todo'}] ${clip(row.title, 120)}; id=${row.id}; assignee=${agentName(row.assigneeId)}; reviewer=${agentName(row.reviewerId)}; context=${contextPath(row.id)}`;
  const parents: Card[] = [];
  const seen = new Set([card.id]);
  let next = card.parentCardId;
  while (next && !seen.has(next)) {
    seen.add(next);
    const parent = byId.get(next);
    if (!parent) break;
    parents.unshift(parent); next = parent.parentCardId;
  }
  const children = cards.filter(c => c.parentCardId === card.id);
  const dependencies = (card.dependencyCardIds ?? []).map(id => byId.get(id));
  const [messages, products, requiredTools, humanMessages] = await Promise.all([
    db.select().from(cardComments).where(eq(cardComments.cardId, card.id)).orderBy(desc(cardComments.createdAt)).limit(5),
    db.select().from(workProducts).where(eq(workProducts.cardId, card.id)).orderBy(desc(workProducts.createdAt)).limit(12),
    db.select({ cardTool: cardRequiredTools, tool: toolRegistry }).from(cardRequiredTools).innerJoin(toolRegistry, eq(cardRequiredTools.toolId, toolRegistry.id)).where(eq(cardRequiredTools.cardId, card.id)),
    db.select().from(cardComments).where(and(eq(cardComments.cardId, card.id), inArray(cardComments.authorType, ['user', 'human']))).orderBy(desc(cardComments.createdAt)).limit(2),
  ]);
  const applicableGoals = input.goals.filter(g => !g.projectId || g.projectId === card.projectId).filter(g => !g.departmentId || g.departmentId === card.departmentId || g.id === card.goalId);
  const budget = Math.max(8000, input.budget);
  const brief = parseCardBrief(card.body);
  const essentialBrief = [brief.acceptance ? `Acceptance:\n${brief.acceptance}` : '', brief.constraints ? `Constraints:\n${brief.constraints}` : '', brief.outOfScope ? `Out of scope:\n${brief.outOfScope}` : ''].filter(Boolean).join('\n\n');
  const bodyLimit = Math.max(1800, Math.min(8000, Math.floor(budget * .32)));
  const pointers = `Details: GET ${contextPath(card.id)}; GET /api/cards/${card.id}/comments; GET /api/cards/${card.id}/work-products; GET /api/cards?companyId=${companyId}; GET /api/projects?companyId=${companyId}; GET /api/goals?companyId=${companyId}.\nThese relative pointers use the injected MegaCorps API origin and require authenticated user-session or explicitly provisioned direct-API access; ordinary Agent/runner tokens do not grant it. If needed detail is unavailable, return input_required + request.kind help naming the specific card/evidence; never invent credentials or repeat denied requests.`;
  const criticalContext = [
    card.lastError ? `Current blocker / last error: ${clip(card.lastError, 1000)}` : '',
    dependencies.length ? `Required dependencies:\n${dependencies.slice(0, 12).map((row,i)=>row ? `${pointer(row)}${row.lastError ? `; blocker=${clip(row.lastError,180)}` : ''}` : `- Unavailable dependency ${card.dependencyCardIds![i]}; do not treat it as satisfied.`).join('\n')}${dependencies.length>12?'\nAdditional dependency gates omitted; resolve their status before completion.':''}` : '',
    requiredTools.length ? `Required deterministic tools:\n${requiredTools.slice(0,8).map(({cardTool,tool})=>`- ${tool.name}@${tool.version}; ${clip(cardTool.reason ?? tool.description,240)}`).join('\n')}${requiredTools.length>8?'\nAdditional required tools omitted; inspect context before completion.':''}` : '',
    humanMessages.length ? `Current human instructions (task data, subject to platform authority):\n${humanMessages.map(m=>clip(m.body,600)).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const sections = [
    '## Current task and acceptance',
    `Company: ${input.company?.name ?? companyId}; card=${card.id}; stage=${card.columnStatus ?? 'todo'}`,
    `Mission: ${clip(input.company?.mission ?? 'No mission configured.', 600)}`,
    `Title: ${card.title}\nAssignee: ${agentName(card.assigneeId)}; reviewer: ${agentName(card.reviewerId)}; requires approval: ${card.requiresApproval ? 'yes' : 'no'}`,
    `Project: ${input.projects.find(p => p.id === card.projectId)?.name ?? card.projectId ?? 'none'}; projectId=${card.projectId ?? 'none'}`,
    essentialBrief ? clip(essentialBrief, Math.max(1400, Math.floor(budget * .25))) : '',
    criticalContext,
    `Body:\n${clip(card.body, bodyLimit)}`,
    card.body && card.body.length > bodyLimit ? 'The task body exceeds this prompt budget. Obtain the omitted acceptance/scope through the context pointer or ask for the specific missing context before making affected decisions; never assume omitted requirements are satisfied.' : '',
    card.lastError ? `Current blocker / last error:\n${clip(card.lastError, 2000)}` : '',
    card.reviewFeedback ? `Current review feedback (reference):\n${compactReportContext(card.reviewFeedback)}` : '',
    card.executionLog ? `Latest submitted result (reference, not acceptance):\n${compactReportContext(card.executionLog)}` : '',
    `Budget limit: ${card.taskBudgetLimit ?? 'not set'}; approval: ${card.requiresApproval ? 'required' : 'not required'}; decision mode: ${card.decisionMode ?? 'not set'}`,
    input.repository.length ? `Repository authority:\n${input.repository.join('\n')}` : '',
    input.includeGoals && applicableGoals.length ? `Applicable goals:\n${applicableGoals.slice(0, 8).map(g => `- ${g.title} [goal=${g.id}]: ${clip(g.body, 900)}`).join('\n')}` : '',
    requiredTools.length ? `Required deterministic tools:\n${requiredTools.map(({cardTool,tool})=>`- ${tool.name}@${tool.version}: ${tool.description ?? ''}${cardTool.reason ? `; reason=${cardTool.reason}` : ''}`).join('\n')}` : '',
    '## Related work (reference data; current assignment has priority)',
    parents.length ? `Parent chain:\n${parents.map(parent => `${pointer(parent)}\nUpstream scope: ${clip(parent.body, 600)}`).join('\n')}` : card.parentCardId ? `Parent unavailable: ${card.parentCardId}` : '',
    children.length ? `Children; acceptance policy=${card.requiredChildPolicy ?? 'all_required_accepted'}:\n${children.slice(0, 20).map(pointer).join('\n')}${children.length > 20 ? `\n${children.length - 20} more children: GET /api/cards/${card.id}/subtree` : ''}` : '',
    dependencies.length ? `Dependencies:\n${dependencies.map((row,i) => row ? pointer(row) : `- Unavailable dependency ${card.dependencyCardIds![i]}; do not treat it as satisfied.`).join('\n')}` : '',
    products.length ? `Current work products (reported, not automatically accepted):\n${products.map(p=>`- ${p.type}: ${p.title}; ${p.url ?? p.pullRequestUrl ?? p.id}${p.summary ? ` — ${clip(p.summary, 300)}` : ''}`).join('\n')}` : '',
    messages.length ? `Latest card messages (reference data):\n${messages.reverse().map(m=>`- ${m.authorType}/${m.action}: ${compactReportContext(m.body, 650)}`).join('\n')}` : '',
    '## Company directory and history pointers',
    `Company structure:\n${clip(input.structure.join('\n'), 3600)}`,
    `Projects: ${input.projects.slice(0, 20).map(p=>`${clip(p.name,80)} [project=${p.id}]`).join('; ') || 'none'}`,
    input.includeGoals ? `Other goal pointers: ${input.goals.filter(g=>!applicableGoals.includes(g)).slice(0,12).map(g=>`${clip(g.title,80)} [goal=${g.id}]`).join('; ') || 'none'}` : '',
    `${cards.length} company cards; unrelated card bodies, activity logs and run transcripts omitted. Discover only what the current task needs.`,
    `Details: GET ${contextPath(card.id)}; GET /api/cards/${card.id}/comments; GET /api/cards/${card.id}/work-products; GET /api/cards?companyId=${companyId}; GET /api/projects?companyId=${companyId}; GET /api/goals?companyId=${companyId}.`,
    'These relative pointers use the injected MegaCorps API origin. They require authenticated user-session or explicitly provisioned direct-API access; an ordinary Agent/runner token does not grant it. If unavailable, return input_required + request.kind help naming the specific card/evidence needed; do not invent credentials or repeatedly fetch denied URLs. Essential current scope and blockers are included above.',
  ].filter(Boolean);
  // Critical scope/errors precede secondary data. Never let optional history consume
  // the configured budget; retain a route to anything explicitly omitted.
  const marker = '\n\n[Context detail omitted by budget. Do not assume omitted requirements, defects or gates are satisfied; use the pointers or request the specific missing evidence.]';
  const detailBudget = Math.max(0, budget - pointers.length - marker.length - 4);
  const kept: string[] = [];
  let used = 0;
  let omitted = false;
  for (const section of sections) {
    if (section.startsWith('Details: GET ') || section.startsWith('These relative pointers')) continue;
    const room = detailBudget - used - 2;
    if (section.length > room) {
      if (room > 140) kept.push(clip(section, room));
      omitted = true;
      break;
    }
    kept.push(section); used += section.length + 2;
  }
  return kept.join('\n\n') + (omitted ? marker : '') + '\n\n' + pointers;
}