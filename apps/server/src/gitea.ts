import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, appSettings } from './db/schema.ts';

// Built-in Gitea integration. MegaCorps administers the bundled Gitea: it
// creates one org per company, one repo per gitea-local project, and one
// account per agent (so commits carry the real agent identity). Everything
// no-ops cleanly when GITEA_URL is unset, so deployments without the bundled
// service keep working.

export type GiteaConfig = {
  // Where the MegaCorps server reaches Gitea (compose-internal).
  apiUrl: string;
  // Where agents/runtimes clone (compose DNS / internal network).
  internalUrl: string;
  // Where browsers and the UI display/htmlUrl Gitea.
  externalUrl: string;
  adminToken?: string;
  adminUsername?: string;
  adminPassword?: string;
};

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function stripApiPrefix(url: string): string {
  return stripTrailingSlash(url).replace(/\/api\/v1$/i, '');
}

export function giteaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GiteaConfig | null {
  const apiUrl = env.GITEA_URL?.trim();
  if (!apiUrl) return null;
  const strippedApi = stripApiPrefix(apiUrl);
  return {
    apiUrl: strippedApi,
    internalUrl: stripTrailingSlash(env.GITEA_INTERNAL_URL?.trim() || strippedApi),
    externalUrl: stripTrailingSlash(env.GITEA_EXTERNAL_URL?.trim() || apiUrl),
    adminToken: env.GITEA_ADMIN_TOKEN?.trim() || undefined,
    adminUsername: env.GITEA_ADMIN_USERNAME?.trim() || undefined,
    adminPassword: env.GITEA_ADMIN_PASSWORD?.trim() || undefined,
  };
}

export function giteaRequestUrl(config: GiteaConfig, path: string): string {
  const prefix = path.startsWith('/') ? path : `/${path}`;
  return `${stripApiPrefix(config.apiUrl)}/api/v1${prefix}`;
}

export function giteaConfigured(): boolean {
  return Boolean(giteaConfigFromEnv());
}

function adminAuthHeader(config: GiteaConfig): string {
  if (config.adminToken) return `token ${config.adminToken}`;
  if (config.adminUsername && config.adminPassword) {
    return `Basic ${Buffer.from(`${config.adminUsername}:${config.adminPassword}`).toString('base64')}`;
  }
  throw new Error('gitea_admin_credentials_missing: set GITEA_ADMIN_TOKEN or GITEA_ADMIN_USERNAME/GITEA_ADMIN_PASSWORD');
}

type GiteaFetchOptions = { method?: string; body?: unknown; allow?: number[]; fetchImpl?: typeof fetch; auth?: 'admin' | 'basic' };

function basicAuthHeader(config: GiteaConfig): string {
  if (!config.adminUsername || !config.adminPassword) {
    throw new Error('gitea_admin_credentials_missing: Gitea 1.22 token creation requires GITEA_ADMIN_USERNAME/GITEA_ADMIN_PASSWORD (Basic auth)');
  }
  return `Basic ${Buffer.from(`${config.adminUsername}:${config.adminPassword}`).toString('base64')}`;
}

async function giteaFetch(config: GiteaConfig, path: string, options: GiteaFetchOptions = {}): Promise<{ status: number; json: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = giteaRequestUrl(config, path);
  const authorization = options.auth === 'basic' ? basicAuthHeader(config) : adminAuthHeader(config);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        authorization,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown fetch error';
    throw new Error(`gitea_unreachable: ${options.method ?? 'GET'} ${url} failed: ${detail}`);
  }
  const allowed = options.allow ?? [];
  if (!response.ok && !allowed.includes(response.status)) {
    const text = await response.text().catch(() => '');
    throw new Error(`gitea_http_${response.status}: ${options.method ?? 'GET'} ${path} failed${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

export function isGiteaProvisioningRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.startsWith('gitea_unreachable:')) return true;
  if (/\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed)\b/i.test(message)) return true;
  const http = message.match(/^gitea_http_(\d+)/);
  if (!http) return false;
  const status = Number(http[1]);
  return status === 429 || status >= 500;
}

export async function createGiteaAccessToken(config: GiteaConfig, username: string, fetchImpl?: typeof fetch): Promise<string> {
  const tokenName = `megacorps-${createHash('sha256').update(`${username}-${Date.now()}`).digest('hex').slice(0, 12)}`;
  // Gitea 1.22 has POST /api/v1/users/{username}/tokens (Basic + self-or-admin),
  // not /admin/users/{username}/tokens. Token minting also rejects access-token auth.
  const created = await giteaFetch(config, `/users/${username}/tokens`, {
    method: 'POST',
    body: { name: tokenName, scopes: ['write:repository', 'read:user'] },
    fetchImpl,
    auth: 'basic',
  });
  const token = (created.json as { sha1?: string; token?: string } | null)?.sha1
    ?? (created.json as { sha1?: string; token?: string } | null)?.token;
  if (!token) throw new Error('gitea_token_create_failed: Gitea did not return a token value');
  return token;
}

export async function ensureGiteaWebhookToken(): Promise<string> {
  const key = 'gitea.webhook_token';
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (row?.value) return row.value;
  const generated = randomBytes(24).toString('base64url');
  await db.insert(appSettings).values({ key, value: generated }).onConflictDoNothing();
  const [after] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return after?.value ?? generated;
}

export function giteaSlug(value: string): string {
  // Gitea usernames/org/repo names: alphanumeric, dash, dot, underscore.
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'x';
}

export function giteaAgentUsername(agentSlug: string): string {
  return `agent-${giteaSlug(agentSlug)}`;
}

export function giteaCloneUrl(baseUrl: string, orgSlug: string, repoSlug: string): string {
  return `${stripTrailingSlash(baseUrl)}/${orgSlug}/${repoSlug}.git`;
}

export function giteaRepoFromUrl(repoUrl: string): { orgSlug: string; repoSlug: string } | null {
  try {
    const segments = new URL(repoUrl.trim()).pathname.replace(/\.git$/i, '').split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const [org, repo] = segments.slice(-2);
    if (!org || !repo) return null;
    return { orgSlug: giteaSlug(org), repoSlug: giteaSlug(repo) };
  } catch {
    return null;
  }
}

function rewriteUrlOrigin(url: string, fromBase: string, toBase: string): string {
  const from = stripTrailingSlash(fromBase);
  const to = stripTrailingSlash(toBase);
  if (!from || from === to) return url;
  if (url === from || url.startsWith(`${from}/`)) return `${to}${url.slice(from.length)}`;
  return url;
}

// Rewrite a stored (UI/external) clone URL onto the agent-reachable origin.
export function giteaCloneUrlForAgent(storedCloneUrl: string, config: GiteaConfig | null): string {
  if (!config) return storedCloneUrl;
  const fromExternal = rewriteUrlOrigin(storedCloneUrl, config.externalUrl, config.internalUrl);
  if (fromExternal !== storedCloneUrl) return fromExternal;
  return rewriteUrlOrigin(storedCloneUrl, config.apiUrl, config.internalUrl);
}

export function giteaWebhookCallbackUrl(env: NodeJS.ProcessEnv = process.env, token: string): string {
  const base = stripTrailingSlash(
    env.INTERNAL_API_URL?.trim()
    || env.MEGACORPS_API_URL?.trim()
    || env.MEGACORPS_PUBLIC_URL?.trim()
    || 'http://server:4000',
  );
  return `${base}/api/gitea/events?token=${token}`;
}

// Credential-embedded clone URL for prompts. Prompt logging redacts the
// credential pair on write (see redactPromptForLog).
export function giteaAuthenticatedCloneUrl(cloneUrl: string, username: string, token: string): string {
  return cloneUrl.replace(/^(https?:\/\/)/, `$1${encodeURIComponent(username)}:${encodeURIComponent(token)}@`);
}

export async function ensureGiteaOrg(config: GiteaConfig, company: { name: string; slug: string }, fetchImpl?: typeof fetch): Promise<string> {
  const orgSlug = giteaSlug(company.slug);
  const existing = await giteaFetch(config, `/orgs/${orgSlug}`, { allow: [404], fetchImpl });
  if (existing.status === 404) {
    await giteaFetch(config, '/orgs', { method: 'POST', body: { username: orgSlug, full_name: company.name, visibility: 'private' }, allow: [422], fetchImpl });
  }
  return orgSlug;
}

export async function ensureGiteaRepo(config: GiteaConfig, orgSlug: string, project: { name: string }, options?: { defaultBranch?: string; fetchImpl?: typeof fetch; repoSlug?: string; ensureOrgWhenMissing?: boolean }): Promise<{ repoSlug: string; cloneUrl: string; htmlUrl: string }> {
  const repoSlug = options?.repoSlug ?? giteaSlug(project.name);
  const existing = await giteaFetch(config, `/repos/${orgSlug}/${repoSlug}`, { allow: [404], fetchImpl: options?.fetchImpl });
  if (existing.status === 404) {
    if (options?.ensureOrgWhenMissing) {
      await ensureGiteaOrg(config, { name: orgSlug, slug: orgSlug }, options.fetchImpl);
    }
    await giteaFetch(config, `/orgs/${orgSlug}/repos`, {
      method: 'POST',
      body: { name: repoSlug, private: true, auto_init: true, default_branch: options?.defaultBranch ?? 'main' },
      allow: [409, 422],
      fetchImpl: options?.fetchImpl,
    });
  }
  return {
    repoSlug,
    // Stored/UI clone + html URLs stay on the browser-facing origin.
    cloneUrl: giteaCloneUrl(config.externalUrl, orgSlug, repoSlug),
    htmlUrl: `${config.externalUrl}/${orgSlug}/${repoSlug}`,
  };
}

export async function ensureGiteaAgentAccount(config: GiteaConfig, agent: { id: string; slug: string; name: string }, fetchImpl?: typeof fetch): Promise<{ username: string; token: string }> {
  const [row] = await db.select({ giteaUsername: agents.giteaUsername, giteaToken: agents.giteaToken }).from(agents).where(eq(agents.id, agent.id)).limit(1);
  if (row?.giteaUsername && row.giteaToken) return { username: row.giteaUsername, token: row.giteaToken };

  const username = giteaAgentUsername(agent.slug);
  const password = randomBytes(24).toString('base64url');
  const existing = await giteaFetch(config, `/users/${username}`, { allow: [404], fetchImpl });
  if (existing.status === 404) {
    await giteaFetch(config, '/admin/users', {
      method: 'POST',
      body: {
        username,
        email: `${username}@megacorps.local`,
        password,
        full_name: agent.name,
        must_change_password: false,
        visibility: 'private',
      },
      allow: [422],
      fetchImpl,
    });
  }
  // A fresh token every provisioning pass: tokens cannot be read back from
  // Gitea, so losing the DB copy means re-issuing, and the name must be unique.
  const token = await createGiteaAccessToken(config, username, fetchImpl);
  await db.update(agents).set({ giteaUsername: username, giteaToken: token }).where(eq(agents.id, agent.id));
  return { username, token };
}

export async function addGiteaCollaborator(config: GiteaConfig, orgSlug: string, repoSlug: string, username: string, fetchImpl?: typeof fetch): Promise<void> {
  await giteaFetch(config, `/repos/${orgSlug}/${repoSlug}/collaborators/${username}`, {
    method: 'PUT',
    body: { permission: 'write' },
    allow: [204],
    fetchImpl,
  });
}

// Merge closure (§19) needs pull_request events, not just push. An existing
// hook created before that (events: ['push']) is patched in place rather than
// duplicated, so the boot reconcile upgrades every repo on the next start.
export const GITEA_WEBHOOK_EVENTS = ['push', 'pull_request'] as const;

export async function ensureGiteaRepoWebhook(config: GiteaConfig, orgSlug: string, repoSlug: string, targetUrl: string, fetchImpl?: typeof fetch): Promise<void> {
  const hooks = await giteaFetch(config, `/repos/${orgSlug}/${repoSlug}/hooks`, { fetchImpl });
  const list = Array.isArray(hooks.json) ? hooks.json as Array<{ id?: number; events?: string[]; config?: { url?: string } }> : [];
  const existing = list.find((hook) => hook.config?.url === targetUrl);
  if (existing) {
    const events = Array.isArray(existing.events) ? existing.events : [];
    const missing = GITEA_WEBHOOK_EVENTS.filter((event) => !events.includes(event));
    if (missing.length === 0 || existing.id === undefined) return;
    await giteaFetch(config, `/repos/${orgSlug}/${repoSlug}/hooks/${existing.id}`, {
      method: 'PATCH',
      body: { active: true, events: [...new Set([...events, ...GITEA_WEBHOOK_EVENTS])] },
      fetchImpl,
    });
    return;
  }
  await giteaFetch(config, `/repos/${orgSlug}/${repoSlug}/hooks`, {
    method: 'POST',
    body: {
      type: 'gitea',
      active: true,
      events: [...GITEA_WEBHOOK_EVENTS],
      config: { url: targetUrl, content_type: 'json' },
    },
    fetchImpl,
  });
}

export type GiteaPullRequest = {
  number?: number;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  html_url?: string;
  head?: { sha?: string; ref?: string } | null;
  base?: { sha?: string; ref?: string } | null;
};

// Reads one pull request. A missing PR (deleted repo, wrong number) is a null,
// not a throw: the merge gate degrades to "no head" instead of failing review.
export async function giteaPullRequest(config: GiteaConfig, orgSlug: string, repoSlug: string, index: number, fetchImpl?: typeof fetch): Promise<GiteaPullRequest | null> {
  const response = await giteaFetch(config, `/repos/${orgSlug}/${repoSlug}/pulls/${index}`, { allow: [404], fetchImpl });
  if (response.status === 404) return null;
  return (response.json as GiteaPullRequest | null) ?? null;
}

/** Gitea 1.22.6 immediate merge: the provider atomically rejects a changed head. */
export async function giteaMergePullRequest(config: GiteaConfig, org: string, repo: string, index: number, head: string, fetchImpl?: typeof fetch): Promise<number> {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('merge_full_head_required');
  const result = await giteaFetch(config, `/repos/${org}/${repo}/pulls/${index}/merge`, {
    method: 'POST', body: { Do: 'merge', head_commit_id: head, force_merge: false, merge_when_checks_succeed: false, delete_branch_after_merge: false },
    allow: [405, 409, 422], fetchImpl,
  });
  return result.status;
}

export type ManagedMergeReadiness = { ready: boolean; issues: string[]; serviceIdentity?: string; checkedAt: string };
/** Only explicit provisioning/opt-in may establish a rule. Inspection never writes.
 * Existing rules are accepted as-is or rejected, never replaced or weakened.
 */
export async function giteaManagedReadiness(config: GiteaConfig, org: string, repo: string, branch: string, options: { establish?: boolean; fetchImpl?: typeof fetch; agentUsernames?: string[] } = {}): Promise<ManagedMergeReadiness> {
  const result: ManagedMergeReadiness = { ready: false, issues: [], checkedAt: new Date().toISOString() };
  const get = async (path: string) => (await giteaFetch(config, path, { fetchImpl: options.fetchImpl })).json as any;
  const path = `/repos/${org}/${repo}`;
  try {
    const version = await get('/version');
    if (version?.version !== '1.22.6') throw new Error('Verify immediate exact-head merge support for this Gitea version; supported version is 1.22.6.');
    const service = await get('/user');
    if (!service?.login) throw new Error('Server merge credentials must resolve to a service identity.');
    result.serviceIdentity = service.login;
    if (options.agentUsernames?.includes(service.login)) throw new Error('The server merge identity must not be an ordinary agent identity.');
    const permission = await get(`${path}/collaborators/${encodeURIComponent(service.login)}/permission`);
    if (!['write', 'admin', 'owner'].includes(permission?.permission)) throw new Error('Grant the server service identity repository write permission before enabling merge protection.');
    const repository = await get(path);
    if (repository?.default_branch !== branch) throw new Error('Project default branch differs from the provider default branch.');
    for (const username of options.agentUsernames ?? []) {
      const access = await get(`${path}/collaborators/${encodeURIComponent(username)}/permission`);
      if (access.user?.is_admin !== false || !['read', 'write'].includes(access.permission) || username === repository.owner?.login) throw new Error('A company agent has unsafe or unknown effective repository permissions; review its org/team membership and global admin status.');
    }
    for (let page = 1; ; page++) {
      if (page > 20) throw new Error('Collaborator inventory exceeds the verification budget; administrator review is required.');
      const collaborators = await get(`${path}/collaborators?limit=50&page=${page}`);
      if (!Array.isArray(collaborators)) throw new Error('Collaborator inventory is incomplete; verify all collaborator privileges before enabling automation.');
      for (const user of collaborators) {
        if (user.login === service.login) continue;
        const access = await get(`${path}/collaborators/${encodeURIComponent(user.login)}/permission`);
        if (user.is_admin !== false || access.user?.is_admin !== false || !['read', 'write'].includes(access.permission) || user.login === repository.owner?.login) throw new Error('Ordinary collaborators must be verified non-admin/non-owner accounts before enabling automatic merge.');
      }
      if (collaborators.length < 50) break;
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch)) throw new Error('Managed automatic merge supports default branches containing only ASCII letters, digits, underscore, dot, slash and hyphen, starting with a letter, digit or underscore. Keep this repository opted out or explicitly choose a supported branch; existing names and rules were preserved.');
    // Plain exact rules use EqualFold in 1.22.6. A literal character class
    // selects the case-sensitive glob engine while matching only this branch.
    const allowRuleName = `[${branch[0]}]${branch.slice(1)}`;
    const expected = [
      { rule_name: allowRuleName, enable_push: false, enable_merge_whitelist: true, merge_whitelist_usernames: [service.login], merge_whitelist_teams: [], unprotected_file_patterns: '' },
      { rule_name: '**', enable_push: true, enable_push_whitelist: false, enable_merge_whitelist: true, merge_whitelist_usernames: [], merge_whitelist_teams: [], unprotected_file_patterns: '', protected_file_patterns: '' },
    ];
    const inspect = (rules: any): Set<string> => {
      if (!Array.isArray(rules)) throw new Error('Branch protection inventory is unavailable.');
      const names = new Set<string>();
      const created = new Map<string, number>();
      for (const rule of rules) {
        const name = rule.rule_name ?? rule.branch_name;
        if (![allowRuleName, '**'].includes(name) || names.has(name)) throw new Error('Additional, plain exact or overlapping branch protection rules require administrator review: automatic merge needs a case-sensitive literal default glob and the ** nondefault merge-deny fallback. Existing rules were preserved.');
        names.add(name);
        const timestamp = typeof rule.created_at === 'string' ? Date.parse(rule.created_at) : NaN;
        if (!Number.isFinite(timestamp)) throw new Error('Provider protection created_at timestamps are missing or invalid; rule precedence cannot be verified. Existing rules were preserved.');
        created.set(name, Math.floor(timestamp / 1000));
        const users = rule.merge_whitelist_usernames, teams = rule.merge_whitelist_teams;
        if (rule.enable_merge_whitelist !== true || rule.unprotected_file_patterns || !Array.isArray(users) || !Array.isArray(teams) || teams.length !== 0) throw new Error('Branch merge whitelists and file exceptions are unsafe or unknown. Existing rules were preserved; review both managed protection rules.');
        if (name === allowRuleName && (rule.enable_push !== false || users.length !== 1 || users[0] !== service.login)) throw new Error('Default branch must deny direct pushes and allow merges only by the verified server service identity. Existing rules were preserved.');
        if (name === '**' && (rule.enable_push !== true || rule.enable_push_whitelist !== false || users.length !== 0 || rule.protected_file_patterns)) throw new Error('The ** fallback must permit normal work-branch pushes and deny merges to everyone, including the service identity. Existing rules were preserved.');
      }
      if (names.size === 2 && created.get(allowRuleName)! >= created.get('**')!) throw new Error('The case-sensitive default protection must be strictly older than the ** fallback at provider-second precision. Tied or reversed rules require administrator review; existing rules were preserved.');
      return names;
    };
    let names = inspect(await get(`${path}/branch_protections`));
    if (names.size !== 2 && options.establish) {
      if (names.has('**')) throw new Error('The existing ** fallback precedes any new default rule. Administrator review is required; existing rules were preserved.');
      if (!names.has(allowRuleName)) await giteaFetch(config, `${path}/branch_protections`, { method: 'POST', fetchImpl: options.fetchImpl, body: expected[0] });
      // Gitea orders globs by CreatedUnix (seconds), so separate creation even
      // on fast providers. Readback, not this elapsed delay, establishes order.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await giteaFetch(config, `${path}/branch_protections`, { method: 'POST', fetchImpl: options.fetchImpl, body: expected[1] });
      names = inspect(await get(`${path}/branch_protections`));
    }
    // The older literal glob matches only default, with case preserved; **
    // matches every other/nested branch. No plain exact rule may shadow them.
    // Enabled empty merge whitelists reject even repository/global admins.
    if (names.size !== 2) throw new Error('Explicitly retry managed setup to establish the case-sensitive default protection before the ** nondefault merge-deny fallback.');
    result.ready = true;
  } catch (error) {
    // Do not expose provider response text or credentials in setup responses.
    const message = error instanceof Error ? error.message : '';
    result.issues.push(message.startsWith('gitea_') ? 'Gitea policy verification failed; check server credentials and provider availability, then explicitly retry setup.' : message || 'Managed merge readiness could not be verified.');
  }
  return result;
}

/** Resolve a branch, full SHA or legacy short SHA in the authoritative repository. */
export async function giteaResolveCommit(config: GiteaConfig, org: string, repo: string, ref: string, fetchImpl?: typeof fetch): Promise<string | null> {
  const response = await giteaFetch(config, `/repos/${org}/${repo}/git/commits/${encodeURIComponent(ref)}`, { allow: [404, 409], fetchImpl });
  const sha = (response.json as { sha?: string } | null)?.sha?.trim().toLowerCase();
  return response.status === 200 && sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// Containment check for push payloads that do not list the authorized head
// (Gitea truncates long pushes). Compares against the newest commits on the
// branch, which is where a just-merged head always is.
export async function giteaBranchContainsCommit(config: GiteaConfig, orgSlug: string, repoSlug: string, branch: string, sha: string, options?: { limit?: number; fetchImpl?: typeof fetch }): Promise<boolean> {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 100);
  const response = await giteaFetch(config, `/repos/${orgSlug}/${repoSlug}/commits?sha=${encodeURIComponent(branch)}&limit=${limit}`, { allow: [404, 409], fetchImpl: options?.fetchImpl });
  if (response.status !== 200 || !Array.isArray(response.json)) return false;
  const wanted = sha.trim().toLowerCase();
  if (!wanted) return false;
  return (response.json as Array<{ sha?: string }>).some((commit) => {
    const id = (commit.sha ?? '').toLowerCase();
    return /^[0-9a-f]{40}$/.test(wanted) && id === wanted;
  });
}
