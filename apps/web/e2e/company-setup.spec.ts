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
  };
  let rejectDepartment = true;
  await page.route('**/api/proxy/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/proxy', ''),
      body = req.postDataJSON();
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
        if (body.step === 'department' && rejectDepartment) {
          rejectDepartment = false;
          status = 409;
          json = {
            error: 'setup_slug_taken',
            message: 'This slug is already used. Choose a different slug and save again.',
          };
        } else {
          if (body.step === 'boss') {
            if (!state.boss) state.bossCreates++;
            state.boss = { id: 'boss', ...body };
            state.company.setupDraft.stage = 'department';
          }
          if (body.step === 'department') {
            state.department = { id: 'department', ...body };
            state.company.setupDraft.stage = 'head';
          }
          if (body.step === 'head') {
            if (!state.head) state.headCreates++;
            state.head = { id: 'head', departmentId: 'department', ...body };
            state.company.setupDraft.stage = 'runtime';
          }
          if (body.step === 'runtime') {
            state.runtimes = [{ id: 'runtime', companyId: 'company', name: 'A2A', adapterType: 'a2a' }];
            state.boss.runtimeId = state.head.runtimeId = 'runtime';
            state.boss.adapterType = state.head.adapterType = 'a2a';
            state.company.setupDraft.runtimeId = 'runtime';
          }
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
        };
    } else if (path === '/api/companies') json = state.company ? [state.company] : [];
    else if (path === '/api/agents') json = [state.boss, state.head].filter(Boolean);
    else if (path === '/api/departments') json = state.department ? [state.department] : [];
    else if (path === '/api/agent-runtimes') json = state.runtimes;
    else if (path.includes('execution-readiness'))
      json = { ready: false, issues: [], setupIssues: [], runtimeIssues: [] };
    else if (path.includes('/api/notifications')) json = { notifications: [], unreadCount: 0 };
    await route.fulfill({ status, json });
  });
  await page.goto('/companies');
  return state;
}
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
