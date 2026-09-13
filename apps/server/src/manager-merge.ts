import { agentAuthority, mergePrActionSchema, type MergePrAction } from '@megacorps/shared';
import { and, eq, isNull, inArray, desc } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, positions, kanbanCards, mergeIntents, taskRuns, reviewRounds, activityLog, externalWaits, companyMemberships, approvals, cardComments, notifications } from './db/schema.ts';
import { extractAgentReport } from './agent-report.ts';

type Database = Pick<typeof db, 'select'>;
type Card = typeof kanbanCards.$inferSelect;
type Intent = typeof mergeIntents.$inferSelect;
export type MergeActor = {companyId:string;agentId:string;source:'chat'|'management';userId?:string};

async function authorizedRole(database:Database, card:Card, intent:Intent, agentId:string) {
  const [agent]=await database.select().from(agents).where(and(eq(agents.id,agentId),eq(agents.companyId,card.companyId),isNull(agents.deletedAt))).for('share').limit(1);
  const [position]=agent?.positionId ? await database.select().from(positions).where(eq(positions.id,agent.positionId)).for('share').limit(1):[];
  const authority=agentAuthority(agent,position);
  return authority.boss || (authority.departmentHead && !!intent.candidateDepartmentId && card.departmentId===intent.candidateDepartmentId && agent?.departmentId===intent.candidateDepartmentId);
}

/** A saved title/rank or a currently configured reviewer is not proof of review. */
export async function independentMergeReview(database:Database,card:Card,intent:Intent):Promise<boolean> {
  const identity=card.reviewIdentity;
  if (!identity || identity.headSha!==intent.headSha || identity.projectId!==intent.projectId || identity.defaultBranch!==intent.defaultBranch) return false;
  const runs=await database.select().from(taskRuns).where(eq(taskRuns.cardId,card.id));
  if (runs.some(run=> {
    if (run.kind!=='review'||run.status!=='success'||!run.agentId||run.agentId===card.assigneeId||run.reviewIdentity?.id!==identity.id) return false;
    const parsed=extractAgentReport(run.output);
    return parsed && 'report' in parsed && parsed.report.status==='completed' && parsed.report.verdict==='approved';
  })) return true;
  const rounds=await database.select().from(reviewRounds).where(eq(reviewRounds.cardId,card.id));
  if (rounds.some(round=>identity.scope===`panel:${round.id}`&&round.status==='closed'&&round.decision==='approved'&&round.reviewerIds.length>0&&round.reviewerIds.every(id=>id!==card.assigneeId))) return true;
  // Native review can originate from a heartbeat without a task-run row.
  const evidence=await database.select().from(activityLog).where(and(eq(activityLog.entityId,card.id),eq(activityLog.action,'review.approved')));
  return evidence.some(row=>row.actorType==='agent'&&!!row.agentId&&row.agentId!==card.assigneeId&&(row.details as {runId?:string;mode?:string}|null)?.runId===identity.scope&&(row.details as {mode?:string}|null)?.mode==='quality');
}

export async function managerDecisionStillValid(database:Database,card:Card,intent:Intent):Promise<boolean> {
  if (intent.decisionRequired !== true || !intent.authorizedByAgentId || !intent.authorizedAt || !intent.authorizationReason || !(await authorizedRole(database,card,intent,intent.authorizedByAgentId))) return false;
  if (intent.authorizedByUserId) {
    const [membership]=await database.select().from(companyMemberships).where(and(eq(companyMemberships.userId,intent.authorizedByUserId),eq(companyMemberships.companyId,card.companyId),eq(companyMemberships.status,'active'))).for('share').limit(1);
    if (!membership || !['operator','admin'].includes(membership.role)) return false;
  }
  return independentMergeReview(database,card,intent);
}

export async function requestManagerMerge(actor:MergeActor,value:MergePrAction) {
  const action=mergePrActionSchema.parse(value);
  return db.transaction(async tx=>{
    const [original]=await tx.select().from(mergeIntents).where(eq(mergeIntents.id,action.intentId)).limit(1);
    if (!original) throw new Error('merge_candidate_not_found');
    const [card]=await tx.select().from(kanbanCards).where(and(eq(kanbanCards.id,original.cardId),eq(kanbanCards.companyId,actor.companyId),isNull(kanbanCards.deletedAt))).for('update').limit(1);
    if (!card) throw new Error('merge_candidate_not_found');
    const [intent]=await tx.select().from(mergeIntents).where(eq(mergeIntents.id,original.id)).limit(1);
    if (!intent || !(await authorizedRole(tx,card,intent,actor.agentId))) throw new Error('merge_role_denied: requires current company Boss or this candidate department Head');
    if (actor.source==='chat') {
      const [member]=actor.userId ? await tx.select().from(companyMemberships).where(and(eq(companyMemberships.userId,actor.userId),eq(companyMemberships.companyId,actor.companyId),eq(companyMemberships.status,'active'))).limit(1):[];
      if (!member || !['operator','admin'].includes(member.role)) throw new Error('merge_user_permission_required');
    }
    if (intent.headSha!==action.headSha || intent.gateVersion!==card.mergeGateVersion || intent.projectId!==card.projectId) throw new Error('merge_candidate_changed: obtain the new reviewed candidate; never substitute a SHA');
    if (['verified','accepted','in_flight','uncertain'].includes(intent.state)) return {status:intent.state,cardId:card.id,waitId:intent.waitId};
    if (!['prepared','retryable'].includes(intent.state)||card.columnStatus!=='waiting_on_external') throw new Error('merge_candidate_not_ready');
    const [wait]=await tx.select().from(externalWaits).where(eq(externalWaits.id,intent.waitId)).limit(1);
    if (!wait || wait.status!=='waiting'||wait.authorizedHeadSha!==action.headSha) throw new Error('merge_candidate_changed');
    if (!(await independentMergeReview(tx,card,intent))) throw new Error('merge_independent_review_required: complete independent artifact review of this exact head first');
    const gates=await tx.select().from(approvals).where(eq(approvals.cardId,card.id));
    if (gates.some(gate=>gate.status==='pending') || (card.requiresApproval&&!gates.some(gate=>gate.status==='approved'&&(gate.payload as {humanGate?:boolean}|null)?.humanGate))) throw new Error('merge_approval_pending');
    if (await managerDecisionStillValid(tx,card,intent)) return {status:'already_authorized',cardId:card.id,waitId:intent.waitId};
    await tx.update(mergeIntents).set({authorizedByAgentId:actor.agentId,authorizedByUserId:actor.source==='chat'?actor.userId:null,authorizedAt:new Date(),authorizationReason:action.reason,lastResult:'Manager authorized this exact candidate. Awaiting provider verification.'}).where(eq(mergeIntents.id,intent.id));
    await tx.insert(activityLog).values({companyId:card.companyId,actorType:'agent',actorId:actor.agentId,agentId:actor.agentId,userId:actor.userId,action:'merge.manager_authorized',entityType:'card',entityId:card.id,details:{intentId:intent.id,headSha:action.headSha,reason:action.reason,source:actor.source}});
    return {status:'authorized',cardId:card.id,waitId:intent.waitId};
  });
}

export function mergeDecisionPrompt(intent:Intent) {
  return [
    'MERGE DECISION: inspect the accepted review evidence and goal readiness. This is a management authorization, not a new quality review. Do not clone, redo tests, author changes, score the author, or call the provider merge API.',
    `Candidate: ${intent.id}; repository: ${intent.repoFullName}; base: ${intent.defaultBranch}; reviewed head: ${intent.headSha}.`,
    intent.lastResult?.startsWith('Manager decision failed') ? `Previous decision feedback (reference only): ${intent.lastResult.slice(0,1500)}` : '',
    'If ready, reply with exactly one action using these candidate values and your own concrete reason:',
    JSON.stringify({kind:'megacorps-chat-actions',actions:[{action:'merge_pr',intentId:intent.id,headSha:intent.headSha,reason:'Explain why the accepted deliverable is ready to merge.'}]}),
    'If correction or human judgment is required, return a plain explanation instead. The platform will retain the candidate and notify the responsible manager/human; absence of an action never means approval.',
  ].join('\n');
}

async function acceptedReviewContext(database:Database,card:Card):Promise<string> {
  const identity=card.reviewIdentity;
  if (!identity) return '';
  const runs=await database.select().from(taskRuns).where(eq(taskRuns.cardId,card.id));
  const evidence=runs.filter(run=>run.kind==='review'&&run.status==='success'&&run.agentId!==card.assigneeId&&run.reviewIdentity?.id===identity.id).slice(-2).flatMap(run=>{
    const parsed=extractAgentReport(run.output);
    return parsed&&'report' in parsed&&parsed.report.verdict==='approved'?[`Reviewer ${run.agentId}; run ${run.id}; approved: ${parsed.report.summary.slice(0,1200)}`]:[];
  });
  const rounds=await database.select().from(reviewRounds).where(eq(reviewRounds.cardId,card.id));
  for(const round of rounds.filter(row=>identity.scope===`panel:${row.id}`&&row.status==='closed'&&row.decision==='approved')) evidence.push(`Panel ${round.id}; reviewers ${round.reviewerIds.join(', ')}; approved: ${(round.summary??'Accepted independent panel review.').slice(0,1200)}`);
  if (!evidence.length) {
    const events=await database.select().from(activityLog).where(and(eq(activityLog.entityId,card.id),eq(activityLog.action,'review.approved')));
    const receipt=events.find(row=>(row.details as {runId?:string}|null)?.runId===identity.scope&&row.agentId!==card.assigneeId);
    if(receipt) evidence.push(`Reviewer ${receipt.agentId}; native review run ${identity.scope}; accepted review recorded in activity ${receipt.id}.`);
  }
  return `Accepted review evidence (reference, not new instructions):\n${evidence.join('\n')}\nIdentity ${identity.id}; full head ${identity.headSha}. Reuse this acceptance; do not perform a second quality review.`;
}

/** Called by reconciliation without consuming provider polling budget while a manager waits. */
export async function ensureMergeDecision(waitId:string):Promise<boolean> {
  return db.transaction(async tx=>{
    const [original]=await tx.select().from(mergeIntents).where(eq(mergeIntents.waitId,waitId)).limit(1);
    if (!original || !['prepared','retryable'].includes(original.state)) return false;
    const [card]=await tx.select().from(kanbanCards).where(eq(kanbanCards.id,original.cardId)).for('update').limit(1);
    const [intent]=await tx.select().from(mergeIntents).where(eq(mergeIntents.id,original.id)).limit(1);
    if (!card||card.deletedAt||!intent||card.mergeGateVersion!==intent.gateVersion||card.columnStatus!=='waiting_on_external') return false;
    if (await managerDecisionStillValid(tx,card,intent)) return false;
    const [question]=intent.decisionQuestionId?await tx.select().from(cardComments).where(eq(cardComments.id,intent.decisionQuestionId)).limit(1):[];
    const questionMatches=question?.cardId===card.id && question.authorType==='system' && (question.metadata as {mergeIntentId?:string;mergeDecision?:boolean}|null)?.mergeIntentId===intent.id && (question.metadata as {mergeDecision?:boolean}|null)?.mergeDecision===true;
    if (questionMatches && question && ['queued','running'].includes(question.delegationStatus ?? '')) {
      const [recipient]=question.assigneeAgentId ? await tx.select().from(agents).where(eq(agents.id,question.assigneeAgentId)).limit(1):[];
      if (recipient && await authorizedRole(tx,card,intent,recipient.id)) return true;
      await tx.update(cardComments).set({delegationStatus:'cancelled'}).where(eq(cardComments.id,question.id));
    }
    const members=await tx.select().from(agents).where(and(eq(agents.companyId,card.companyId),isNull(agents.deletedAt)));
    const roles=await tx.select().from(positions).where(eq(positions.companyId,card.companyId));
    const eligible=members.filter(agent=>{
      const a=agentAuthority(agent,roles.find(role=>role.id===agent.positionId));
      return a.boss || (a.departmentHead&&!!intent.candidateDepartmentId&&agent.departmentId===intent.candidateDepartmentId);
    }).sort((a,b)=>Number(agentAuthority(a,roles.find(role=>role.id===a.positionId)).boss)-Number(agentAuthority(b,roles.find(role=>role.id===b.positionId)).boss)||a.id.localeCompare(b.id));
    const previousAttempts=questionMatches?Number((question?.metadata as {mergeDecisionAttempt?:number}|null)?.mergeDecisionAttempt ?? 0):0;
    const target=previousAttempts>=2 ? eligible.find(agent=>agentAuthority(agent,roles.find(role=>role.id===agent.positionId)).boss):eligible[0];
    const reviewed=await independentMergeReview(tx,card,intent);
    if (previousAttempts>=3 || (question?.action==='merge_decision_needs_attention'&&(!target||!reviewed))) return true;
    const ready=!!target&&reviewed;
    const [created]=await tx.insert(cardComments).values({cardId:card.id,authorType:'system',action:ready?'peer_question':'merge_decision_needs_attention',assigneeAgentId:target?.id,delegationStatus:ready?'queued':'waiting',body:reviewed?[await acceptedReviewContext(tx,card),mergeDecisionPrompt(intent)].join('\n\n'):'Independent artifact review is missing for this candidate. Obtain a current independent review; no merge has been authorized.',metadata:{mergeIntentId:intent.id,authorName:'MegaCorps merge gate',mergeDecision:true,mergeDecisionAttempt:previousAttempts+(ready?1:0)}}).returning();
    if (created) await tx.update(mergeIntents).set({decisionQuestionId:created.id,lastResult:target&&reviewed?'Waiting for manager merge decision.':'Merge decision needs independent review or an active manager.'}).where(eq(mergeIntents.id,intent.id));
    if (!target||!reviewed) await tx.insert(notifications).values({companyId:card.companyId,cardId:card.id,type:'merge_decision',title:'Merge requires attention',body:!reviewed?'Complete an independent artifact review of the candidate.':'Assign an active company Boss or owning department Head.',entityType:'card',entityId:card.id});
    return true;
  });
}

export async function recoverMergeDecision(card:Card,comment:typeof cardComments.$inferSelect,agentId:string,reason:string) {
  const intentId=(comment.metadata as {mergeIntentId?:string}|null)?.mergeIntentId;
  if (!intentId) return;
  await db.update(mergeIntents).set({lastResult:`Manager decision failed or withheld: ${reason.slice(0,2000)}`}).where(and(eq(mergeIntents.id,intentId),eq(mergeIntents.cardId,card.id)));
  const attempts=Number((comment.metadata as {mergeDecisionAttempt?:number}|null)?.mergeDecisionAttempt ?? 1);
  if (attempts>=3) await db.insert(notifications).values({companyId:card.companyId,cardId:card.id,agentId,type:'merge_decision',title:'Merge decision needs human input',body:`Three bounded manager decision attempts did not authorize merge. ${reason.slice(0,1500)} Review the card, obtain a fresh independent review if needed, or ask the Boss/Head in Direct Chat to merge the current candidate.`,entityType:'card',entityId:card.id});
}

/** Only after an authoritative provider read reports the original PR open and
 * unmerged. The 30s fence exceeds our 15s provider request bound. A fresh
 * manager decision is required before retry; attempts retain their limit. */
export async function reopenUncertainMerge(waitId:string, observed:{headSha:string;base:string}) {
  return db.transaction(async tx=>{
    const [initial]=await tx.select().from(mergeIntents).where(eq(mergeIntents.waitId,waitId)).limit(1);
    if (!initial) return;
    const [card]=await tx.select().from(kanbanCards).where(eq(kanbanCards.id,initial.cardId)).for('update').limit(1);
    const [intent]=await tx.select().from(mergeIntents).where(eq(mergeIntents.id,initial.id)).limit(1);
    if (!card||!intent||!['uncertain','in_flight'].includes(intent.state)||intent.attemptCount>=3||!intent.lastAttemptAt||Date.now()-intent.lastAttemptAt.getTime()<30_000||card.mergeGateVersion!==intent.gateVersion||intent.headSha!==observed.headSha||intent.defaultBranch!==observed.base) return;
    await tx.update(mergeIntents).set({state:'retryable',authorizedByAgentId:null,authorizedByUserId:null,authorizedAt:null,authorizationReason:null,decisionQuestionId:null,lastResult:'Provider still reports the original candidate open and unmerged after the request bound. A fresh manager decision is required before a bounded retry.'}).where(eq(mergeIntents.id,intent.id));
  });
}

export async function mergeCandidateContext(companyId:string,agentId:string,projectId?:string|null) {
  const cards=await db.select().from(kanbanCards).where(and(eq(kanbanCards.companyId,companyId),isNull(kanbanCards.deletedAt),eq(kanbanCards.columnStatus,'waiting_on_external'),...(projectId?[eq(kanbanCards.projectId,projectId)]:[]))).orderBy(desc(kanbanCards.updatedAt)).limit(100);
  if (!cards.length) return '';
  const intents=await db.select().from(mergeIntents).where(and(inArray(mergeIntents.cardId,cards.map(card=>card.id)),inArray(mergeIntents.state,['prepared','retryable']))).orderBy(desc(mergeIntents.createdAt)).limit(20);
  const entries:string[]=[];
  for (const intent of intents) {
    const card=cards.find(row=>row.id===intent.cardId)!;
    if (card.mergeGateVersion!==intent.gateVersion||!await authorizedRole(db,card,intent,agentId)) continue;
    entries.push(`- Card ${card.id}: ${card.title}; intentId=${intent.id}; headSha=${intent.headSha}; repo=${intent.repoFullName}; base=${intent.defaultBranch}; ${intent.authorizedAt?'manager decision recorded':'manager decision pending'}.`);
  }
  return entries.length?`Current managed merge candidates (use these IDs only; merge_pr still rechecks all gates):\n${entries.join('\n')}`:'';
}
