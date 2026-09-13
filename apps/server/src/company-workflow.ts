import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, companies, departments, positions } from './db/schema.ts';
import { structuralRole } from './role-playbooks.ts';
import { agentRuntimeAvailable, createRuntimeAvailabilityCache } from './runner-availability.ts';
import { adapterRequiresRuntime } from './adapters/config.ts';
import type { AgentResult } from './agent-results.ts';
import { currentA2aRecoveryRun } from './a2a-task-recovery.ts';

type Agent = typeof agents.$inferSelect;
type Department = typeof departments.$inferSelect;
type Position = typeof positions.$inferSelect;

export function departmentRepresentative(department: Department, members: Agent[], roles: Position[]): Agent | null {
  const bossPositionIds = new Set(roles.filter(role => role.companyId === department.companyId && role.isCompanyBoss).map(role => role.id));
  const formalHead = members.find(member => member.id === department.headAgentId
    && member.companyId === department.companyId
    && member.departmentId === department.id
    && !(member.positionId && bossPositionIds.has(member.positionId)));
  if (formalHead) return formalHead;
  const positionById = new Map(roles
    .filter(role => role.companyId === department.companyId && role.isActive !== false)
    .map(role => [role.id, role]));
  return members
    .filter(member => member.companyId === department.companyId && member.departmentId === department.id && member.isActive !== false)
    .map(member => ({ member, position: member.positionId ? positionById.get(member.positionId) : undefined }))
    .filter((entry): entry is { member: Agent; position: Position } => Boolean(entry.position)
      && !entry.position!.isCompanyBoss
      && Number.isInteger(entry.position!.rank)
      && entry.position!.rank >= 0
      && entry.position!.rank <= 9)
    .sort((left, right) => left.position.rank - right.position.rank || left.member.id.localeCompare(right.member.id))[0]?.member ?? null;
}

export async function companyStructure(companyId: string) {
  const [[company], members, divisions, roles] = await Promise.all([
    db.select().from(companies).where(eq(companies.id, companyId)).limit(1),
    db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
    db.select().from(departments).where(eq(departments.companyId, companyId)),
    db.select().from(positions).where(eq(positions.companyId, companyId)),
  ]);
  const bossIds = new Set(roles.filter(p => p.isCompanyBoss).map(p => p.id));
  const bosses = members.filter(a => a.positionId && bossIds.has(a.positionId));
  const representatives = divisions.map(department => ({ department, agent: departmentRepresentative(department, members, roles) }));
  const roleOf = (agentId: string) => structuralRole({ isCompanyBoss: bosses.some(a => a.id === agentId), isDepartmentHead: divisions.some(d => d.headAgentId === agentId) && members.some(a => a.id === agentId) });
  const targetsFor = (agentId: string) => {
    const role = roleOf(agentId);
    if (role === 'ceo') return representatives.map(entry => entry.agent).filter((agent): agent is Agent => Boolean(agent) && agent!.id !== agentId);
    const ownDepartments = new Set(divisions.filter(d => d.headAgentId === agentId).map(d => d.id));
    return members.filter(a => a.id !== agentId && !bosses.some(b => b.id === a.id) && (role === 'department_head' ? Boolean(a.departmentId && ownDepartments.has(a.departmentId)) && roleOf(a.id) === 'member' : a.bossId === agentId));
  };
  return { company, members, divisions, roles, bosses, representatives, roleOf, targetsFor };
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
      const representative = structure.representatives.find(entry => entry.department.id === department.id)?.agent;
      if (!representative) {
        const message = `Assign a same-company head or active ranked member to department ${department.name}.`;
        setupIssues.push(message);
        if (department.headAgentId || department.id === departmentId || structure.members.some(a => a.id === actorId && a.departmentId === department.id)) issues.push(message);
      }
    }
    else if (structure.roleOf(head.id) === 'ceo') issues.push(`Boss and department head must be distinct agents (${department.name}).`);
    else if (head.departmentId !== department.id) issues.push(`Move ${head.name} into department ${department.name} or choose its member as head.`);
  }
  if (!structure.representatives.some(entry => entry.agent)) issues.push('Assign at least one usable department representative distinct from the Boss.');
  if (departmentId && !structure.divisions.some(d => d.id === departmentId)) issues.push('Selected department must belong to this company.');
  const runtimeIssues: string[] = [];
  const candidates = actorId ? structure.members.filter(a => a.id === actorId) : [...structure.bosses, ...structure.representatives.map(entry => entry.agent).filter((agent): agent is Agent => Boolean(agent))];
  if (actorId && !candidates.length) issues.push('Assignment must name a member of this company.');
  const cache = createRuntimeAvailabilityCache();
  const recovery = currentA2aRecoveryRun();
  for (const agent of candidates) {
    if (agent.isActive === false) runtimeIssues.push(`Resume paused agent ${agent.name}.`);
    const resumesOwnRun = recovery?.agentId === agent.id && recovery.companyId === companyId && recovery.status === 'running';
    if (agent.isBusy && !resumesOwnRun) runtimeIssues.push(`Agent ${agent.name} is busy; wait for its active run.`);
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
  const eligible: Agent[] = [];
  for (const target of targets) if (target.isActive !== false && (!adapterRequiresRuntime(target.adapterType) || target.runtimeId) && await agentRuntimeAvailable({ companyId, runtimeId: target.runtimeId, adapterType: target.adapterType }, cache)) eligible.push(target);
  const available = eligible.filter(target => !target.isBusy);
  return { ...structure, role, targets, eligible, available, delegationRequired: role === 'ceo' || (role === 'department_head' && targets.length > 0) };
}

export function structuralTargetContext(assignment: Awaited<ReturnType<typeof structuralAssignment>>): string {
  return [
    'Structural delegation roster (membership and current availability are separate):',
    ...assignment.targets.map(agent => `${agent.slug}: ${agent.name}; department ${assignment.divisions.find(d => d.id === agent.departmentId)?.name ?? 'unassigned'}; ${agent.isActive === false ? 'paused' : !assignment.eligible.some(a => a.id === agent.id) ? 'runtime unavailable' : agent.isBusy ? 'busy' : 'available'}; ${assignment.divisions.find(d => d.id === agent.departmentId)?.description ?? ''}`),
    'Busy members still exist. This is temporary capacity, not missing organization or permission. Wait for existing work to finish; never request organization setup or execute around mandatory delegation because a member is busy.',
  ].join('\n');
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
