import { giteaConfigFromEnv, giteaManagedReadiness, type GiteaConfig, type ManagedMergeReadiness } from './gitea.ts';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents } from './db/schema.ts';

export type ManagedProjectPolicy = { companyId?: string | null; repoProvider?: string | null; repoUrl?: string | null; defaultBranch?: string | null; managedRepoFullName?: string | null; autoMergeAfterApproval?: boolean; completionRequiresMerge?: boolean };
export function managedMergeTarget(project: ManagedProjectPolicy, config: GiteaConfig | null): { org: string; repo: string } | null {
  if (!config || project.repoProvider !== 'gitea-local' || project.autoMergeAfterApproval !== true || project.completionRequiresMerge !== true || !project.managedRepoFullName) return null;
  try {
    const url = new URL(project.repoUrl ?? '');
    if (url.username || url.password || url.search || url.hash || ![config.apiUrl, config.internalUrl, config.externalUrl].some((alias) => new URL(alias).origin === url.origin)) return null;
    const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (path !== project.managedRepoFullName || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(path)) return null;
    const [org, repo] = path.split('/');
    return { org: org!, repo: repo! };
  } catch { return null; }
}
export async function inspectManagedProject(project: ManagedProjectPolicy, options: { establish?: boolean; fetchImpl?: typeof fetch } = {}): Promise<ManagedMergeReadiness> {
  const config = giteaConfigFromEnv();
  const target = managedMergeTarget(project, config);
  if (!target || !config) return { ready: false, issues: ['Enable the merge gate and bind an explicitly managed repository on the configured Gitea before enabling automatic merge.'], checkedAt: new Date().toISOString() };
  const companyAgents = project.companyId ? await db.select().from(agents).where(and(eq(agents.companyId, project.companyId), isNull(agents.deletedAt))) : [];
  if (companyAgents.some((agent) => agent.isActive && !agent.giteaUsername)) return { ready: false, issues: ['Provision every active company agent Gitea identity before verifying protected automatic merge.'], checkedAt: new Date().toISOString() };
  return giteaManagedReadiness(config, target.org, target.repo, project.defaultBranch ?? 'main', { ...options, agentUsernames: companyAgents.map((agent) => agent.giteaUsername).filter((name): name is string => Boolean(name)) });
}
/** Called only by explicit create/update requests, never ordinary inspection. */
export function optInManagedBinding(project: ManagedProjectPolicy): string | null {
  try {
    const path = new URL(project.repoUrl ?? '').pathname.replace(/^\//, '').replace(/\.git$/, '');
    return managedMergeTarget({ ...project, managedRepoFullName: path }, giteaConfigFromEnv()) ? path : null;
  } catch { return null; }
}
