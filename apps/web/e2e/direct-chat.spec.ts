import { expect, test, type Page, type Route } from '@playwright/test';

const companies = [
  { id: 'company-acme', name: 'Acme Research Collective With A Long Name', slug: 'acme' },
  { id: 'company-globex', name: 'Globex', slug: 'globex' },
];

const projects = [
  { id: 'project-orbit', companyId: 'company-acme', name: 'Orbital Reliability Program', description: 'Reliability work for a deliberately long project description.' },
  { id: 'project-archive', companyId: 'company-acme', name: 'Archive', description: 'Archive migration' },
  { id: 'project-globex', companyId: 'company-globex', name: 'Globex Launch', description: 'Launch planning' },
];

const agents = [
  { id: 'agent-ada', companyId: 'company-acme', name: 'Ada Lovelace', role: 'Principal systems investigator', adapterType: 'codex', isActive: true, isBusy: false },
  { id: 'agent-grace', companyId: 'company-acme', name: 'Grace Hopper', role: 'Compiler and platform lead', adapterType: 'codex', isActive: true, isBusy: false },
  { id: 'agent-katherine', companyId: 'company-globex', name: 'Katherine Johnson', role: 'Flight dynamics lead', adapterType: 'codex', isActive: true, isBusy: false },
];

const sessions = [
  { id: 'session-ada-orbit', companyId: 'company-acme', agentId: 'agent-ada', projectId: 'project-orbit', title: 'Orbit incident analysis', status: 'active', agentSessionId: 'resume-ada', updatedAt: '2026-09-05T12:00:00.000Z' },
  { id: 'session-ada-general', companyId: 'company-acme', agentId: 'agent-ada', projectId: null, title: 'General architecture notes', status: 'active', updatedAt: '2026-09-05T11:00:00.000Z' },
  { id: 'session-grace', companyId: 'company-acme', agentId: 'agent-grace', projectId: 'project-archive', title: 'Compiler migration', status: 'active', updatedAt: '2026-09-05T10:00:00.000Z' },
  { id: 'session-katherine', companyId: 'company-globex', agentId: 'agent-katherine', projectId: 'project-globex', title: 'Launch window', status: 'active', updatedAt: '2026-09-05T09:00:00.000Z' },
];

const messages = {
  'session-ada-orbit': [
    { id: 'message-ada-1', sessionId: 'session-ada-orbit', companyId: 'company-acme', agentId: 'agent-ada', authorType: 'agent', body: 'The orbital diagnostics are ready.', createdAt: '2026-09-05T12:01:00.000Z' },
  ],
  'session-ada-general': [],
  'session-grace': [],
  'session-katherine': [],
} as Record<string, Array<Record<string, unknown>>>;

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
}

async function mockChat(page: Page, options: { failFirstSend?: boolean } = {}) {
  const state = { sendAttempts: 0, sentBodies: [] as string[] };
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem('megacorps.sidebarOpen', 'true');
  });
  await page.route('**/api/proxy/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/proxy/, '');
    if (path === '/api/me') return fulfillJson(route, { user: { email: 'chat@example.test', role: 'admin' } });
    if (path === '/api/notifications') return fulfillJson(route, { notifications: [], unreadCount: 0 });
    if (path === '/api/companies') return fulfillJson(route, companies);
    if (path === '/api/projects') return fulfillJson(route, projects);
    if (path === '/api/agents') return fulfillJson(route, agents);
    if (path === '/api/chat/sessions' && request.method() === 'GET') {
      const companyId = url.searchParams.get('companyId');
      const agentId = url.searchParams.get('agentId');
      const projectId = url.searchParams.get('projectId');
      return fulfillJson(route, sessions.filter((session) => session.companyId === companyId
        && session.agentId === agentId
        && (!projectId || (projectId === 'none' ? session.projectId === null : session.projectId === projectId))));
    }
    const messageMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
    if (messageMatch && request.method() === 'GET') return fulfillJson(route, messages[messageMatch[1]!] ?? []);
    if (messageMatch && request.method() === 'POST') {
      state.sendAttempts += 1;
      const body = request.postDataJSON() as { body: string };
      state.sentBodies.push(body.body);
      if (options.failFirstSend && state.sendAttempts === 1) return fulfillJson(route, { message: 'Synthetic transport failure' }, 503);
      return fulfillJson(route, {
        userMessage: { id: `confirmed-user-${state.sendAttempts}`, sessionId: messageMatch[1], companyId: 'company-acme', agentId: 'agent-ada', authorType: 'user', body: body.body, createdAt: '2026-09-05T12:02:00.000Z' },
        agentMessage: { id: `confirmed-agent-${state.sendAttempts}`, sessionId: messageMatch[1], companyId: 'company-acme', agentId: 'agent-ada', authorType: 'agent', body: `Reply to: ${body.body}`, createdAt: '2026-09-05T12:03:00.000Z' },
      });
    }
    return fulfillJson(route, { message: `Unexpected ${request.method()} ${path}` }, 500);
  });
  return state;
}

async function openChat(page: Page, width = 1158) {
  await page.setViewportSize({ width, height: 844 });
  await mockChat(page);
  await page.goto('/chat');
  await expect(page.getByRole('heading', { name: 'Direct Chat', exact: true })).toBeVisible();
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
}

test('conversation-first desktop uses labeled scope selectors and a useful conversation pane', async ({ page }, testInfo) => {
  await openChat(page);

  const scope = page.locator('.chat-scope-controls');
  await expect(scope).toBeVisible();
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('company-acme');
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('all');
  await expect(page.getByLabel('Agent', { exact: true })).toHaveValue('agent-ada');

  const workspace = page.locator('.chat-workspace');
  const sessionPane = page.locator('.session-rail');
  const conversation = page.locator('.chat-thread');
  await expect.poll(async () => {
    const scopeBox = await scope.boundingBox();
    const workspaceBox = await workspace.boundingBox();
    return Boolean(scopeBox && workspaceBox && scopeBox.y + scopeBox.height <= workspaceBox.y + 1);
  }).toBe(true);
  await expect.poll(async () => (await sessionPane.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(220);
  await expect.poll(async () => (await conversation.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(500);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('chat-desktop-1158.png'), fullPage: true });
});

test('failed send preserves the existing composer draft and retries the same payload once', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { failFirstSend: true });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();

  const composer = page.getByPlaceholder('Message');
  await composer.fill('Keep this exact retry payload');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Synthetic transport failure')).toBeVisible();
  await expect(composer).toHaveValue('Keep this exact retry payload');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Reply to: Keep this exact retry payload')).toBeVisible();
  expect(state.sentBodies).toEqual(['Keep this exact retry payload', 'Keep this exact retry payload']);
});
