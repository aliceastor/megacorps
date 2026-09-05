import { expect, test, type Page } from '@playwright/test';
async function mockSetup(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  const state: any = {
    company: null,
    boss: null,
    head: null,
    department: null,
    runtimes: [],
    checks: false,
    creates: 0,
    bossCreates: 0,
    headCreates: 0,
    extraAgents: [],
    deletedAgentIds: [],
  };
  let rejectDepartment = true;
  await page.route('**/api/proxy/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/proxy', ''),
      body = req.postDataJSON();
    if (req.method() === 'GET' && path === state.failRead) {
      await route.fulfill({ status: 503, json: { error: 'temporary_load_failure', message: 'Temporary setup load unavailable. Retry shortly.' } });
      return;
    }
    let json: any = [],
      status = 200;
    if (path === '/api/me')
      json = {
        user: { id: 'operator', email: 'onboarding@example.test', role: 'admin' },
        memberships: state.company ? [{ companyId: 'company', role: 'admin' }] : [],
      };
    else if (path === '/api/company-setup') {
      if (!state.company) {
        state.creates++;
        state.company = { id: 'company', ...body, autoDispatchEnabled: false, setupDraft: { stage: 'boss' } };
      }
      json = { company: state.company, draft: state.company.setupDraft };
    } else if (path === '/api/companies/company/setup/probe') {
      state.checks = true;
      json = {
        results: [
          { agentId: 'boss', success: true },
          { agentId: 'head', success: true },
        ],
      };
    } else if (path === '/api/companies/company/setup') {
      if (req.method() === 'PUT') {
        if (['boss', 'head'].includes(body.step) && body.agentId && ![state.boss, state.head, ...state.extraAgents].filter(Boolean).some((a: any) => a.id === body.agentId)) {
          status = 400;
          json = { error: 'agent_company_mismatch' };
        } else if (body.step === 'department' && rejectDepartment && !state.prefilled) {
          rejectDepartment = false;
          status = 409;
          json = {
            error: 'setup_slug_taken',
            message: 'This slug is already used. Choose a different slug and save again.',
          };
        } else {
          if (body.step === 'boss') {
            if (!state.boss) state.bossCreates++;
            state.boss = { ...state.boss, id: state.boss?.id ?? (state.deletedAgentIds.includes('boss') ? 'replacement-boss' : 'boss'), companyId: 'company', ...body };
            state.company.setupDraft.stage = 'department';
          }
          if (body.step === 'department') {
            state.department = { ...state.department, id: 'department', ...body };
            state.company.setupDraft.stage = 'head';
          }
          if (body.step === 'head') {
            if (!state.head) state.headCreates++;
            state.head = { ...state.head, id: state.head?.id ?? (state.deletedAgentIds.includes('head') ? 'replacement-head' : 'head'), companyId: 'company', departmentId: 'department', ...body };
            state.department.headAgentId = state.head.id;
            state.company.setupDraft.stage = 'runtime';
          }
          if (body.step === 'runtime') {
            let runtime = state.runtimes.find((r: any) => r.id === body.runtimeId || body.runtimeCreateKey && r.createKey === body.runtimeCreateKey);
            if (!runtime) {
              runtime = { id: state.runtimes.length ? `runtime-${state.runtimes.length}` : 'runtime', companyId: 'company', name: body.name, adapterType: 'a2a', createKey: body.runtimeCreateKey, config: { a2aBaseUrl: body.a2aBaseUrl } };
              state.runtimes.push(runtime);
            }
            state.boss.runtimeId = state.head.runtimeId = runtime.id;
            state.boss.adapterType = state.head.adapterType = runtime.adapterType;
            state.company.setupDraft.runtimeId = runtime.id;
            state.checks = false;
          }
          if (body.step === 'reopen') { state.company.setupDraft.stage = 'company'; state.checks = false; }
          if (body.step !== 'finish') { state.company.setupDraft.completed = false; state.company.autoDispatchEnabled = false; }
          if (body.step === 'finish') {
            if (!state.checks) {
              status = 409;
              json = { error: 'setup_not_ready' };
            } else {
              state.company.autoDispatchEnabled = true;
              state.company.setupDraft.completed = true;
              state.company.setupDraft.stage = 'complete';
            }
          }
        }
      }
      if (status === 200)
        json = {
          company: state.company,
          draft: state.company.setupDraft,
          boss: state.boss,
          head: state.head,
          department: state.department,
          readiness: {
            ready: Boolean(state.boss?.runtimeId),
            structureReady: Boolean(state.head),
            issues: [],
            runtimeIssues: [],
          },
          connectionIssues: state.checks ? [] : ['Check the current runtime connection.'],
          status: !state.company.setupDraft.completed ? 'draft' : !state.checks ? 'needs_attention' : state.company.autoDispatchEnabled ? 'ready' : 'dispatch_disabled',
        };
    } else if (path === '/api/companies') json = state.company ? [state.company] : [];
    else if (path === '/api/agents') json = [state.boss, state.head, ...state.extraAgents].filter(Boolean);
    else if (path.startsWith('/api/agents/') && req.method() === 'DELETE') {
      const id = path.split('/').at(-1);
      state.deletedAgentIds.push(id);
      for (const role of ['boss', 'head']) if (state[role]?.id === id) state[role] = null;
      state.checks = false;
      json = { ok: true };
    }
    else if (path === '/api/departments') json = state.department ? [state.department] : [];
    else if (path === '/api/agent-runtimes') json = state.runtimes;
    else if (path.startsWith('/api/agent-runtimes/') && req.method() === 'PUT') {
      const runtime = state.runtimes.find((r: any) => path.endsWith(`/${r.id}`));
      Object.assign(runtime, body); json = runtime;
    }
    else if (path.endsWith('/test-connection')) {
      json = { success: true, needsInput: Boolean(state.executionNeedsInput) };
      if (!state.executionNeedsInput) state.checks = true;
    }
    else if (path.includes('execution-readiness'))
      json = { ready: false, issues: [], setupIssues: [], runtimeIssues: [] };
    else if (path.includes('/api/notifications')) json = { notifications: [], unreadCount: 0 };
    await route.fulfill({ status, json });
  });

  await page.goto('/companies');
  return state;
}

async function savedSetup(page: Page, adapterType = 'a2a', completed = false) {
  const state = await mockSetup(page, 1158);
  state.prefilled = true;
  state.company = { id: 'company', name: 'Saved studio', slug: 'saved', autoDispatchEnabled: completed, setupDraft: { stage: 'runtime', completed, runtimeId: 'shared' } };
  state.boss = { id: 'boss', companyId: 'company', name: 'Boss', slug: 'boss', runtimeId: 'shared', adapterType };
  state.head = { id: 'head', companyId: 'company', name: 'Head', slug: 'head', departmentId: 'department', runtimeId: 'shared', adapterType };
  state.department = { id: 'department', name: 'Team', slug: 'team', headAgentId: 'head' };
  state.runtimes = [{ id: 'shared', name: 'Shared runtime', companyId: 'company', adapterType, config: { a2aBaseUrl: 'https://shared.example.test', preserve: 'synthetic' } }];
  await page.goto('/companies?setup=company');
  return state;
}

for (const failedRead of ['/api/agents', '/api/companies/company/setup']) test(`failed hydration ${failedRead} preserves cache and retries with fresh identities`, async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const state = await savedSetup(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByLabel('Department head name', { exact: true }).fill('Unsaved head name');
  await page.getByText('Optional role customization', { exact: true }).click();
  await page.locator('.company-setup details textarea').fill('Unsaved head instructions');
  const cache = () => page.evaluate(() => localStorage.getItem('megacorps.company-setup.operator.company'));
  await expect.poll(async () => JSON.parse((await cache()) ?? '{}').fields?.headPrompt).toBe('Unsaved head instructions');
  const before = await cache();
  state.failRead = failedRead;
  await page.reload();
  await expect(page.getByLabel('Department head name', { exact: true })).toHaveValue('Unsaved head name');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  expect(await cache()).toBe(before);
  await expect(page.getByRole('region', { name: 'Set up your company', exact: true }).getByRole('alert')).toContainText('Temporary setup load unavailable', { timeout: 20_000 });
  expect(await cache()).toBe(before);
  await expect(page.getByLabel('Department head name', { exact: true })).toHaveValue('Unsaved head name');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Choose an existing agent', exact: true })).toHaveValue('head');
  await expect(page.locator('.company-setup details textarea')).toHaveValue('Unsaved head instructions');
  await page.screenshot({ path: testInfo.outputPath(`load-error-${failedRead === '/api/agents' ? 'agents' : 'setup'}.png`), fullPage: true });
  state.head = null;
  state.deletedAgentIds.push('head');
  state.failRead = undefined;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Department head name', { exact: true })).toHaveValue('Unsaved head name');
  await expect(page.getByRole('combobox', { name: 'Choose an existing agent', exact: true })).toHaveValue('');
  await expect.poll(async () => JSON.parse((await cache()) ?? '{}').fields?.headAgentId).toBe('');
  const recovered = JSON.parse((await cache())!);
  const original = JSON.parse(before!);
  expect(recovered).toEqual({ ...original, fields: { ...original.fields, headAgentId: '' } });
});

test('failed post-save refresh keeps the current draft unresolved until retry', async ({ page }) => {
  const state = await savedSetup(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByLabel('Department head name', { exact: true }).fill('Saved despite refresh failure');
  const cache = () => page.evaluate(() => localStorage.getItem('megacorps.company-setup.operator.company'));
  await expect.poll(async () => JSON.parse((await cache()) ?? '{}').fields?.headName).toBe('Saved despite refresh failure');
  const before = await cache();
  state.failRead = '/api/companies/company/setup';
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Set up your company', exact: true }).getByRole('alert')).toContainText('Temporary setup load unavailable');
  expect(state.head.name).toBe('Saved despite refresh failure');
  expect(await cache()).toBe(before);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  state.failRead = undefined;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  expect(await cache()).toBe(before);
  expect(state.headCreates).toBe(0);
});

test('companyless hydration failure preserves its draft and creation key until retry succeeds', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const state = await mockSetup(page, 390);
  await page.getByLabel('Company name', { exact: true }).fill('Unsaved first company');
  await page.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Unsaved first purpose');
  const cache = () => page.evaluate(() => localStorage.getItem('megacorps.company-setup.operator.new'));
  await expect.poll(async () => JSON.parse((await cache()) ?? '{}').fields?.mission).toBe('Unsaved first purpose');
  const before = await cache();
  state.failRead = '/api/agents';
  await page.reload();
  await expect(page.getByRole('region', { name: 'Set up your company', exact: true }).getByRole('alert')).toContainText('Temporary setup load unavailable', { timeout: 20_000 });
  expect(await cache()).toBe(before);
  await expect(page.getByLabel('Company name', { exact: true })).toHaveValue('Unsaved first company');
  await expect(page.getByRole('button', { name: 'Save and continue', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('load-error-companyless.png'), fullPage: true });
  expect(state.creates).toBe(0);
  state.failRead = undefined;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save and continue', exact: true })).toBeEnabled();
  expect(await cache()).toBe(before);
  const sent = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/company-setup'));
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  expect((await sent).postDataJSON().setupKey).toBe(JSON.parse(before!).setupKey);
  await expect.poll(() => state.creates).toBe(1);
});

for (const role of ['head', 'boss']) test(`cached deleted ${role} can be replaced without losing draft text or duplicating agents`, async ({ page }, testInfo) => {
  const state = await savedSetup(page);
  await page.getByRole('button', { name: 'Check connection (no task execution)', exact: true }).click();
  await page.getByRole('button', { name: 'Finish and enable dispatch', exact: true }).click();
  await expect(page.getByText('Setup complete. Automatic dispatch is enabled.', { exact: true })).toBeVisible();
  await page.reload();
  const cached = () => page.evaluate(() => JSON.parse(localStorage.getItem('megacorps.company-setup.operator.company') ?? '{}'));
  await expect.poll(async () => (await cached()).fields?.[`${role}AgentId`]).toBe(role);
  const runtimeCreateKey = (await cached()).fields.runtimeCreateKey;
  await page.evaluate(id => fetch(`/api/proxy/api/agents/${id}`, { method: 'DELETE' }).then(r => r.json()), role);
  await page.reload();
  await page.getByRole('button', { name: 'Reopen setup and pause dispatch', exact: true }).click();
  const next = () => page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await next();
  if (role === 'head') {
    await next();
    await page.getByRole('textbox', { name: 'Department charter', exact: true }).fill('Unsaved repair charter');
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Department charter', exact: true })).toHaveValue('Unsaved repair charter');
    await next();
  }
  const name = role === 'head' ? 'Department head name' : 'Boss name';
  await page.getByLabel(name, { exact: true }).fill('Replacement agent');
  await page.getByText('Optional role customization', { exact: true }).click();
  const prompt = page.locator('.company-setup details textarea');
  await prompt.fill('Unsaved repair prompt');
  await page.reload();
  await expect(page.getByLabel(name, { exact: true })).toHaveValue('Replacement agent');
  await page.getByText('Optional role customization', { exact: true }).click();
  await expect(prompt).toHaveValue('Unsaved repair prompt');
  const selection = page.getByRole('combobox', { name: 'Choose an existing agent', exact: true });
  await expect(selection).toHaveValue('');
  await expect(selection.locator('option').first()).toHaveText('Create a new agent');
  await page.screenshot({ path: testInfo.outputPath(`replace-deleted-${role}.png`), fullPage: true });
  const sent = page.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith('/setup'));
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  expect((await sent).postDataJSON().agentId).toBeUndefined();
  await expect.poll(() => state[role]?.id).toBe(`replacement-${role}`);
  await page.reload();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  expect(state[`${role}Creates`]).toBe(1);
  expect(state[role === 'head' ? 'boss' : 'head'].id).toBe(role === 'head' ? 'boss' : 'head');
  expect(state.department.id).toBe('department');
  expect(state.company.id).toBe('company');
  expect((await cached()).fields.runtimeCreateKey).toBe(runtimeCreateKey);
  expect((await cached()).fields[`${role}AgentId`]).toBe(`replacement-${role}`);
});

test('a live dirty agent choice survives refresh while its text remains unsaved', async ({ page }) => {
  const state = await savedSetup(page);
  await expect(page.getByRole('button', { name: 'Save runtime', exact: true })).toBeVisible();
  state.head = null;
  state.extraAgents = [{ id: 'employee', companyId: 'company', name: 'Employee', slug: 'employee' }];
  await page.reload();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const selection = page.getByRole('combobox', { name: 'Choose an existing agent', exact: true });
  await selection.selectOption('employee');
  await page.getByLabel('Department head name', { exact: true }).fill('Unsaved employee name');
  await page.reload();
  await expect(selection).toHaveValue('employee');
  await expect(page.getByLabel('Department head name', { exact: true })).toHaveValue('Unsaved employee name');
});

for (const mode of ['a2a', 'codex-app-server']) test(`Add A2A after ${mode} uses a persisted creation key`, async ({ page }) => {
  const state = await savedSetup(page, mode);
  const before = structuredClone(state.runtimes[0]);
  await page.getByRole('button', { name: 'Save runtime', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save runtime', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Choose runtime', exact: true }).selectOption('');
  await page.getByLabel('Runtime name', { exact: true }).fill('Distinct A2A');
  await page.getByLabel('A2A URL', { exact: true }).fill('https://new.example.test');
  await page.reload();
  const sent = page.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith('/setup'));
  await page.getByRole('button', { name: 'Save runtime', exact: true }).click();
  expect((await sent).postDataJSON().runtimeCreateKey).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole('combobox', { name: 'Choose runtime', exact: true })).toHaveValue('runtime-1');
  expect(state.runtimes).toHaveLength(2);
  expect(state.runtimes[0]).toEqual(before);
});

test('input-required execution is actionable rather than successful', async ({ page }) => {
  const state = await savedSetup(page);
  state.executionNeedsInput = true;
  await page.getByRole('button', { name: 'Run connection test (may incur cost)', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Set up your company', exact: true }).getByRole('alert')).toContainText('requires input');
  await expect(page.getByRole('button', { name: 'Finish and enable dispatch', exact: true })).toBeDisabled();
});

test('same-mode A2A configuration has Settings guidance and draft context', async ({ page }) => {
  await savedSetup(page);
  await expect(page.getByRole('link', { name: /A2A bearer tokens and agent\/profile paths/ })).toHaveAttribute('href', '/settings?setup=company&runtime=shared');
});

test('completed setup repairs current state, visits A2A Settings and reports input-required execution', async ({ page }, testInfo) => {
  const state = await savedSetup(page, 'a2a', true);
  state.executionNeedsInput = true;
  const complete = page.getByText('Setup complete. Automatic dispatch is enabled.', { exact: true });
  await expect(page.getByText('The current setup needs attention. Reopen it to pause dispatch and repair the existing company and agents.', { exact: true })).toBeVisible();
  await expect(complete).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('completed-needs-repair.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reopen setup and pause dispatch', exact: true }).click();
  await expect.poll(() => state.company.autoDispatchEnabled).toBe(false);
  for (let step = 0; step < 4; step++) await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  const settings = page.getByRole('link', { name: /A2A bearer tokens and agent\/profile paths/ });
  await expect(settings).toHaveAttribute('href', '/settings?setup=company&runtime=shared');
  await settings.click();
  await expect(page.getByLabel('A2A bearer token', { exact: true })).toBeVisible();
  await page.getByLabel('A2A bearer token', { exact: true }).fill('synthetic-bearer');
  await page.getByLabel('A2A agent path', { exact: true }).fill('/profile');
  await page.getByRole('button', { name: 'Save runtime', exact: true }).click();
  await expect.poll(() => state.runtimes[0].config.a2aAgentPath).toBe('/profile');
  await page.getByRole('link', { name: 'Return to company setup', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Choose runtime', exact: true })).toHaveValue('shared');
  await page.getByRole('button', { name: 'Run connection test (may incur cost)', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Set up your company', exact: true }).getByRole('alert')).toContainText('requires input');
  await expect(page.getByText('Both execution tests succeeded.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Finish and enable dispatch', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('repair-execution-needs-input.png'), fullPage: true });
  state.executionNeedsInput = false;
  await page.getByRole('button', { name: 'Run connection test (may incur cost)', exact: true }).click();
  await page.getByRole('button', { name: 'Finish and enable dispatch', exact: true }).click();
  await expect(complete).toBeVisible();
  expect(state.bossCreates + state.headCreates + state.creates).toBe(0);
  state.company.autoDispatchEnabled = false;
  await page.reload();
  await expect(complete).toHaveCount(0);
  await expect(page.getByText('Automatic dispatch is currently disabled.', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('completed-dispatch-disabled.png'), fullPage: true });
});
for (const width of [390, 1158])
  test(`${width}px setup resumes without duplicates and requires a live check`, async ({
    page,
  }, testInfo) => {
    const state = await mockSetup(page, width),
      next = () => page.getByRole('button', { name: 'Save and continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set up your company', exact: true })).toBeVisible();
    await page.getByLabel('Company name', { exact: true }).fill('Beginner Studio');
    await page.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Create useful tools');
    await next();
    await page.getByLabel('Boss name', { exact: true }).fill('Strategy Boss');
    await next();
    await page.getByLabel('Department name', { exact: true }).fill('Product');
    await page
      .getByRole('textbox', { name: 'Department charter', exact: true })
      .fill('Deliver working products');
    await next();
    await expect(
      page.getByRole('region', { name: 'Set up your company', exact: true }).getByRole('alert'),
    ).toContainText('Choose a different slug');
    await expect(page.getByRole('textbox', { name: 'Department charter', exact: true })).toHaveValue(
      'Deliver working products',
    );
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Department charter', exact: true })).toHaveValue(
      'Deliver working products',
    );
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByLabel('Boss name', { exact: true })).toHaveValue('Strategy Boss');
    await next();
    await page.getByLabel('Department slug', { exact: true }).fill('product-team');
    await next();
    await page.getByLabel('Department head name', { exact: true }).fill('Product Head');
    await next();
    const finish = page.getByRole('button', { name: 'Finish and enable dispatch', exact: true });
    await expect(finish).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`runtime-unready-${width}.png`), fullPage: true });
    await page.getByLabel('Runtime name', { exact: true }).fill('A2A');
    await page.getByLabel('A2A URL', { exact: true }).fill('https://runtime.example.test');
    await page.getByRole('button', { name: 'Save runtime', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Choose runtime', exact: true })).toHaveValue('runtime');
    await expect(page.getByRole('button', { name: 'Check connection (no task execution)', exact: true })).toBeEnabled();
    await expect(finish).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`runtime-configured-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Check connection (no task execution)', exact: true }).click();
    await finish.click();
    await expect(
      page.getByText('Setup complete. Automatic dispatch is enabled.', { exact: true }),
    ).toBeVisible();
    expect(state.creates).toBe(1);
    expect(state.bossCreates).toBe(1);
    expect(state.headCreates).toBe(1);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    if (width === 390) {
      await page.getByRole('button', { name: 'Toggle sidebar' }).click();
      await expect
        .poll(async () => {
          const a = await page.locator('.sidebar').boundingBox(),
            b = await page.getByRole('main').boundingBox();
          return Boolean(a && b && b.y >= a.y + a.height - 1);
        })
        .toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath(`setup-${width}.png`), fullPage: true });
  });
