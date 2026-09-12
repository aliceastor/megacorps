import { expect, test, type Page, type Route } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const companies = [
  { id: 'company-acme', name: 'Acme Research Collective With A Long Name', slug: 'acme' },
  { id: 'company-globex', name: 'Globex', slug: 'globex' },
  { id: 'company-empty', name: 'Empty company', slug: 'empty' },
];

const projects = [
  { id: 'project-orbit', companyId: 'company-acme', name: 'Orbital Reliability Program', description: 'Reliability work for a deliberately long project description.' },
  { id: 'project-archive', companyId: 'company-acme', name: 'Archive', description: 'Archive migration' },
  { id: 'project-globex', companyId: 'company-globex', name: 'Globex Launch', description: 'Launch planning' },
];

const agents = [
  { id: 'agent-ada', companyId: 'company-acme', name: 'Ada Lovelace', role: 'Principal systems investigator', adapterType: 'codex', isActive: true, isBusy: false },
  { id: 'agent-grace', companyId: 'company-acme', name: 'Grace Hopper', role: 'Compiler and platform lead', adapterType: 'codex', isActive: true, isBusy: false },
  { id: 'agent-paused', companyId: 'company-acme', name: 'Dorothy Vaughan', role: 'Research supervisor', adapterType: 'codex', isActive: false, isBusy: false },
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
    { id: 'message-ada-1', sessionId: 'session-ada-orbit', companyId: 'company-acme', agentId: 'agent-ada', authorType: 'agent', body: `The orbital diagnostics are ready.\n\n\`\`\`text\n${'long-segment-'.repeat(80)}\n\`\`\`\n\n[Reference](${'https://example.test/'.padEnd(260, 'x')})`, createdAt: '2026-09-05T12:01:00.000Z' },
  ],
  'session-ada-general': [],
  'session-grace': [],
  'session-katherine': [],
} as Record<string, Array<Record<string, unknown>>>;

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
}

async function mockChat(page: Page, options: { asyncA2a?: boolean; job429Count?: number; completionMessage429Count?: number; failFirstSend?: boolean; failFirstCreate?: boolean; busyAgents?: string[]; holdAgentSessions?: string; holdCompanyRefresh?: boolean; failSessionGetsForAgents?: string[]; failMessageGetsForSessions?: string[]; sendDelayMs?: number; sessionDelayMs?: number; locale?: 'en' | 'zh-TW' | 'ja' } = {}) {
  let releaseSessions!: () => void;
  const sessionsGate = new Promise<void>((resolve) => { releaseSessions = resolve; });
  let releaseCompanies!: () => void;
  const companiesGate = new Promise<void>((resolve) => { releaseCompanies = resolve; });
  const companyStore = companies.map((company) => ({ ...company }));
  const projectStore = projects.map((project) => ({ ...project }));
  const agentStore = agents.map((agent) => ({ ...agent, ...(options.asyncA2a && agent.id === 'agent-ada' ? { adapterType: 'a2a' } : {}) }));
  const jobs: Record<string, any[]> = {};
  const messageStore = Object.fromEntries(Object.entries(messages).map(([sessionId, rows]) => [sessionId, rows.map((row) => ({ ...row }))])) as typeof messages;
  const sessionStore = sessions.map((session) => ({ ...session }));
  const failingSessionGets = new Set(options.failSessionGetsForAgents ?? []);
  const failingMessageGets = new Set(options.failMessageGetsForSessions ?? []);
  let job429sRemaining = options.job429Count ?? 0;
  let completionMessage429sRemaining = options.completionMessage429Count ?? 0;
  const state = {
    finishJob(sessionId: string) {
      jobs[sessionId]![0].status = 'completed';
      messageStore[sessionId]!.push({ id: 'async-answer', sessionId, companyId: 'company-acme', agentId: 'agent-ada', authorType: 'agent', body: 'The durable reply arrived.', createdAt: '2026-09-05T12:03:00.000Z' });
    },
    releaseSessions,
    releaseCompanies,
    companyGetCount: 0,
    heldCompanyGets: 0,
    heldSessionGets: 0,
    sessionGetCounts: {} as Record<string, number>,
    messageGetCounts: {} as Record<string, number>,
    jobGetCounts: {} as Record<string, number>,
    sendAttempts: 0,
    sentBodies: [] as string[],
    messagePostSessionIds: [] as string[],
    sessionCreates: [] as Array<Record<string, unknown>>,
    appendMessage(sessionId: string, message: Record<string, unknown>) {
      messageStore[sessionId] = [...(messageStore[sessionId] ?? []), message];
    },
    failSessionGets(agentId: string) { failingSessionGets.add(agentId); },
    recoverSessionGets(agentId: string) { failingSessionGets.delete(agentId); },
    failMessageGets(sessionId: string) { failingMessageGets.add(sessionId); },
    recoverMessageGets(sessionId: string) { failingMessageGets.delete(sessionId); },
    removeCompany(companyId: string) {
      const index = companyStore.findIndex((company) => company.id === companyId);
      if (index >= 0) companyStore.splice(index, 1);
    },
  };
  await page.addInitScript((locale) => {
    localStorage.setItem('locale', locale);
    localStorage.setItem('megacorps.sidebarOpen', 'true');
  }, options.locale ?? 'en');
  await page.route('**/api/proxy/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/proxy/, '');
    if (path === '/api/me') return fulfillJson(route, { user: { email: 'chat@example.test', role: 'admin' } });
    if (path === '/api/notifications') return fulfillJson(route, { notifications: [], unreadCount: 0 });
    if (path === '/api/companies') {
      state.companyGetCount += 1;
      if (options.holdCompanyRefresh && state.companyGetCount > 1) {
        state.heldCompanyGets += 1;
        await companiesGate;
      }
      return fulfillJson(route, companyStore);
    }
    if (path === '/api/projects') return fulfillJson(route, projectStore);
    if (path === '/api/agents') return fulfillJson(route, agentStore.map((agent) => ({ ...agent, isBusy: options.busyAgents?.includes(agent.id) ?? agent.isBusy })));
    if (path === '/api/chat/sessions' && request.method() === 'GET') {
      const companyId = url.searchParams.get('companyId');
      const agentId = url.searchParams.get('agentId');
      const projectId = url.searchParams.get('projectId');
      const sessionGetKey = agentId ?? 'missing-agent';
      state.sessionGetCounts[sessionGetKey] = (state.sessionGetCounts[sessionGetKey] ?? 0) + 1;
      if (agentId === options.holdAgentSessions) { state.heldSessionGets += 1; await sessionsGate; }
      if (failingSessionGets.has(sessionGetKey)) return fulfillJson(route, { message: 'Synthetic sessions read failure' }, 503);
      return fulfillJson(route, sessionStore.filter((session) => session.companyId === companyId
        && session.agentId === agentId
        && (!projectId || (projectId === 'none' ? session.projectId === null : session.projectId === projectId))));
    }
    if (path === '/api/chat/sessions' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.sessionCreates.push(body);
      if (options.sessionDelayMs) await new Promise((resolve) => setTimeout(resolve, options.sessionDelayMs));
      if (options.failFirstCreate && state.sessionCreates.length === 1) return fulfillJson(route, { message: 'Synthetic session creation failure' }, 503);
      const session = { id: `created-session-${state.sessionCreates.length}`, status: 'active', createdAt: '2026-09-05T12:04:00.000Z', updatedAt: '2026-09-05T12:04:00.000Z', ...body } as typeof sessions[number];
      sessionStore.unshift(session);
      messageStore[session.id] = [];
      return fulfillJson(route, session, 201);
    }
    const jobMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/jobs$/);
    if (jobMatch) {
      const jobSessionId = jobMatch[1]!;
      state.jobGetCounts[jobSessionId] = (state.jobGetCounts[jobSessionId] ?? 0) + 1;
      if (jobs[jobSessionId]?.some((job) => job.status === 'queued' || job.status === 'running') && job429sRemaining > 0) {
        job429sRemaining -= 1;
        return route.fulfill({ status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '0' }, body: JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 0 }) });
      }
      return fulfillJson(route, jobs[jobSessionId] ?? []);
    }
    const messageMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
    if (messageMatch && request.method() === 'GET') {
      const messageSessionId = messageMatch[1]!;
      state.messageGetCounts[messageSessionId] = (state.messageGetCounts[messageSessionId] ?? 0) + 1;
      if (messageStore[messageSessionId]?.some((message) => message.id === 'async-answer') && completionMessage429sRemaining > 0) {
        completionMessage429sRemaining -= 1;
        return route.fulfill({ status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' }, body: JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 1 }) });
      }
      if (failingMessageGets.has(messageSessionId)) return fulfillJson(route, { message: 'Synthetic history read failure' }, 503);
      return fulfillJson(route, messageStore[messageSessionId] ?? []);
    }
    if (messageMatch && request.method() === 'POST') {
      state.sendAttempts += 1;
      state.messagePostSessionIds.push(messageMatch[1]!);
      const body = request.postDataJSON() as { body: string };
      state.sentBodies.push(body.body);
      if (options.failFirstSend && state.sendAttempts === 1) return fulfillJson(route, { message: 'Synthetic transport failure' }, 503);
      if (options.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs));
      const session = sessionStore.find((row) => row.id === messageMatch[1]);
      if (!session) return fulfillJson(route, { message: 'Unknown synthetic session' }, 404);
      const userMessage = { id: `confirmed-user-${state.sendAttempts}`, sessionId: session.id, companyId: session.companyId, agentId: session.agentId, authorType: 'user', body: body.body, createdAt: '2026-09-05T12:02:00.000Z' };
      if (options.asyncA2a) {
        messageStore[session.id]!.push(userMessage);
        const job = { id: 'async-job', sessionId: session.id, userMessageId: userMessage.id, status: 'queued' };
        jobs[session.id] = [job];
        return fulfillJson(route, { session, userMessage, job }, 202);
      }
      const agentMessage = { id: `confirmed-agent-${state.sendAttempts}`, sessionId: session.id, companyId: session.companyId, agentId: session.agentId, authorType: 'agent', body: `Reply to: ${body.body}`, createdAt: '2026-09-05T12:03:00.000Z' };
      messageStore[session.id] = [...(messageStore[session.id] ?? []), userMessage, agentMessage];
      return fulfillJson(route, { session: { ...session, updatedAt: '2026-09-05T12:03:00.000Z' }, userMessage, agentMessage });
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
  if (width > 760) await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  else await expect(page.locator('.session-rail').getByRole('button', { name: /Orbit incident analysis/ })).toBeVisible();
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
  await expect(page.locator('.chat-bubble.user').filter({ hasText: 'Keep this exact retry payload' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Reply to: Keep this exact retry payload')).toBeVisible();
  expect(state.sentBodies).toEqual(['Keep this exact retry payload', 'Keep this exact retry payload']);
});

test('mobile shows one pane and provides explicit session navigation', async ({ page }, testInfo) => {
  await openChat(page, 390);
  const sessionPane = page.locator('.session-rail');
  const conversation = page.locator('.chat-thread');
  await expect(sessionPane).toBeVisible();
  await expect(conversation).toBeHidden();

  await sessionPane.getByRole('button', { name: /Orbit incident analysis/ }).click();
  await expect(conversation).toBeVisible();
  await expect(sessionPane).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sessions' })).toBeVisible();
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(sessionPane).toBeVisible();
  await expect(conversation).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('chat-mobile-sessions.png'), fullPage: true });
});

test('drafts remain isolated by session and new-session scope', async ({ page }) => {
  await openChat(page);
  const composer = page.getByPlaceholder('Message');
  await composer.fill('Orbit-specific draft');

  await page.locator('.session-rail').getByRole('button', { name: /General architecture notes/ }).click();
  await expect(composer).toHaveValue('');
  await composer.fill('General-session draft');

  await page.locator('.session-rail').getByRole('button', { name: /Orbit incident analysis/ }).click();
  await expect(composer).toHaveValue('Orbit-specific draft');
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect(composer).toHaveValue('');
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-ada');
  await expect(composer).toHaveValue('Orbit-specific draft');

  await page.getByLabel('Project', { exact: true }).selectOption('project-archive');
  await expect(page.getByText('No sessions')).toBeVisible();
  await composer.fill('Archive new-session draft');
  await page.getByLabel('Project', { exact: true }).selectOption('project-orbit');
  await page.getByLabel('Project', { exact: true }).selectOption('project-archive');
  await expect(composer).toHaveValue('Archive new-session draft');
});

test('an in-flight reply stays with its original session after a fast agent switch', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  await mockChat(page, { sendDelayMs: 700 });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();

  const composer = page.getByPlaceholder('Message');
  await composer.fill('Ada-only in-flight prompt');
  const postStarted = page.waitForRequest((request) => request.method() === 'POST' && request.url().includes('/api/chat/sessions/session-ada-orbit/messages'));
  await page.getByRole('button', { name: 'Send message' }).click();
  await postStarted;
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect(page.locator('.chat-thread-head')).toContainText('Grace Hopper');
  await expect(page.locator('.session-rail').getByRole('button', { name: /Compiler migration/ })).toBeVisible();
  await expect(page.getByText('Ada-only in-flight prompt')).toBeHidden();
  await page.waitForTimeout(900);
  await expect(page.getByText('Ada-only in-flight prompt')).toBeHidden();
  await expect(page.getByText('Reply to: Ada-only in-flight prompt')).toBeHidden();

  await page.getByLabel('Agent', { exact: true }).selectOption('agent-ada');
  await expect(page.getByText('Reply to: Ada-only in-flight prompt')).toBeVisible();
});

test('a new-session send keeps its captured scope during a fast selector switch', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { sessionDelayMs: 500, sendDelayMs: 300 });
  await page.goto('/chat');
  await page.getByLabel('Project', { exact: true }).selectOption('project-archive');
  await expect(page.getByText('No sessions')).toBeVisible();
  await page.getByPlaceholder('Message').fill('New Ada session only');
  const createStarted = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/chat/sessions'));
  await page.getByRole('button', { name: 'Send message' }).click();
  await createStarted;
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect(page.locator('.chat-thread-head')).toContainText('Grace Hopper');
  await page.waitForTimeout(1000);
  await expect(page.locator('.chat-thread-head')).toContainText('Grace Hopper');
  await expect(page.getByText('New Ada session only', { exact: true })).toBeHidden();
  await expect(page.getByText('Reply to: New Ada session only', { exact: true })).toBeHidden();
  expect(state.messagePostSessionIds).toEqual(['created-session-1']);

  await page.getByLabel('Agent', { exact: true }).selectOption('agent-ada');
  await expect(page.getByText('Reply to: New Ada session only')).toBeVisible();
});

test('pending send disables duplicates while retaining the original transport payload', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { sendDelayMs: 500 });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  const composer = page.getByPlaceholder('Message');
  const send = page.getByRole('button', { name: 'Send message' });
  await composer.fill('Exactly one transport request');
  await send.click();
  await expect(send).toBeDisabled();
  await composer.press('Enter');
  await page.waitForTimeout(100);
  expect(state.sendAttempts).toBe(1);
  await expect(page.getByText('Reply to: Exactly one transport request')).toBeVisible();
  expect(state.sentBodies).toEqual(['Exactly one transport request']);
});

test('live message events merge persisted messages once without duplicates', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page);
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  state.appendMessage('session-ada-orbit', { id: 'live-message-one', sessionId: 'session-ada-orbit', companyId: 'company-acme', agentId: 'agent-ada', authorType: 'agent', body: 'One persisted live reply', createdAt: '2026-09-05T12:05:00.000Z' });
  await page.evaluate(() => {
    const detail = { type: 'chat.message.created', sessionId: 'session-ada-orbit' };
    window.dispatchEvent(new CustomEvent('megacorps-live', { detail }));
    window.dispatchEvent(new CustomEvent('megacorps-live', { detail }));
  });
  await expect(page.getByText('One persisted live reply')).toHaveCount(1);
});

test('long Markdown remains inside the conversation and injected context stays discoverable', async ({ page }) => {
  await openChat(page);
  const link = page.getByRole('link', { name: 'Injected context' });
  await expect(link).toHaveAttribute('href', '/logs?agentId=agent-ada&surface=chat');
  const thread = (await page.locator('.chat-thread').boundingBox())!;
  const bubble = (await page.locator('.chat-bubble.agent').first().boundingBox())!;
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(thread.x + thread.width + 1);
  await expect(page.locator('.chat-bubble.agent pre')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('chat controls expose localized accessible names', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  await mockChat(page, { locale: 'ja' });
  await page.goto('/chat');
  await expect(page.getByRole('heading', { name: 'ダイレクトチャット', exact: true })).toBeVisible();
  const scope = page.getByRole('region', { name: 'チャット範囲' });
  await expect(scope.getByLabel('会社', { exact: true })).toBeVisible();
  await expect(scope.getByLabel('プロジェクト', { exact: true })).toBeVisible();
  await expect(scope.getByLabel('エージェント', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'メッセージを送信' })).toBeVisible();
});

test('composer grows for multiline text and Enter sends while Shift+Enter inserts a line', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page);
  await page.goto('/chat');
  const composer = page.getByPlaceholder('Message');
  await expect(composer).toBeVisible();
  const initialHeight = (await composer.boundingBox())!.height;

  await composer.fill('First line');
  await composer.press('Shift+Enter');
  await composer.type('Second line');
  await expect(composer).toHaveValue('First line\nSecond line');
  await composer.fill('First line\nSecond line\nThird line\nFourth line\nFifth line\nSixth line');
  await expect.poll(async () => (await composer.boundingBox())!.height).toBeGreaterThan(initialHeight);
  expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(180);
  expect(state.sendAttempts).toBe(0);
  await composer.press('Enter');
  await expect.poll(() => state.sendAttempts).toBe(1);
  expect(state.sentBodies).toEqual(['First line\nSecond line\nThird line\nFourth line\nFifth line\nSixth line']);
  await expect(composer).toHaveValue('');
  await expect(composer).toBeFocused();
});

test('conversation header exposes agent, project, and status identity', async ({ page }) => {
  await openChat(page);
  const header = page.locator('.chat-thread-head');
  await expect(header).toContainText('Ada Lovelace');
  await expect(header).toContainText('Orbital Reliability Program');
  await expect(header).toContainText('Idle');
});

test('paused agent state offers a useful next action', async ({ page }) => {
  await openChat(page);
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-paused');
  await expect(page.getByText('This agent is paused.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage agents' })).toHaveAttribute('href', '/agents');
  await expect(page.getByPlaceholder('Message')).toBeDisabled();
});

test('browsing scopes does not create a session and the explicit action uses the selected scope', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page);
  await page.goto('/chat');
  await page.getByLabel('Project', { exact: true }).selectOption('project-archive');
  await expect(page.getByText('No sessions')).toBeVisible();
  expect(state.sessionCreates).toEqual([]);
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(page.locator('.chat-thread-head')).toContainText('Chat with Ada Lovelace');
  expect(state.sessionCreates).toEqual([{ companyId: 'company-acme', agentId: 'agent-ada', projectId: 'project-archive', title: 'Chat with Ada Lovelace' }]);
});

async function setSidebar(page: Page, open: boolean) {
  const toggle = page.getByRole('button', { name: 'Toggle sidebar' });
  if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(open));
  let previous = '';
  let stableSamples = 0;
  await expect.poll(async () => {
    const bounds = await page.locator('.sidebar, main, .chat-workspace').evaluateAll((nodes) => JSON.stringify(nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100);
    })));
    stableSamples = bounds === previous ? stableSamples + 1 : 0;
    previous = bounds;
    return stableSamples;
  }, { intervals: [100], message: 'sidebar and chat geometry must settle after each transition' }).toBeGreaterThanOrEqual(3);
}

test('scoped GET loading removes old session click and send targets', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { holdAgentSessions: 'agent-grace' });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await page.getByPlaceholder('Message').fill('Ada private draft');
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect.poll(() => state.heldSessionGets).toBe(1);
  const oldSession = page.locator('.session-rail').getByRole('button', { name: /Orbit incident analysis/ });
  const oldClickable = await oldSession.isVisible();
  if (oldClickable) {
    await oldSession.click();
    await page.getByPlaceholder('Message').fill('Grace loading-window payload');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => state.sendAttempts).toBe(1);
  }
  expect.soft(oldClickable, 'old-scope button must not be reachable during delayed GET').toBe(false);
  expect.soft(state.messagePostSessionIds, 'no request may target Ada while Grace is selected').toEqual([]);
  await expect.soft(page.getByText('The orbital diagnostics are ready.')).toBeHidden();
  await expect.soft(page.getByPlaceholder('Message')).toHaveValue('');
  // Exercise a send during the held GET even after the stale button is removed.
  await page.getByPlaceholder('Message').fill('Grace loading-window payload');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Reply to: Grace loading-window payload')).toBeVisible();
  expect(state.sessionCreates).toEqual([{ companyId: 'company-acme', agentId: 'agent-grace', projectId: null, title: 'Chat with Grace Hopper' }]);
  expect(state.messagePostSessionIds).toEqual(['created-session-1']);
  state.releaseSessions();
  await page.locator('.session-rail').getByRole('button', { name: /Compiler migration/ }).click();
  await page.getByPlaceholder('Message').fill('Grace confirmed payload');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Reply to: Grace confirmed payload')).toBeVisible();
  expect(state.messagePostSessionIds).toEqual(['created-session-1', 'session-grace']);
  expect(state.sentBodies).toEqual(['Grace loading-window payload', 'Grace confirmed payload']);
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-ada');
  await expect(page.getByPlaceholder('Message')).toHaveValue('Ada private draft');
});

test('late Refresh preserves a newer agent session and draft', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { holdCompanyRefresh: true });
  await page.goto('/chat');
  await expect(page.locator('.chat-thread-head')).toContainText('Orbit incident analysis');

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => state.heldCompanyGets).toBe(1);
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect(page.locator('.chat-thread-head')).toContainText('Compiler migration');
  await page.getByPlaceholder('Message').fill('Grace draft after refresh started');

  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);
  state.releaseCompanies();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('company-acme');
  await expect(page.getByLabel('Agent', { exact: true })).toHaveValue('agent-grace');
  await expect(page.locator('.chat-thread-head')).toContainText('Grace Hopper');
  await expect(page.locator('.chat-thread-head')).toContainText('Compiler migration');
  await expect(page.getByPlaceholder('Message')).toHaveValue('Grace draft after refresh started');
  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);

  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Reply to: Grace draft after refresh started')).toBeVisible();
  expect(state.messagePostSessionIds).toEqual(['session-grace']);
});

test('late Refresh preserves a newer company scope and its conversation', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { holdCompanyRefresh: true });
  await page.goto('/chat');
  await expect(page.locator('.chat-thread-head')).toContainText('Orbit incident analysis');

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => state.heldCompanyGets).toBe(1);
  await page.getByLabel('Company', { exact: true }).selectOption('company-globex');
  await expect(page.locator('.chat-thread-head')).toContainText('Launch window');
  await page.getByPlaceholder('Message').fill('Katherine draft after refresh started');

  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);
  state.releaseCompanies();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('company-globex');
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('all');
  await expect(page.getByLabel('Project', { exact: true }).locator('option[value="project-globex"]')).toHaveText('Globex Launch');
  await expect(page.getByLabel('Project', { exact: true }).locator('option[value="project-orbit"]')).toHaveCount(0);
  await expect(page.getByLabel('Agent', { exact: true })).toHaveValue('agent-katherine');
  await expect(page.getByLabel('Agent', { exact: true }).locator('option[value="agent-ada"]')).toHaveCount(0);
  await expect(page.locator('.chat-thread-head')).toContainText('Katherine Johnson');
  await expect(page.locator('.chat-thread-head')).toContainText('Launch window');
  await expect(page.getByPlaceholder('Message')).toHaveValue('Katherine draft after refresh started');
  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);

  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Reply to: Katherine draft after refresh started')).toBeVisible();
  expect(state.messagePostSessionIds).toEqual(['session-katherine']);
});

test('Refresh falls back when the selected company disappears', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page);
  await page.goto('/chat');
  await expect(page.locator('.chat-thread-head')).toContainText('Orbit incident analysis');
  state.removeCompany('company-acme');

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('company-globex');
  await expect(page.getByLabel('Agent', { exact: true })).toHaveValue('agent-katherine');
  await expect(page.locator('.chat-thread-head')).toContainText('Launch window');
  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);
});

test('scoped sessions GET failure stays truthful and Retry only refetches that scope', async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { failSessionGetsForAgents: ['agent-grace'] });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect.poll(() => state.sessionGetCounts['agent-grace'] ?? 0, { timeout: 15_000 }).toBe(4);
  const readError = page.locator('.chat-error-row[role=alert]');
  await expect(readError).toContainText('Synthetic sessions read failure');
  await expect(page.getByText('No sessions')).toBeHidden();
  const failedReadCount = state.sessionGetCounts['agent-grace']!;
  state.recoverSessionGets('agent-grace');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.session-rail').getByRole('button', { name: /Compiler migration/ })).toBeVisible();
  expect(state.sessionGetCounts['agent-grace']).toBe(failedReadCount + 1);
  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);
  state.failSessionGets('agent-grace');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => state.sessionGetCounts['agent-grace'] ?? 0, { timeout: 15_000 }).toBe(failedReadCount + 5);
  await expect(readError).toContainText('Synthetic sessions read failure');
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-ada');
  await expect(readError).toBeHidden();
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);
});

test('initial history GET failure is distinct from an empty conversation and recovers', async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { failMessageGetsForSessions: ['session-ada-orbit'] });
  await page.goto('/chat');
  await expect(page.locator('.chat-thread-head')).toContainText('Orbit incident analysis');
  const composer = page.getByPlaceholder('Message');
  await composer.fill('Initial history recovery draft');
  await expect.poll(() => state.messageGetCounts['session-ada-orbit'] ?? 0, { timeout: 15_000 }).toBe(4);
  const readError = page.locator('.chat-error-row[role=alert]');
  await expect(readError).toContainText('Synthetic history read failure');
  await expect(page.locator('.chat-empty-state')).toBeHidden();
  state.recoverMessageGets('session-ada-orbit');
  const failedReadCount = state.messageGetCounts['session-ada-orbit']!;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await expect(readError).toBeHidden();
  await expect(composer).toHaveValue('Initial history recovery draft');
  expect(state.messageGetCounts['session-ada-orbit']).toBe(failedReadCount + 1);
  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);
});

test('selected history GET failure retains history and draft until scoped Retry recovers', async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page);
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  const composer = page.getByPlaceholder('Message');
  await composer.fill('History recovery draft');
  const initialReadCount = state.messageGetCounts['session-ada-orbit']!;
  state.failMessageGets('session-ada-orbit');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => state.messageGetCounts['session-ada-orbit'] ?? 0, { timeout: 15_000 }).toBe(initialReadCount + 4);
  const readError = page.locator('.chat-error-row[role=alert]');
  await expect(readError).toContainText('Synthetic history read failure');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await expect(page.locator('.chat-empty-state')).toBeHidden();
  await expect(composer).toHaveValue('History recovery draft');
  const failedReadCount = state.messageGetCounts['session-ada-orbit']!;
  state.recoverMessageGets('session-ada-orbit');
  state.appendMessage('session-ada-orbit', { id: 'history-recovered', sessionId: 'session-ada-orbit', companyId: 'company-acme', agentId: 'agent-ada', authorType: 'agent', body: 'Recovered selected history' });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Recovered selected history')).toBeVisible();
  await expect(readError).toBeHidden();
  await expect(composer).toHaveValue('History recovery draft');
  expect(state.messageGetCounts['session-ada-orbit']).toBe(failedReadCount + 1);
  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);
});

test('offscreen live history refresh failure is contained and recovers by session identity', async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1158, height: 844 });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const state = await mockChat(page);
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect(page.locator('.chat-thread-head')).toContainText('Compiler migration');
  state.appendMessage('session-ada-orbit', { id: 'live-recovered', sessionId: 'session-ada-orbit', companyId: 'company-acme', agentId: 'agent-ada', authorType: 'agent', body: 'Recovered offscreen live history' });
  state.failMessageGets('session-ada-orbit');
  const initialReadCount = state.messageGetCounts['session-ada-orbit']!;
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('megacorps-live', { detail: { type: 'chat.message.created', sessionId: 'session-ada-orbit' } }));
  });
  await expect.poll(() => state.messageGetCounts['session-ada-orbit'] ?? 0, { timeout: 15_000 }).toBe(initialReadCount + 1);
  await expect(page.locator('.chat-error-row[role=alert]')).toBeHidden();
  expect(pageErrors).toEqual([]);
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-ada');
  await expect.poll(() => state.messageGetCounts['session-ada-orbit'] ?? 0, { timeout: 15_000 }).toBe(initialReadCount + 5);
  const readError = page.locator('.chat-error-row[role=alert]');
  await expect(readError).toContainText('Synthetic history read failure');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await expect(page.getByText('Recovered offscreen live history')).toBeHidden();
  state.recoverMessageGets('session-ada-orbit');
  const failedReadCount = state.messageGetCounts['session-ada-orbit']!;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Recovered offscreen live history')).toBeVisible();
  await expect(readError).toBeHidden();
  expect(state.messageGetCounts['session-ada-orbit']).toBe(failedReadCount + 1);
  expect(pageErrors).toEqual([]);
  expect(state.sendAttempts).toBe(0);
  expect(state.sessionCreates).toEqual([]);
});

test('agentless company cannot retain old session history or draft', async ({ page }) => {
  await openChat(page);
  await page.getByPlaceholder('Message').fill('Ada private draft');
  await page.getByLabel('Company', { exact: true }).selectOption('company-empty');
  const oldSession = page.locator('.session-rail').getByRole('button', { name: /Orbit incident analysis/ });
  if (await oldSession.isVisible()) await oldSession.click();
  await expect.soft(oldSession).toBeHidden();
  await expect.soft(page.getByText('The orbital diagnostics are ready.')).toBeHidden();
  await expect.soft(page.getByPlaceholder('Message')).toHaveValue('');
  await expect(page.getByPlaceholder('Message')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

test('stream partials and completion remain owned by their session while another agent is busy', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { busyAgents: ['agent-ada', 'agent-grace'] });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await page.evaluate(() => {
    for (const detail of [
      { type: 'chat.reply.started', sessionId: 'session-ada-orbit' },
      { type: 'chat.reply.partial', sessionId: 'session-ada-orbit', data: { text: 'Ada secret partial' } },
    ]) window.dispatchEvent(new CustomEvent('megacorps-live', { detail }));
  });
  await expect(page.locator('.typing-bubble')).toContainText('Ada secret partial');
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect(page.locator('.chat-thread-head')).toContainText('Compiler migration');
  await expect(page.locator('.typing-bubble')).toBeVisible();
  await expect.soft(page.getByText('Ada secret partial')).toBeHidden();
  state.appendMessage('session-ada-orbit', { id: 'ada-stream-completed', sessionId: 'session-ada-orbit', companyId: 'company-acme', agentId: 'agent-ada', authorType: 'agent', body: 'Ada completed response' });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('megacorps-live', { detail: { type: 'chat.reply.partial', sessionId: 'session-ada-orbit', data: { text: 'Ada background partial' } } }));
    window.dispatchEvent(new CustomEvent('megacorps-live', { detail: { type: 'chat.reply.finished', sessionId: 'session-ada-orbit' } }));
  });
  await expect(page.locator('.typing-bubble')).toBeVisible();
  await expect(page.getByText('Ada completed response')).toBeHidden();
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-ada');
  await expect(page.getByText('Ada completed response')).toBeVisible();
  await expect(page.locator('.typing-bubble')).toBeHidden();
  await expect(page.getByText('Ada secret partial')).toBeHidden();
  await expect(page.getByText('Ada background partial')).toBeHidden();
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect(page.locator('.typing-bubble')).toBeVisible();
});

test('explicit New session failure retains selection and draft with scoped retry and no duplicates', async ({ page }) => {
  await page.setViewportSize({ width: 1158, height: 844 });
  const state = await mockChat(page, { failFirstCreate: true, sessionDelayMs: 400 });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await page.getByPlaceholder('Message').fill('Keep original session draft');
  const create = page.getByRole('button', { name: 'New session' });
  await create.click();
  await expect.soft(create).toBeDisabled();
  await expect(page.locator('.chat-error-row[role=alert]')).toContainText('Synthetic session creation failure');
  await expect(page.locator('.chat-thread-head')).toContainText('Orbit incident analysis');
  await expect(page.getByPlaceholder('Message')).toHaveValue('Keep original session draft');
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-grace');
  await expect(page.locator('.chat-error-row[role=alert]')).toBeHidden();
  await page.getByLabel('Agent', { exact: true }).selectOption('agent-ada');
  await expect(page.locator('.chat-error-row[role=alert]')).toContainText('Synthetic session creation failure');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(create).toBeDisabled();
  await expect(page.locator('.chat-thread-head')).toContainText('Chat with Ada Lovelace');
  expect(state.sessionCreates).toHaveLength(2);
  expect(state.sessionCreates[1]).toEqual(state.sessionCreates[0]);
  expect(state.sendAttempts).toBe(0);
  await expect(page.locator('.chat-error-row[role=alert]')).toBeHidden();
  await page.locator('.session-rail').getByRole('button', { name: /Orbit incident analysis/ }).click();
  await expect(page.getByPlaceholder('Message')).toHaveValue('Keep original session draft');
});

test('null-project session header identifies No project under All projects filter', async ({ page }) => {
  await openChat(page);
  await page.locator('.session-rail').getByRole('button', { name: /General architecture notes/ }).click();
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('all');
  await expect(page.locator('.chat-thread-head')).toContainText('No project');
  await expect(page.locator('.chat-thread-head')).not.toContainText('All projects');
});

test('narrow viewport height changes retain usable history composer focus and session navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockChat(page);
  await page.goto('/chat');
  const rail = page.locator('.session-rail');
  const composer = page.getByPlaceholder('Message');
  await expect(rail.getByRole('button', { name: /Orbit incident analysis/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle sidebar' })).toHaveAttribute('aria-expanded', 'false');
  const samples: unknown[] = [];
  for (const sidebarOpen of [false, true]) {
    await setSidebar(page, sidebarOpen);
    for (const height of [844, 520, 844]) {
      await expect(rail).toBeVisible();
      await rail.getByRole('button', { name: /Orbit incident analysis/ }).focus();
      await page.keyboard.press('Enter');
      await expect(rail).toBeHidden();
      await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
      await composer.focus();
      await composer.fill('Mobile composition');
      await composer.press('Shift+Enter');
      await expect(composer).toHaveValue('Mobile composition\n');
      await composer.dispatchEvent('compositionstart');
      await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
      await composer.dispatchEvent('compositionend', { data: '文' });
      expect(state.sendAttempts).toBe(0);
      await page.setViewportSize({ width: 390, height });
      await setSidebar(page, sidebarOpen);
      await expect(composer).toBeFocused();
      await page.locator('.chat-composer').scrollIntoViewIfNeeded();
      await setSidebar(page, sidebarOpen);
      const sample = await page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
        };
        return { viewportHeight: innerHeight, scrollY, documentWidth: document.documentElement.scrollWidth, history: box('.chat-messages'), composer: box('.chat-composer'), thread: box('.chat-thread'), sidebar: box('.sidebar'), main: box('main'), focused: document.activeElement?.getAttribute('aria-label') };
      });
      samples.push({ sidebarOpen, ...sample });
      expect(sample.documentWidth).toBe(390);
      expect(sample.history.height).toBeGreaterThanOrEqual(180);
      expect(Math.min(sample.history.bottom, height) - Math.max(sample.history.top, 0)).toBeGreaterThanOrEqual(180);
      expect(sample.composer.top).toBeGreaterThanOrEqual(0);
      expect(sample.composer.bottom).toBeLessThanOrEqual(height);
      expect(sample.main.top).toBeGreaterThanOrEqual(sample.sidebar.bottom - 1);
      await composer.press('Tab');
      await expect(page.getByRole('button', { name: 'Send message' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(composer).toBeFocused();
      await page.getByRole('button', { name: 'Sessions', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(rail).toBeVisible();
      await expect(page.locator('.chat-thread')).toBeHidden();
    }
  }
  writeFileSync(testInfo.outputPath('chat-mobile-height-focus-geometry.json'), JSON.stringify(samples, null, 2));
});

for (const width of [320, 390, 768, 900, 1158, 1440]) {
  test(`chat controls and reachable composer fit ${width}px in both sidebar states`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await mockChat(page);
    await page.goto('/chat');
    await expect(page.getByRole('heading', { name: 'Direct Chat', exact: true })).toBeVisible();
    if (width <= 760) {
      await expect(page.locator('.session-rail').getByRole('button', { name: /Orbit incident analysis/ })).toBeVisible();
      await page.locator('.session-rail').getByRole('button', { name: /Orbit incident analysis/ }).click();
    } else {
      await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
    }

    const samples: Array<Record<string, unknown>> = [];
    for (const sidebarOpen of [false, true]) {
      await setSidebar(page, sidebarOpen);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const composer = page.locator('.chat-composer');
      await composer.scrollIntoViewIfNeeded();
      await expect.poll(async () => {
        const box = await composer.boundingBox();
        return box ? box.y + box.height : 9999;
      }).toBeLessThanOrEqual(844);
      const controls = await page.locator('.chat-scope-controls select, .chat-thread button, .chat-composer textarea, .chat-composer button').evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).checkVisibility()).map((node) => {
        const box = node.getBoundingClientRect();
        return { label: node.getAttribute('aria-label'), left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      }));
      expect(controls.every((box) => box.left >= -1 && box.right <= width + 1)).toBe(true);
      if (width <= 900) {
        const sidebar = (await page.locator('.sidebar').boundingBox())!;
        const main = (await page.getByRole('main').boundingBox())!;
        expect(main.y).toBeGreaterThanOrEqual(sidebar.y + sidebar.height - 1);
      }
      const sessionBox = await page.locator('.session-rail').boundingBox();
      const threadBox = await page.locator('.chat-thread').boundingBox();
      if (width > 760) {
        expect(sessionBox?.width ?? 0).toBeGreaterThanOrEqual(220);
        expect(threadBox?.width ?? 0).toBeGreaterThanOrEqual(width === 768 ? 450 : 500);
      } else {
        expect(sessionBox).toBeNull();
        expect(threadBox?.width ?? 0).toBeGreaterThanOrEqual(width - 50);
      }
      samples.push({ width, sidebarOpen, documentWidth: await page.evaluate(() => document.documentElement.scrollWidth), sessionBox, threadBox, controls });
      if ((width === 390 || width === 1158) && sidebarOpen) await page.screenshot({ path: testInfo.outputPath(`chat-${width}-sidebar-open.png`), fullPage: true });
    }
    writeFileSync(testInfo.outputPath(`chat-${width}-geometry.json`), JSON.stringify(samples, null, 2));
  });
}


test('A2A accepted chat stays pending across reload and receives the polled reply once', async ({ page }) => {
  const state = await mockChat(page, { asyncA2a: true });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  const composer = page.getByPlaceholder('Message');
  await composer.fill('Run the durable task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(composer).toHaveValue('');
  await expect(page.locator('.typing-bubble')).toBeVisible();
  await composer.fill('Do not submit twice');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await composer.press('Enter');
  expect(state.sendAttempts).toBe(1);
  await page.reload();
  await expect(page.locator('.typing-bubble')).toBeVisible();
  state.finishJob('session-ada-orbit');
  await expect(page.getByText('The durable reply arrived.')).toHaveCount(1);
  await expect(page.locator('.typing-bubble')).toHaveCount(0);
  await page.getByPlaceholder('Message').fill('Next turn');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  expect(state.sendAttempts).toBe(1);
});

test('long-running A2A polling is bounded and reads the transcript only after completion', async ({ page }) => {
  test.setTimeout(20_000);
  const state = await mockChat(page, { asyncA2a: true });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  const initialMessageReads = state.messageGetCounts['session-ada-orbit'] ?? 0;
  await page.getByPlaceholder('Message').fill('Wait for the actual completion');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => state.jobGetCounts['session-ada-orbit'] ?? 0, { timeout: 12_000 }).toBeGreaterThanOrEqual(4);
  expect(state.messageGetCounts['session-ada-orbit']).toBe(initialMessageReads + 1);
  expect(state.sendAttempts).toBe(1);
  state.finishJob('session-ada-orbit');
  await expect(page.getByText('The durable reply arrived.')).toHaveCount(1);
  await expect.poll(() => state.messageGetCounts['session-ada-orbit'] ?? 0).toBe(initialMessageReads + 2);
  expect(state.sendAttempts).toBe(1);
});

test('transient job 429 honors Retry-After and retrieves completion without repost or reload', async ({ page }) => {
  const state = await mockChat(page, { asyncA2a: true, job429Count: 1 });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await page.getByPlaceholder('Message').fill('Recover the completion fetch');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => state.jobGetCounts['session-ada-orbit'] ?? 0).toBeGreaterThanOrEqual(2);
  state.finishJob('session-ada-orbit');
  await expect(page.getByText('The durable reply arrived.')).toHaveCount(1);
  await expect(page.locator('.typing-bubble')).toHaveCount(0);
  expect(state.sendAttempts).toBe(1);
});

test('terminal transcript 429 waits for Retry-After then shows completion without repost', async ({ page }) => {
  const state = await mockChat(page, { asyncA2a: true, completionMessage429Count: 1 });
  await page.goto('/chat');
  await expect(page.getByText('The orbital diagnostics are ready.')).toBeVisible();
  await page.getByPlaceholder('Message').fill('Retry the terminal transcript read');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  state.finishJob('session-ada-orbit');
  await expect(page.getByText('The durable reply arrived.')).toHaveCount(1, { timeout: 8_000 });
  expect(state.sendAttempts).toBe(1);
});

test('chat action protocol and legacy self-note text render as localized receipts', async ({ page }) => {
  const state = await mockChat(page, { locale: 'zh-TW' });
  state.appendMessage('session-ada-orbit', { id: 'action-protocol', sessionId: 'session-ada-orbit', companyId: 'company-acme', agentId: 'agent-ada', authorType: 'agent', body: '已加入工作。\n```json\n{"kind":"megacorps-chat-actions","actions":[{"action":"create_card","title":"Ship","body":"Acceptance: shipped"}]}\n```' });
  state.appendMessage('session-ada-orbit', { id: 'action-outcome', sessionId: 'session-ada-orbit', companyId: 'company-acme', agentId: 'agent-ada', authorType: 'system', body: 'Kanban updates from this conversation:\n✓ Self-note — noted: An English sentence sliced in the mid' });
  await page.goto('/chat');
  await expect(page.getByText('已加入工作。', { exact: true })).toBeVisible();
  await expect(page.getByText('已請求 1 項看板更新')).toBeVisible();
  await expect(page.getByText('看板更新：已儲存 1 則備註')).toBeVisible();
  await expect(page.getByText('原始記錄')).toHaveCount(2);
  await expect(page.locator('.chat-bubble details[open]')).toHaveCount(0);
  await expect(page.locator('.chat-bubble details pre')).toHaveCount(2);
});
