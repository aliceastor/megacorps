#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

type Flags = Record<string, string | boolean>;
type ApiAuth = { session?: string; runnerKey?: string };
type ApiOptions = { apiUrl: string; auth: ApiAuth };
type ManifestRecord = Record<string, unknown>;
type ApiObject = Record<string, unknown> & { id: string };

const DEFAULT_API_URL = 'http://localhost:4000';

function usage(): string {
  return [
    'MegaCorps CLI',
    '',
    'Commands:',
    '  megacorps login --email <email> --password <password> [--api-url <url>]',
    '  megacorps apply -f megacorps.yml [--api-url <url>] [--session <session-cookie-value>]',
    '  megacorps runner register --name <name> --slug <slug> [--company-id <uuid>] [--supported-runtimes mock,codex-app] [--max-concurrent 2] [--workspace-root <path>] [--scratch-root <path>] [--api-url <url>] [--session <session-cookie-value>]',
    '  megacorps runner daemon --runner-key <key> [--workspace-root <path>] [--supported-runtimes mock,codex-app] [--interval-ms 5000] [--scaffold-status needs_review] [--api-url <url>] [--once] [--no-complete]',
    '',
    'Env:',
    '  MEGACORPS_API_URL, MEGACORPS_SESSION, MEGACORPS_RUNNER_KEY, MEGACORPS_RUNNER_WORKSPACE_ROOT',
  ].join('\n');
}

function parseArgs(args: string[]): { command: string[]; flags: Flags } {
  const command: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith('-')) {
      command.push(arg);
      continue;
    }
    const raw = arg.replace(/^-+/, '');
    const [key, inlineValue] = raw.split('=', 2);
    if (!key) continue;
    const next = args[index + 1];
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
    } else if (next && !next.startsWith('-')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function flagString(flags: Flags, key: string, fallback?: string): string | undefined {
  const value = flags[key];
  if (value === undefined || value === false || value === true) return fallback;
  return value;
}

function flagBoolean(flags: Flags, key: string): boolean {
  return flags[key] === true || flags[key] === 'true' || flags[key] === '1';
}

function apiOptions(flags: Flags, runner = false): ApiOptions {
  return {
    apiUrl: (flagString(flags, 'api-url') ?? process.env.MEGACORPS_API_URL ?? DEFAULT_API_URL).replace(/\/$/, ''),
    auth: {
      session: flagString(flags, 'session') ?? process.env.MEGACORPS_SESSION,
      runnerKey: runner ? flagString(flags, 'runner-key') ?? process.env.MEGACORPS_RUNNER_KEY : undefined,
    },
  };
}

async function apiRequest<T>(options: ApiOptions, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  if (options.auth.session) headers.set('Cookie', `session=${options.auth.session}`);
  if (options.auth.runnerKey) headers.set('Authorization', `Bearer ${options.auth.runnerKey}`);
  const response = await fetch(`${options.apiUrl}${path}`, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.error ?? body?.message ?? text ?? `${response.status} ${response.statusText}`;
    throw new Error(`${init.method ?? 'GET'} ${path}: ${message}`);
  }
  return body as T;
}

function required(flags: Flags, key: string): string {
  const value = flagString(flags, key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function records(value: unknown): ManifestRecord[] {
  return Array.isArray(value) ? value.filter((item): item is ManifestRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function keyFor(row: ManifestRecord | ApiObject): string[] {
  return ['id', 'slug', 'name', 'title'].map((key) => text(row[key])).filter((value): value is string => Boolean(value));
}

function indexByKeys(rows: ApiObject[]): Map<string, ApiObject> {
  const map = new Map<string, ApiObject>();
  for (const row of rows) {
    for (const key of keyFor(row)) map.set(key, row);
  }
  return map;
}

function byRef(map: Map<string, ApiObject>, ref: unknown, kind: string): ApiObject {
  const key = text(ref) ?? 'default';
  const row = map.get(key);
  if (!row) throw new Error(`${kind} reference not found: ${key}`);
  return row;
}

function withoutRefs(row: ManifestRecord, refs: string[]): ManifestRecord {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !refs.includes(key) && !key.startsWith('$')));
}

async function login(flags: Flags): Promise<void> {
  const options = apiOptions(flags);
  const response = await fetch(`${options.apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: required(flags, 'email'), password: required(flags, 'password') }),
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`login failed: ${bodyText}`);
  const cookie = response.headers.get('set-cookie') ?? '';
  const session = /(?:^|;\s*)session=([^;]+)/.exec(cookie)?.[1];
  if (!session) throw new Error('login succeeded but no session cookie was returned');
  console.log(session);
}

async function applyManifest(flags: Flags): Promise<void> {
  const file = flagString(flags, 'file') ?? flagString(flags, 'f');
  if (!file) throw new Error('Missing -f/--file');
  const options = apiOptions(flags);
  if (!options.auth.session) throw new Error('MEGACORPS_SESSION or --session is required for apply');
  const manifest = parseYaml(await readFile(file, 'utf8')) as ManifestRecord;
  const defaultCompanyRef = text(manifest.defaultCompany) ?? 'default';
  const companies = indexByKeys(await apiRequest<ApiObject[]>(options, '/api/companies'));

  for (const item of records(manifest.companies)) {
    const existing = keyFor(item).map((key) => companies.get(key)).find(Boolean);
    const payload = withoutRefs(item, []);
    const row = existing
      ? await apiRequest<ApiObject>(options, `/api/companies/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await apiRequest<ApiObject>(options, '/api/companies', { method: 'POST', body: JSON.stringify(payload) });
    for (const key of keyFor(row)) companies.set(key, row);
    console.log(`${existing ? 'updated' : 'created'} company ${row.name ?? row.slug ?? row.id}`);
  }

  if (!companies.has(defaultCompanyRef)) {
    const refreshed = indexByKeys(await apiRequest<ApiObject[]>(options, '/api/companies'));
    for (const [key, row] of refreshed) companies.set(key, row);
  }

  const departmentsByCompany = new Map<string, Map<string, ApiObject>>();
  const positionsByCompany = new Map<string, Map<string, ApiObject>>();
  const agentsByCompany = new Map<string, Map<string, ApiObject>>();
  const projectsByCompany = new Map<string, Map<string, ApiObject>>();
  const goalsByCompany = new Map<string, Map<string, ApiObject>>();
  const cardsByCompany = new Map<string, Map<string, ApiObject>>();

  async function companyScopedIndex(cache: Map<string, Map<string, ApiObject>>, companyId: string, path: string): Promise<Map<string, ApiObject>> {
    const existing = cache.get(companyId);
    if (existing) return existing;
    const rows = await apiRequest<ApiObject[]>(options, `${path}?companyId=${encodeURIComponent(companyId)}`);
    const indexed = indexByKeys(rows);
    cache.set(companyId, indexed);
    return indexed;
  }

  function companyFor(item: ManifestRecord): ApiObject {
    return byRef(companies, item.companyId ?? item.company ?? item.companySlug ?? defaultCompanyRef, 'company');
  }

  for (const item of records(manifest.departments)) {
    const company = companyFor(item);
    const index = await companyScopedIndex(departmentsByCompany, company.id, '/api/departments');
    const existing = keyFor(item).map((key) => index.get(key)).find(Boolean);
    if (existing) {
      console.log(`skipped existing department ${existing.name ?? existing.slug ?? existing.id}`);
      continue;
    }
    const row = await apiRequest<ApiObject>(options, '/api/departments', {
      method: 'POST',
      body: JSON.stringify({ ...withoutRefs(item, ['company', 'companySlug']), companyId: company.id }),
    });
    for (const key of keyFor(row)) index.set(key, row);
    console.log(`created department ${row.name ?? row.slug ?? row.id}`);
  }

  for (const item of records(manifest.positions)) {
    const company = companyFor(item);
    const index = await companyScopedIndex(positionsByCompany, company.id, '/api/positions');
    const existing = keyFor(item).map((key) => index.get(key)).find(Boolean);
    const payload = { ...withoutRefs(item, ['company', 'companySlug']), companyId: company.id };
    const row = existing
      ? await apiRequest<ApiObject>(options, `/api/positions/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await apiRequest<ApiObject>(options, '/api/positions', { method: 'POST', body: JSON.stringify(payload) });
    for (const key of keyFor(row)) index.set(key, row);
    console.log(`${existing ? 'updated' : 'created'} position ${row.name ?? row.slug ?? row.id}`);
  }

  for (const item of records(manifest.projects)) {
    const company = companyFor(item);
    const index = await companyScopedIndex(projectsByCompany, company.id, '/api/projects');
    const existing = keyFor(item).map((key) => index.get(key)).find(Boolean);
    const payload = { ...withoutRefs(item, ['company', 'companySlug']), companyId: company.id };
    const row = existing
      ? await apiRequest<ApiObject>(options, `/api/projects/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await apiRequest<ApiObject>(options, '/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    for (const key of keyFor(row)) index.set(key, row);
    console.log(`${existing ? 'updated' : 'created'} project ${row.name ?? row.id}`);
  }

  for (const item of records(manifest.agents)) {
    const company = companyFor(item);
    const departments = await companyScopedIndex(departmentsByCompany, company.id, '/api/departments');
    const positions = await companyScopedIndex(positionsByCompany, company.id, '/api/positions');
    const agents = await companyScopedIndex(agentsByCompany, company.id, '/api/agents');
    const existing = keyFor(item).map((key) => agents.get(key)).find(Boolean);
    const department = item.department ? byRef(departments, item.department, 'department') : null;
    const position = item.position ? byRef(positions, item.position, 'position') : null;
    const boss = item.boss ? byRef(agents, item.boss, 'agent') : null;
    const payload = {
      ...withoutRefs(item, ['company', 'companySlug', 'department', 'position', 'boss']),
      companyId: company.id,
      departmentId: department?.id ?? item.departmentId,
      positionId: position?.id ?? item.positionId,
      bossId: boss?.id ?? item.bossId,
    };
    const row = existing
      ? await apiRequest<ApiObject>(options, `/api/agents/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await apiRequest<ApiObject>(options, '/api/agents', { method: 'POST', body: JSON.stringify(payload) });
    for (const key of keyFor(row)) agents.set(key, row);
    console.log(`${existing ? 'updated' : 'created'} agent ${row.name ?? row.slug ?? row.id}`);
  }

  for (const item of records(manifest.goals)) {
    const company = companyFor(item);
    const goals = await companyScopedIndex(goalsByCompany, company.id, '/api/goals');
    const existing = keyFor(item).map((key) => goals.get(key)).find(Boolean);
    if (existing) {
      console.log(`skipped existing goal ${existing.title ?? existing.id}`);
      continue;
    }
    const departments = await companyScopedIndex(departmentsByCompany, company.id, '/api/departments');
    const projects = await companyScopedIndex(projectsByCompany, company.id, '/api/projects');
    const department = item.department ? byRef(departments, item.department, 'department') : null;
    const project = item.project ? byRef(projects, item.project, 'project') : null;
    const row = await apiRequest<ApiObject>(options, '/api/goals', {
      method: 'POST',
      body: JSON.stringify({ ...withoutRefs(item, ['company', 'companySlug', 'department', 'project']), companyId: company.id, departmentId: department?.id ?? item.departmentId, projectId: project?.id ?? item.projectId }),
    });
    for (const key of keyFor(row)) goals.set(key, row);
    console.log(`created goal ${row.title ?? row.id}`);
  }

  const pendingCardDependencies: Array<{ companyId: string; card: ApiObject; refs: string[] }> = [];
  for (const item of records(manifest.cards)) {
    const company = companyFor(item);
    const cards = await companyScopedIndex(cardsByCompany, company.id, '/api/cards');
    const existing = keyFor(item).map((key) => cards.get(key)).find(Boolean);
    const departments = await companyScopedIndex(departmentsByCompany, company.id, '/api/departments');
    const projects = await companyScopedIndex(projectsByCompany, company.id, '/api/projects');
    const agents = await companyScopedIndex(agentsByCompany, company.id, '/api/agents');
    const goals = await companyScopedIndex(goalsByCompany, company.id, '/api/goals');
    const department = item.department ? byRef(departments, item.department, 'department') : null;
    const project = item.project ? byRef(projects, item.project, 'project') : null;
    const goal = item.goal ? byRef(goals, item.goal, 'goal') : null;
    const assignee = item.assignee ? byRef(agents, item.assignee, 'agent') : null;
    const reviewer = item.reviewer ? byRef(agents, item.reviewer, 'agent') : null;
    const dependencyRefs = item.dependencies !== undefined || item.dependencyCardIds !== undefined
      ? list(item.dependencies ?? item.dependencyCardIds)
      : null;
    const payload = {
      ...withoutRefs(item, ['company', 'companySlug', 'department', 'project', 'goal', 'assignee', 'reviewer', 'dependencies', 'dependencyCardIds']),
      companyId: company.id,
      departmentId: department?.id ?? item.departmentId,
      projectId: project?.id ?? item.projectId,
      goalId: goal?.id ?? item.goalId,
      assigneeId: assignee?.id ?? item.assigneeId,
      reviewerId: reviewer?.id ?? item.reviewerId,
    };
    const row = existing
      ? await apiRequest<ApiObject>(options, `/api/cards/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await apiRequest<ApiObject>(options, '/api/cards', { method: 'POST', body: JSON.stringify(payload) });
    for (const key of keyFor(row)) cards.set(key, row);
    if (dependencyRefs) pendingCardDependencies.push({ companyId: company.id, card: row, refs: dependencyRefs });
    console.log(`${existing ? 'updated' : 'created'} card ${row.title ?? row.id}`);
  }

  for (const pending of pendingCardDependencies) {
    const cards = await companyScopedIndex(cardsByCompany, pending.companyId, '/api/cards');
    const dependencyCardIds = pending.refs.map((ref) => byRef(cards, ref, 'card').id);
    const row = await apiRequest<ApiObject>(options, `/api/cards/${pending.card.id}`, {
      method: 'PUT',
      body: JSON.stringify({ dependencyCardIds }),
    });
    for (const key of keyFor(row)) cards.set(key, row);
    console.log(`updated card dependencies ${row.title ?? row.id}`);
  }
}

async function registerRunner(flags: Flags): Promise<void> {
  const options = apiOptions(flags);
  if (!options.auth.session) throw new Error('MEGACORPS_SESSION or --session is required for runner register');
  const body = {
    companyId: flagString(flags, 'company-id'),
    name: required(flags, 'name'),
    slug: required(flags, 'slug'),
    supportedRuntimes: list(flagString(flags, 'supported-runtimes')),
    maxConcurrent: Number(flagString(flags, 'max-concurrent', '1')),
    localWorkspaceRoot: flagString(flags, 'workspace-root'),
    localScratchRoot: flagString(flags, 'scratch-root'),
  };
  const result = await apiRequest<{ runner: ApiObject; apiKey: string }>(options, '/api/machine-runners', { method: 'POST', body: JSON.stringify(body) });
  console.log(JSON.stringify(result, null, 2));
}

function safePathName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'item';
}

function runGit(args: string[], cwd?: string): void {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

function branchFor(project: ManifestRecord, card: ManifestRecord, agent: ManifestRecord | null): string {
  const pattern = text(project.workBranchPattern) ?? 'megacorps/card-{cardId}-{agentSlug}';
  return pattern
    .replaceAll('{cardId}', text(card.id)?.slice(0, 8) ?? 'card')
    .replaceAll('{projectId}', text(project.id)?.slice(0, 8) ?? 'project')
    .replaceAll('{agentSlug}', text(agent?.slug) ?? 'agent');
}

async function prepareWorktree(flags: Flags, payload: ManifestRecord): Promise<{ branch?: string; worktreePath?: string } | null> {
  const project = payload.project as ManifestRecord | null | undefined;
  const card = payload.card as ManifestRecord | null | undefined;
  const agent = payload.agent as ManifestRecord | null | undefined;
  const repoUrl = text(project?.repoUrl);
  if (!project || !card || !repoUrl) return null;
  const root = resolve(flagString(flags, 'workspace-root') ?? process.env.MEGACORPS_RUNNER_WORKSPACE_ROOT ?? '.megacorps-runner');
  const repoDir = join(root, 'repos', safePathName(text(project.name) ?? text(project.id) ?? basename(repoUrl)));
  const branch = branchFor(project, card, agent ?? null);
  const worktreePath = join(root, 'worktrees', safePathName(branch));
  await mkdir(join(root, 'repos'), { recursive: true });
  await mkdir(join(root, 'worktrees'), { recursive: true });
  if (!existsSync(repoDir)) {
    runGit(['clone', '--no-checkout', repoUrl, repoDir]);
  } else {
    runGit(['fetch', '--all', '--prune'], repoDir);
  }
  if (!existsSync(worktreePath)) {
    const defaultBranch = text(project.defaultBranch) ?? 'main';
    runGit(['worktree', 'add', '-B', branch, worktreePath, `origin/${defaultBranch}`], repoDir);
  }
  await mkdir(join(worktreePath, '.megacorps'), { recursive: true });
  await writeFile(join(worktreePath, '.megacorps', `task-${text((payload.taskRun as ManifestRecord | undefined)?.id) ?? 'unknown'}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  return { branch, worktreePath };
}

async function runnerDaemon(flags: Flags): Promise<void> {
  const options = apiOptions(flags, true);
  if (!options.auth.runnerKey) throw new Error('MEGACORPS_RUNNER_KEY or --runner-key is required for runner daemon');
  const intervalMs = Number(flagString(flags, 'interval-ms', '5000'));
  const once = flagBoolean(flags, 'once');
  do {
    await apiRequest(options, '/api/runner/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        version: '0.1.0',
        os: `${process.platform}/${process.arch}`,
        activeSlots: 0,
        localWorkspaceRoot: flagString(flags, 'workspace-root') ?? process.env.MEGACORPS_RUNNER_WORKSPACE_ROOT,
        supportedRuntimes: list(flagString(flags, 'supported-runtimes')),
        runtimeStatuses: {},
      }),
    });
    const claim = await apiRequest<ManifestRecord>(options, '/api/runner/task-runs/claim', { method: 'POST', body: JSON.stringify({ kinds: ['dispatch', 'review'] }) });
    if (!claim.taskRun) {
      if (once) break;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
      continue;
    }
    const worktree = await prepareWorktree(flags, claim);
    const taskRun = claim.taskRun as ManifestRecord;
    console.log(`claimed task run ${taskRun.id}${worktree?.worktreePath ? ` at ${worktree.worktreePath}` : ''}`);
    if (!flagBoolean(flags, 'no-complete')) {
      const status = flagString(flags, 'scaffold-status', 'needs_review');
      await apiRequest(options, `/api/runner/task-runs/${taskRun.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          status,
          summary: worktree?.worktreePath
            ? `Runner scaffold prepared ${worktree.branch} at ${worktree.worktreePath}.`
            : 'Runner scaffold claimed the task. No repository is configured for this project.',
          output: JSON.stringify({ worktree }, null, 2),
          workProducts: worktree?.worktreePath ? [{
            type: 'artifact',
            title: 'Runner worktree scaffold',
            summary: `Prepared branch ${worktree.branch}`,
            metadata: worktree,
          }] : [],
        }),
      });
      console.log(`completed scaffold task run ${taskRun.id} as ${status}`);
    }
  } while (!once);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const [first, second] = command;
  if (!first || first === 'help' || flagBoolean(flags, 'help')) {
    console.log(usage());
    return;
  }
  if (first === 'login') return login(flags);
  if (first === 'apply') return applyManifest(flags);
  if (first === 'runner' && second === 'register') return registerRunner(flags);
  if (first === 'runner' && second === 'daemon') return runnerDaemon(flags);
  throw new Error(`Unknown command: ${command.join(' ')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
