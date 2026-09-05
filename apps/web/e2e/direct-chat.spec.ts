import { expect, test, type Page, type Route } from '@playwright/test';
import { writeFileSync } from 'node:fs';

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

async function mockChat(page: Page, options: { failFirstSend?: boolean; sendDelayMs?: number; sessionDelayMs?: number; locale?: 'en' | 'zh-TW' | 'ja' } = {}) {
  const messageStore = Object.fromEntries(Object.entries(messages).map(([sessionId, rows]) => [sessionId, rows.map((row) => ({ ...row }))])) as typeof messages;
  const sessionStore = sessions.map((session) => ({ ...session }));
  const state = {
    sendAttempts: 0,
    sentBodies: [] as string[],
    messagePostSessionIds: [] as string[],
    sessionCreates: [] as Array<Record<string, unknown>>,
    appendMessage(sessionId: string, message: Record<string, unknown>) {
      messageStore[sessionId] = [...(messageStore[sessionId] ?? []), message];
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
    if (path === '/api/companies') return fulfillJson(route, companies);
    if (path === '/api/projects') return fulfillJson(route, projects);
    if (path === '/api/agents') return fulfillJson(route, agents);
    if (path === '/api/chat/sessions' && request.method() === 'GET') {
      const companyId = url.searchParams.get('companyId');
      const agentId = url.searchParams.get('agentId');
      const projectId = url.searchParams.get('projectId');
      return fulfillJson(route, sessionStore.filter((session) => session.companyId === companyId
        && session.agentId === agentId
        && (!projectId || (projectId === 'none' ? session.projectId === null : session.projectId === projectId))));
    }
    if (path === '/api/chat/sessions' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.sessionCreates.push(body);
      if (options.sessionDelayMs) await new Promise((resolve) => setTimeout(resolve, options.sessionDelayMs));
      const session = { id: `created-session-${state.sessionCreates.length}`, status: 'active', createdAt: '2026-09-05T12:04:00.000Z', updatedAt: '2026-09-05T12:04:00.000Z', ...body } as typeof sessions[number];
      sessionStore.unshift(session);
      messageStore[session.id] = [];
      return fulfillJson(route, session, 201);
    }
    const messageMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
    if (messageMatch && request.method() === 'GET') return fulfillJson(route, messageStore[messageMatch[1]!] ?? []);
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
}

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
      const controls = await page.locator('.chat-scope-controls select, .chat-thread button, .chat-composer textarea, .chat-composer button').evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).checkVisibility()).map((node) => {
        const box = node.getBoundingClientRect();
        return { label: node.getAttribute('aria-label'), left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      }));
      expect(controls.every((box) => box.left >= -1 && box.right <= width + 1)).toBe(true);
      const composer = page.locator('.chat-composer');
      await composer.scrollIntoViewIfNeeded();
      await expect.poll(async () => {
        const box = await composer.boundingBox();
        return box ? box.y + box.height : 9999;
      }).toBeLessThanOrEqual(844);
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
