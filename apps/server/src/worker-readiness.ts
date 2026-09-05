import { and, eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, projects } from './db/schema.ts';
import { giteaConfigFromEnv, giteaWorkerWriteReadiness } from './gitea.ts';
import { structuralAssignment } from './company-workflow.ts';

export async function workerRepositoryReadiness(companyId: string, agentId?: string | null, projectId?: string | null) {
  const result = { status: 'not_required' as 'not_required' | 'not_checked' | 'ready' | 'blocked', issues: [] as string[] };
  if (!projectId || !agentId) return result;
  const [[project], [agent]] = await Promise.all([
    db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, companyId))).limit(1),
    db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).limit(1),
  ]);
  if (!project || !agent) return { status: 'blocked' as const, issues: ['Choose a same-company project and worker.'] };
  if ((await structuralAssignment(companyId, agentId)).delegationRequired || !project.repoUrl) return result;
  if (project.repoProvider !== 'gitea-local') return { status: 'not_checked' as const, issues: ['External repository write capability must be confirmed by the authorized runtime; server merge readiness is a separate check.'] };
  const config = giteaConfigFromEnv();
  let slug: string[] = [];
  try {
    const url = new URL(project.repoUrl);
    if (config && [config.apiUrl, config.internalUrl, config.externalUrl].some(alias => new URL(alias).origin === url.origin)) slug = url.pathname.replace(/^\/+|\.git$|\/+$/g, '').split('/');
  } catch { /* actionable result below */ }
  if (!config || slug.length !== 2) return { status: 'blocked' as const, issues: ['Configure the authoritative Gitea provider and project repository before checking worker write access.'] };
  const access = await giteaWorkerWriteReadiness(config, slug[0]!, slug[1]!, { username: agent.giteaUsername, token: agent.giteaToken });
  return { status: access.ready ? 'ready' as const : 'blocked' as const, issues: access.issues };
}
