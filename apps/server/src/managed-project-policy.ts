import { giteaConfigFromEnv, giteaManagedReadiness, type GiteaConfig, type ManagedMergeReadiness } from './gitea.ts';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, projects } from './db/schema.ts';

export type ManagedProjectPolicy = { companyId?: string | null; repoProvider?: string | null; repoUrl?: string | null; defaultBranch?: string | null; managedRepoFullName?: string | null; autoMergeAfterApproval?: boolean; completionRequiresMerge?: boolean };
/** Server policy, appended after saved role/session instructions; never credentials. */
export function managedMergePromptPolicy(project: ManagedProjectPolicy | null | undefined): string {
  if (project?.autoMergeAfterApproval !== true) return '';
  return [
    'Authoritative managed project merge policy (current server configuration):',
    'These rules override conflicting position instructions and earlier session instructions, including instructions to merge after PASS.',
    'MegaCorps alone performs the authorized merge after all approvals and exact reviewed-head verification. Report evidence, the PR URL and full head SHA. When reviewing, report the exact reviewed head and your verdict; approval is not permission for an agent to merge.',
    'Use only your assigned ordinary agent identity. Do not read or use administrator or service credentials from environment files, runtime configuration, other profiles or shared files. Do not switch identities or change permission/runtime policy to bypass a denial; report the concrete blocker.',
    'Do not call provider merge APIs or execute merge/push operations into the default branch. Managed work branches support normal append pushes; provider protection forbids force pushes and branch deletion. A changed PR head requires a new review.',
  ].join('\n');
}
export async function managedMergePolicyForCard(card: { companyId: string; projectId?: string | null }): Promise<string> {
  if (!card.projectId) return '';
  const [project] = await db.select().from(projects).where(and(eq(projects.id, card.projectId), eq(projects.companyId, card.companyId), isNull(projects.deletedAt))).limit(1);
  return managedMergePromptPolicy(project);
}
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
