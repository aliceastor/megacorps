import { expect, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Render the real catalog, including every documented endpoint. The server's
// source-only shared package needs its normal tsx loader outside Playwright.
const help = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import { apiHelpCatalog } from './src/api-help.ts'; process.stdout.write(JSON.stringify(apiHelpCatalog()));"], { cwd: resolve(process.cwd(), '../server'), encoding: 'utf8' }));

export const companyId = '11111111-1111-4111-8111-111111111111';
export const secondCompanyId = '22222222-2222-4222-8222-222222222222';
export const bossId = '33333333-3333-4333-8333-333333333333';
export const headId = '44444444-4444-4444-8444-444444444444';
const departmentId = '55555555-5555-4555-8555-555555555555';
const positionId = '66666666-6666-4666-8666-666666666666';
const projectId = '77777777-7777-4777-8777-777777777777';
export const cardId = '88888888-8888-4888-8888-888888888888';
const runtimeId = '99999999-9999-4999-8999-999999999999';
const date = '2026-09-06T00:00:00.000Z';
// Names plus their prefixes remain within the narrowest API limit (120).
export const longText = 'LongContent' + 'withoutBreaks'.repeat(7);

/** Exact known routes only. Unknown requests and writes fail visibly, never become empty success. */
export async function productFixture(page: Page, populated: boolean) {
  const unexpected: string[] = [], errors: string[] = [], reads: string[] = [], failed: string[] = [];
  let failPath = '';
  let failWrite = false, heldCompany = '';
  const held: Route[] = [], writes: { method: string; body: any }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) failed.push(request.url()); });
  await page.addInitScript(() => { localStorage.setItem('locale', 'en'); localStorage.setItem('megacorps.sidebarOpen', 'true'); });
  const companies = populated ? [{ id: companyId, name: 'Company Alpha ' + longText, slug: 'alpha', mission: longText, autoDispatchEnabled: false, dispatchIntervalSeconds: 10 }, { id: secondCompanyId, name: 'Company Beta', slug: 'beta' }] : [];
  const agents = populated ? [
    { id: bossId, companyId, name: 'Boss Alpha', role: 'worker', positionId, rank: 0, departmentId: null, bossId: null, runtimeId, adapterType: 'a2a', adapterConfig: {}, isActive: true, isBusy: false, budgetMonthly: '10', budgetPerTask: '1', spentThisMonth: '999.00000000' },
    { id: headId, companyId, name: 'Head Alpha ' + longText, role: 'worker', rank: 10, departmentId, bossId, runtimeId, adapterType: 'a2a', adapterConfig: {}, isActive: true, isBusy: false, budgetMonthly: '10', budgetPerTask: '1' },
  ] : [];
  const departments = populated ? [{ id: departmentId, companyId, name: 'Engineering ' + longText, slug: 'engineering', headAgentId: headId, description: longText }] : [];
  const projects = populated ? [{ id: projectId, companyId, name: 'Project Alpha ' + longText, description: longText, repoProvider: 'gitea-local', repoUrl: 'https://example.test/alpha/' + longText, defaultBranch: 'main', completionRequiresMerge: true, autoMergeAfterApproval: true, mergeReadiness: { ready: false, issues: ['Synthetic repository awaits configuration'] } }] : [];
  const cards = populated ? [{ id: cardId, companyId, projectId, departmentId, assigneeId: headId, reviewerId: null, title: 'Task Alpha ' + longText, body: 'Make a useful task counter for our team.', columnStatus: 'todo', priority: 0, tags: [], dependencyCardIds: [], requiresApproval: false, decisionMode: 'auto', maxRetries: 3, updatedAt: date }] : [];
  const runtimes = populated ? [{ id: runtimeId, companyId, name: 'Runtime Alpha', adapterType: 'a2a', config: { a2aBaseUrl: 'https://runtime.example.test' }, isActive: true }] : [];
  const docs = populated ? [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', companyId, title: 'Guidance Alpha ' + longText, tags: ['engineering', longText], body: '# Guidance\n' + longText, updatedAt: date }, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', companyId: secondCompanyId, title: 'Guidance Beta', tags: [], body: '# Beta guidance', updatedAt: date }] : [];
  const usage = { actualUsd: '0.00000000', estimatedUsd: '0.00000000', totalUsd: '0.00000000', reservedUsd: '0.00000000', unknownAttempts: 0, attempts: 0, period: { key: '2026-09', start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z', timezone: 'UTC' }, reservationAsOf: date, accounting: 'Synthetic application accounting', taskScope: 'Direct card executions' };
  const cron = { enabled: true, intervalMs: 10000, running: false, lastStartedAt: null, lastCompletedAt: null, lastStatus: null, lastError: null, companyTicks: [], recentRuns: [] };
  const rows: Record<string, any[]> = {
    '/api/companies': companies, '/api/agents': agents, '/api/departments': departments, '/api/projects': projects, '/api/cards': cards,
    '/api/positions': populated ? [{ id: positionId, companyId, name: 'Strategy Boss', slug: 'boss', rank: 0, isCompanyBoss: true, isActive: true, prompt: longText }] : [],
    '/api/positions/templates': [], '/api/goals': [], '/api/approvals': [], '/api/agent-runtimes': runtimes,
    '/api/agent-runtimes/health': runtimes.map(runtime => ({ runtimeId: runtime.id, name: runtime.name, adapterType: runtime.adapterType, status: 'ready', statusBasis: 'configuration_and_observed_runs', reachability: 'not_checked', isActive: true, agents: 2, activeAgents: 2, busyAgents: 0, capabilities: ['a2a', 'json-rpc', 'task-push-notifications'] })),
    '/api/company-memberships': populated ? [{ id: 'membership', companyId, userId: 'user', userEmail: 'smoke@example.test', role: 'admin', status: 'active' }] : [],
    '/api/knowledge-docs': docs, '/api/budget-policies': [], '/api/cost-events': [], '/api/chat/sessions': [], '/api/cron/runs': [],
    '/api/trash': populated ? [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', companyId, type: 'card', label: 'Archived ' + longText, detail: longText, deletedAt: date }] : [],
    '/api/admin/users': [{ id: 'user', email: 'smoke@example.test', name: 'Test operator', role: 'admin', status: 'active', memberships: [] }],
  };
  await page.route('**/api/proxy/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/proxy', '');
    if (request.method() !== 'GET') {
      if (path === '/api/knowledge-docs' && request.method() === 'POST') {
        const body = request.postDataJSON(); writes.push({ method: 'POST', body });
        if (failWrite) return route.fulfill({ status: 503, json: { error: 'synthetic_write_unavailable' } });
        const row = { ...body, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', updatedAt: date }; docs.push(row);
        return route.fulfill({ status: 201, json: row });
      }
      unexpected.push(`${request.method()} ${path}`); return route.fulfill({ status: 405, json: { error: 'unexpected_fixture_write' } });
    }
    reads.push(path + url.search);
    if (path === failPath) return route.fulfill({ status: 503, json: { error: 'synthetic_read_unavailable' } });
    if (path === '/api/knowledge-docs' && url.searchParams.get('companyId') === heldCompany) { held.push(route); return; }
    if (path === '/api/me') return route.fulfill({ json: { user: { id: 'user', email: 'smoke@example.test', role: 'admin' }, memberships: companies.map(company => ({ companyId: company.id, role: 'admin', status: 'active' })) } });
    if (path === '/api/notifications') return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path === '/api/help') return route.fulfill({ json: help });
    if (path === '/api/dashboard') return route.fulfill({ json: { stats: { companies: companies.length, agents: agents.length, projects: projects.length, cards: cards.length, monthlyCost: 0 }, stages: populated ? { todo: 1 } : {}, recentTaskLogs: [], recentApiEvents: [], recentActivity: [], recentRuns: [], pendingApprovals: [], usage } });
    if (path === '/api/dashboard/timeseries') return route.fulfill({ json: { days: 30, points: [] } });
    if (path === '/api/cron/status') return route.fulfill({ json: cron });
    if (path === '/api/usage-summary') return route.fulfill({ json: { ...usage, period: url.searchParams.get('period') === 'all' ? null : usage.period } });
    if (path === '/api/admin/settings') return route.fulfill({ json: { signupEnabled: true, kanbanTaskTimeoutSeconds: 300, chatTaskTimeoutSeconds: 300, apiTokenConfigured: false, apiTokenPreview: null } });
    if (path === `/api/companies/${companyId}/execution-readiness` || path === `/api/companies/${secondCompanyId}/execution-readiness`) return route.fulfill({ json: { ready: false, issues: ['Synthetic runtime has not been probed'], setupIssues: [], runtimeIssues: ['Synthetic runtime has not been probed'] } });
    if (path === `/api/companies/${companyId}/deletion-preview` || path === `/api/companies/${secondCompanyId}/deletion-preview`) return route.fulfill({ json: { canDelete: false, blocking: { agents: 2 }, inventory: {} } });
    if (path === '/api/prompt-logs' && url.searchParams.get('view') === 'summary') return route.fulfill({ json: { items: populated ? [{ id: 'prompt', source: 'dispatch', adapterType: 'a2a', title: 'Prompt Alpha', preview: longText, agentId: headId, cardId, createdAt: date }] : [], nextCursor: null } });
    if (path === `/api/cards/${cardId}/delegation-summary`) return route.fulfill({ json: {} });
    if ([`/api/cards/${cardId}/subtree`, `/api/cards/${cardId}/review-rounds`, `/api/cards/${cardId}/comments`, `/api/cards/${cardId}/work-products`, `/api/cards/${cardId}/logs`, `/api/cards/${cardId}/actions`].includes(path)) return route.fulfill({ json: [] });
    if (Object.hasOwn(rows, path)) {
      const company = url.searchParams.get('companyId');
      return route.fulfill({ json: rows[path]!.filter(row => !company || !row.companyId || row.companyId === company) });
    }
    unexpected.push(`GET ${path}${url.search}`);
    return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_read' } });
  });
  return { unexpected, errors, failed, reads, writes, fail: (path: string) => { failPath = path; }, failWrite: (value: boolean) => { failWrite = value; }, holdDocs: (company: string) => { heldCompany = company; }, hasHeld: () => held.length > 0, releaseDocs: async () => { heldCompany = ''; for (const route of held.splice(0)) { const company = new URL(route.request().url()).searchParams.get('companyId'); await route.fulfill({ json: docs.filter(doc => doc.companyId === company) }).catch(() => {}); } } };
}

export async function settlePage(page: Page) {
  await expect(page.locator('.user-btn span')).toHaveText('smoke@example.test');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}
