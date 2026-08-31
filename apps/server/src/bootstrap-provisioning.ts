import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { generateAgentToken } from './agent-auth.ts';
import { db } from './db/client.ts';
import { agents, companies, projects } from './db/schema.ts';
import { addGiteaCollaborator, ensureGiteaAgentAccount, ensureGiteaOrg, ensureGiteaRepo, giteaConfigFromEnv } from './gitea.ts';

// Deploy-time reconciliation: identity is not something an operator should
// hand out by hand. Every boot walks the fleet and fills whatever is missing —
// agents created before per-agent tokens existed get one, agents created
// before the bundled Gitea get an account, and gitea-local projects created
// while Gitea was unreachable get their org/repo/collaborators. Everything
// here is idempotent, so running it on every startup is free.

const GITEA_RETRY_ATTEMPTS = 10;
const GITEA_RETRY_DELAY_MS = 15_000;

export async function reconcileAgentApiTokens(app: FastifyInstance): Promise<number> {
  const missing = await db.select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(isNull(agents.apiToken), isNull(agents.deletedAt)));
  for (const agent of missing) {
    await db.update(agents).set({ apiToken: generateAgentToken(), apiTokenUpdatedAt: new Date() }).where(eq(agents.id, agent.id));
  }
  if (missing.length > 0) app.log.info({ count: missing.length }, 'issued MegaCorps API tokens to agents that had none');
  return missing.length;
}

export async function reconcileGiteaProvisioning(app: FastifyInstance): Promise<{ accounts: number; repos: number }> {
  const gitea = giteaConfigFromEnv();
  if (!gitea) return { accounts: 0, repos: 0 };

  const activeAgents = await db.select().from(agents).where(isNull(agents.deletedAt));
  let accounts = 0;
  for (const agent of activeAgents) {
    if (agent.giteaUsername && agent.giteaToken) continue;
    await ensureGiteaAgentAccount(gitea, agent);
    accounts += 1;
  }

  const giteaProjects = await db.select().from(projects)
    .where(and(eq(projects.repoProvider, 'gitea-local'), isNull(projects.deletedAt)));
  let repos = 0;
  const orgByCompany = new Map<string, string>();
  for (const project of giteaProjects) {
    let orgSlug = orgByCompany.get(project.companyId);
    if (!orgSlug) {
      const [company] = await db.select().from(companies).where(eq(companies.id, project.companyId)).limit(1);
      if (!company) continue;
      orgSlug = await ensureGiteaOrg(gitea, company);
      orgByCompany.set(project.companyId, orgSlug);
    }
    const repo = await ensureGiteaRepo(gitea, orgSlug, { name: project.name }, { defaultBranch: project.defaultBranch ?? 'main' });
    // A project created while Gitea was down has no clone URL yet; heal it.
    if (!project.repoUrl) {
      await db.update(projects).set({ repoUrl: repo.cloneUrl, updatedAt: new Date() }).where(eq(projects.id, project.id));
    }
    repos += 1;
    const companyAgents = activeAgents.filter((agent) => agent.companyId === project.companyId);
    for (const agent of companyAgents) {
      const [fresh] = await db.select({ giteaUsername: agents.giteaUsername }).from(agents).where(eq(agents.id, agent.id)).limit(1);
      if (fresh?.giteaUsername) await addGiteaCollaborator(gitea, orgSlug, repo.repoSlug, fresh.giteaUsername);
    }
  }

  if (accounts > 0 || repos > 0) app.log.info({ accounts, repos }, 'reconciled Gitea accounts and repos');
  return { accounts, repos };
}

// Runs once per boot, off the critical path: the API must come up even when
// Gitea is still starting (compose starts them together), so the Gitea half
// retries on a timer instead of blocking listen().
export function startProvisioningSweep(app: FastifyInstance): void {
  if (process.env.PROVISIONING_SWEEP_ENABLED === 'false') return;
  void (async () => {
    try {
      await reconcileAgentApiTokens(app);
    } catch (error) {
      app.log.error({ error }, 'agent API token reconciliation failed');
    }
    if (!giteaConfigFromEnv()) return;
    for (let attempt = 1; attempt <= GITEA_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await reconcileGiteaProvisioning(app);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown Gitea error';
        if (attempt === GITEA_RETRY_ATTEMPTS) {
          app.log.error({ error: message }, 'Gitea provisioning reconciliation gave up; run POST /api/agents/:id/gitea manually or restart the server');
          return;
        }
        app.log.warn({ error: message, attempt }, 'Gitea not ready yet; retrying provisioning reconciliation');
        await new Promise((resolve) => setTimeout(resolve, GITEA_RETRY_DELAY_MS));
      }
    }
  })();
}
