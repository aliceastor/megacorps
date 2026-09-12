import { expect, type Page } from '@playwright/test';

export async function fixture(page: Page, width = 1158) {
  const companyId = 'company-chart';
  const positions = [0, 10, 20, 30, 50, 60, 100].map(rank => ({ id: `rank-${rank}`, companyId, name: `Position ${rank}`, slug: `rank-${rank}`, rank, isCompanyBoss: rank === 0 }));
  const departments = [
    { id: 'engineering', companyId, name: 'Engineering', slug: 'engineering', headAgentId: 'manager' },
    { id: 'operations', companyId, name: 'Operations', slug: 'operations', headAgentId: null },
    { id: 'product', companyId, name: 'Product', slug: 'product', headAgentId: null },
  ];
  const agents = [
    { id: 'boss', name: 'Company Boss', positionId: 'rank-0' },
    { id: 'manager', name: 'Engineering manager', departmentId: 'engineering', positionId: 'rank-100', bossId: 'boss' },
    { id: 'analyst', name: 'Product analyst with a deliberately long wrapping display name', departmentId: 'engineering', positionId: 'rank-10', bossId: 'manager' },
    { id: 'peer', name: 'Design specialist', departmentId: 'engineering', positionId: 'rank-10', bossId: 'manager' },
    { id: 'intervening', name: 'Intervening product specialist', departmentId: 'product', positionId: 'rank-50', bossId: 'boss' },
    { id: 'researcher', name: 'Engineering researcher', departmentId: 'engineering', positionId: 'rank-10', bossId: 'manager' },
    { id: 'cycle-a', name: 'Legacy cycle A', departmentId: 'engineering', positionId: 'rank-20', bossId: 'cycle-b' },
    { id: 'cycle-b', name: 'Legacy cycle B', departmentId: 'engineering', positionId: 'rank-60', bossId: 'cycle-a' },
    { id: 'orphan', name: 'Legacy orphan', departmentId: 'engineering', positionId: 'rank-30', bossId: 'missing' },
    { id: 'unassigned', name: 'Unassigned colleague', departmentId: 'missing-department', positionId: 'missing-position' },
  ].map(a => ({ companyId, slug: a.id, role: 'custom professional role', soul: 'Synthetic soul prompt', adapterType: 'a2a', runtimeId: 'runtime', hermesProfile: 'saved-profile', capabilities: ['synthetic-analysis', 'synthetic-writing'], adapterConfig: { bearerToken: 'synthetic-credential-sentinel', agentPath: '/custom-agent', nested: { preserve: true } }, budgetPerTask: '12.0000', budgetMonthly: '300.0000', memoryConfig: { enabled: true }, defaultTimeoutSeconds: 1200, isActive: true, ...a }));
  const writes: Array<Record<string, unknown>> = [];
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('locale', 'en'); localStorage.setItem('megacorps.sidebarOpen', 'true'); });
  await page.route('**/api/proxy/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/proxy', '');
    if (request.method() === 'PUT' && path.startsWith('/api/agents/')) {
      const body = request.postDataJSON(); writes.push(body);
      const agent = agents.find(a => path.endsWith(`/${a.id}`))!;
      Object.assign(agent, body); return route.fulfill({ json: agent });
    }
    let json: unknown = [];
    if (path === '/api/me') json = { user: { email: 'org@example.test', role: 'admin' } };
    if (path === '/api/companies') json = [{ id: companyId, name: 'Chart Company', slug: 'chart' }];
    if (path === '/api/departments') json = departments;
    if (path === '/api/positions') json = positions;
    if (path === '/api/agents') json = agents;
    if (path === '/api/agent-runtimes') json = [{ id: 'runtime', companyId, name: 'Synthetic runtime', adapterType: 'a2a' }];
    if (path.includes('/notifications')) json = { notifications: [], unreadCount: 0 };
    await route.fulfill({ json });
  });
  await page.goto('/departments/o-chart');
  await expect(page.locator('.user-btn span')).toHaveText('org@example.test');
  return { agents, writes };
}

