import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, companies, departments, positions } from './db/schema.ts';
import { structuralRole } from './role-playbooks.ts';
import { agentRuntimeAvailable, createRuntimeAvailabilityCache } from './runner-availability.ts';
import { adapterRequiresRuntime } from './adapters/config.ts';
import type { AgentResult } from './agent-results.ts';

type Agent = typeof agents.$inferSelect;
export async function companyStructure(companyId: string) {
  const [[company], members, divisions, roles] = await Promise.all([
    db.select().from(companies).where(eq(companies.id, companyId)).limit(1),
    db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
    db.select().from(departments).where(eq(departments.companyId, companyId)),
    db.select().from(positions).where(eq(positions.companyId, companyId)),
  ]);
  const bossIds = new Set(roles.filter(p => p.isCompanyBoss).map(p => p.id));
  const bosses = members.filter(a => a.positionId && bossIds.has(a.positionId));
  const roleOf = (agentId: string) => structuralRole({ isCompanyBoss: bosses.some(a => a.id === agentId), isDepartmentHead: divisions.some(d => d.headAgentId === agentId) && members.some(a => a.id === agentId) });
  const targetsFor = (agentId: string) => {
    const role = roleOf(agentId);
    if (role === 'ceo') return members.filter(a => a.id !== agentId && !bosses.some(b => b.id === a.id) && divisions.some(d => d.headAgentId === a.id && a.departmentId === d.id));
    const ownDepartments = new Set(divisions.filter(d => d.headAgentId === agentId).map(d => d.id));
    return members.filter(a => a.id !== agentId && !bosses.some(b => b.id === a.id) && (role === 'department_head' ? Boolean(a.departmentId && ownDepartments.has(a.departmentId)) && roleOf(a.id) === 'member' : a.bossId === agentId));
  };
  return { company, members, divisions, roles, bosses, roleOf, targetsFor };
}

export async function companyExecutionReadiness(companyId: string, actorId?: string | null, departmentId?: string | null) {
  const structure = await companyStructure(companyId);
  const issues: string[] = [];
  const setupIssues: string[] = [];
  if (!structure.company) issues.push('Create the company before executing work.');
  if (structure.bosses.length !== 1) issues.push(`Assign exactly one company Boss position to an agent (found ${structure.bosses.length}).`);
  if (!structure.divisions.length) issues.push('Create at least one department and assign its head.');
  for (const department of structure.divisions) {
    const head = structure.members.find(a => a.id === department.headAgentId);
    if (!head) {
      const message = `Assign a same-company head to department ${department.name}.`;
      setupIssues.push(message);
      if (department.headAgentId || department.id === departmentId || structure.members.some(a => a.id === actorId && a.departmentId === department.id)) issues.push(message);
    }
    else if (structure.roleOf(head.id) === 'ceo') issues.push(`Boss and department head must be distinct agents (${department.name}).`);
    else if (head.departmentId !== department.id) issues.push(`Move ${head.name} into department ${department.name} or choose its member as head.`);
  }
  if (!structure.members.some(a => structure.roleOf(a.id) === 'department_head' && structure.divisions.some(d => d.headAgentId === a.id && a.departmentId === d.id))) issues.push('Assign at least one usable department head distinct from the Boss.');
  if (departmentId && !structure.divisions.some(d => d.id === departmentId)) issues.push('Selected department must belong to this company.');
  const runtimeIssues: string[] = [];
  const candidates = actorId ? structure.members.filter(a => a.id === actorId) : [...structure.bosses, ...structure.members.filter(a => structure.roleOf(a.id) === 'department_head')];
  if (actorId && !candidates.length) issues.push('Assignment must name a member of this company.');
  const cache = createRuntimeAvailabilityCache();
  for (const agent of candidates) {
    if (agent.isActive === false) runtimeIssues.push(`Resume paused agent ${agent.name}.`);
    if (agent.isBusy) runtimeIssues.push(`Agent ${agent.name} is busy; wait for its active run.`);
    if ((adapterRequiresRuntime(agent.adapterType) && !agent.runtimeId) || !(await agentRuntimeAvailable({ companyId, runtimeId: agent.runtimeId, adapterType: agent.adapterType }, cache))) runtimeIssues.push(`Configure an available same-company runtime for ${agent.name}.`);
  }
  return { ready: !issues.length && !runtimeIssues.length, structureReady: !issues.length, issues, setupIssues, runtimeIssues, repositoryWriteAccess: 'not_checked' as const };
}

export async function assertCompanyExecutionReady(companyId: string, actorId?: string | null, departmentId?: string | null) {
  const readiness = await companyExecutionReadiness(companyId, actorId, departmentId);
  if (!readiness.structureReady) throw new Error(`company_structure_unready: ${readiness.issues.join(' ')}`);
  if (readiness.runtimeIssues.length) throw new Error(`company_runtime_unavailable: ${readiness.runtimeIssues.join(' ')}`);
}

export async function structuralAssignment(companyId: string, actorId: string) {
  const structure = await companyStructure(companyId);
  const role = structure.roleOf(actorId);
  const targets = structure.targetsFor(actorId);
  const cache = createRuntimeAvailabilityCache();
  const available: Agent[] = [];
  for (const target of targets) if (target.isActive !== false && !target.isBusy && (!adapterRequiresRuntime(target.adapterType) || target.runtimeId) && await agentRuntimeAvailable({ companyId, runtimeId: target.runtimeId, adapterType: target.adapterType }, cache)) available.push(target);
  return { ...structure, role, targets, available, delegationRequired: role === 'ceo' || (role === 'department_head' && targets.length > 0) };
}

export async function structuralCompletionIssue(card: { companyId: string }, actorId: string, result: AgentResult): Promise<string | null> {
  if (result.outcome !== 'completed') return null;
  const assignment = await structuralAssignment(card.companyId, actorId);
  if (assignment.role !== 'department_head' || assignment.targets.length) return null;
  const summary = result.report?.summary ?? '';
  const verification = result.workProducts.some(product => Boolean(product.summary?.trim() || product.url)) || Boolean(result.report?.artifactRefs?.length);
  if (!/self[ -]check/i.test(summary) || !verification) return 'sole_head_self_check_required: Supply a completed report explicitly labelled SELF-CHECK with concrete verification details and artifactRefs or workProducts evidence. This is not independent QA; explicit review gates still apply.';
  return null;
}

export async function isBossAssessment(companyId: string, reviewerId?: string | null): Promise<boolean> {
  return Boolean(reviewerId && (await companyStructure(companyId)).roleOf(reviewerId) === 'ceo');
}

export async function structuralReviewer(companyId: string, actorId: string, explicit?: string | null): Promise<string | null> {
  const structure = await companyStructure(companyId);
  if (explicit && explicit !== actorId && structure.members.some(a => a.id === explicit)) return explicit;
  const actor = structure.members.find(a => a.id === actorId);
  if (!actor || structure.roleOf(actorId) === 'ceo') return null;
  const head = structure.divisions.find(d => d.id === actor.departmentId)?.headAgentId;
  if (head && head !== actorId && structure.members.some(a => a.id === head)) return head;
  if (structure.roleOf(actorId) === 'department_head') return structure.bosses[0]?.id ?? null;
  return actor.bossId && structure.members.some(a => a.id === actor.bossId) ? actor.bossId : null;
}
