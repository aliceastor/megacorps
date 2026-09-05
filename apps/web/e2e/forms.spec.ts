import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
let geometrySequence = 0;

const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const projectA = '33333333-3333-4333-8333-333333333333';
const projectB = '44444444-4444-4444-8444-444444444444';
const head = '55555555-5555-4555-8555-555555555555';
const reviewer = '66666666-6666-4666-8666-666666666666';
const department = '77777777-7777-4777-8777-777777777777';
const cardId = '88888888-8888-4888-8888-888888888888';

async function fixture(page: Page, path = '/projects', width = 1158) {
  const writes: { path: string; method: string; body: any }[] = [];
  const projects: any[] = [{ id: projectA, companyId: companyA, name: 'Project Alpha', repoUrl: `https://example.test/${'long-repository-'.repeat(12)}`, publishRepoUrl: 'https://example.test/publish-alpha', publishToken: '[redacted]', setupCommand: 'echo setup-alpha', testCommand: 'echo test-alpha', runtimeServices: { web: 'http://localhost:3000' }, completionRequiresMerge: true, autoMergeAfterApproval: true, mergeReadiness: { ready: false, issues: ['Protection requires setup'] } }];
  const goals: any[] = [];
  const cards: any[] = [{ id: cardId, companyId: companyA, title: 'Existing card', body: 'A plain request', assigneeId: head, reviewerId: reviewer, requiresApproval: true, priority: 0, columnStatus: 'todo', tags: [], maxRetries: 7, dependencyCardIds: [], reviewerIds: [], updatedAt: '2026-09-05T00:00:00.000Z' }];
  let failNext = false;
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('locale', 'en'); localStorage.setItem('megacorps.sidebarOpen', 'true'); });
  await page.route('**/api/proxy/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const apiPath = url.pathname.replace('/api/proxy', '');
    if (request.method() !== 'GET') {
      const body = request.postDataJSON(); writes.push({ path: apiPath, method: request.method(), body });
      if (failNext) { failNext = false; return route.fulfill({ status: 400, json: { error: 'Synthetic validation failure' } }); }
      if (apiPath === '/api/projects') { const row = { ...body, id: projectB }; projects.push(row); return route.fulfill({ status: 201, json: row }); }
      if (apiPath === '/api/goals') { const row = { ...body, id: 'goal-added' }; goals.push(row); return route.fulfill({ status: 201, json: row }); }
      if (apiPath === `/api/cards/${cardId}`) { Object.assign(cards[0], body); return route.fulfill({ json: cards[0] }); }
      if (apiPath.endsWith('/work-products')) return route.fulfill({ status: 201, json: { ...body, id: 'product-added' } });
      return route.fulfill({ status: 200, json: { ...body, id: apiPath.split('/').at(-1) } });
    }
    let json: any = [];
    if (apiPath === '/api/me') json = { user: { email: 'forms@example.test', role: 'admin' } };
    if (apiPath === '/api/companies') json = [{ id: companyA, name: 'Company Alpha' }, { id: companyB, name: 'Company Beta' }];
    if (apiPath === '/api/projects') json = projects.filter(p => !url.searchParams.get('companyId') || p.companyId === url.searchParams.get('companyId'));
    if (apiPath === '/api/goals') json = goals;
    if (apiPath === '/api/cards') json = cards;
    if (apiPath === '/api/departments') json = [{ id: department, companyId: companyA, name: 'Engineering', slug: 'engineering', headAgentId: head, description: 'Build useful things' }];
    if (apiPath === '/api/agents') json = [{ id: head, companyId: companyA, departmentId: department, name: 'Head Alpha', role: 'head', isActive: true }, { id: reviewer, companyId: companyA, name: 'Reviewer Alpha', role: 'employee', isActive: true }, { id: 'foreign-agent', companyId: companyB, name: 'Foreign Agent', role: 'head' }];
    if (apiPath.includes('/notifications')) json = { notifications: [], unreadCount: 0 };
    if (apiPath === '/api/dashboard') json = { stats: { companies: 2 }, stages: { todo: 2 }, recentTaskLogs: [{ id: 'log', type: 'run', status: 'success', message: 'Long message ' + 'unbroken'.repeat(70) }], recentApiEvents: [{ id: 'api', method: 'GET', path: '/api/' + 'longpath'.repeat(70) }] };
    if (apiPath === '/api/dashboard/timeseries') json = { points: [{ day: '2026-09-05', costUsd: 1, completed: 1, runs: 1, failedRuns: 0 }] };
    await route.fulfill({ json });
  });
  await page.goto(path);
  await expect(page.locator('.user-btn span')).toHaveText('forms@example.test');
  return { writes, fail: () => { failNext = true; } };
}

async function geometry(page: Page, selector: string) {
  let lastBounds = ''; let stableSamples = 0;
  await expect.poll(async () => {
    const bounds = await page.locator(selector).evaluateAll(nodes => JSON.stringify(nodes.filter(node => (node as HTMLElement).checkVisibility()).map(node => { const b = node.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(value => Math.round(value * 100) / 100); })));
    stableSamples = bounds === lastBounds ? stableSamples + 1 : 0;
    lastBounds = bounds;
    return stableSamples;
  }, { intervals: [100], message: 'Wait for three stable layout samples after transitions' }).toBeGreaterThanOrEqual(3);
  await expect.poll(() => page.evaluate(selector => {
    const violations: string[] = [];
    for (const node of document.querySelectorAll<HTMLElement>(selector)) {
      if (!node.checkVisibility() || node.closest('.table-wrap')) continue;
      const b = node.getBoundingClientRect();
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches('.table-wrap')) break;
        const p = parent.getBoundingClientRect(); const css = getComputedStyle(parent);
        if ((parent.matches('.project-section,.project-editor-panel,.modal,.section-card') || /hidden|auto|scroll|clip/.test(css.overflowX)) && (b.left < p.left - 1 || b.right > p.right + 1)) violations.push(`${node.tagName}:${node.closest('label')?.textContent?.slice(0, 35)} outside ${parent.className}`);
      }
      if (b.left < -1 || b.right > innerWidth + 1) violations.push(`${node.tagName} outside viewport`);
    }
    if (document.documentElement.scrollWidth > innerWidth) violations.push('document overflow');
    return violations;
  }, selector), { message: 'Every visible control fits its panel and clipping ancestors after transitions' }).toEqual([]);
  const measurements = await page.evaluate(selector => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, controls: [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.checkVisibility() && !node.closest('.table-wrap')).map(node => { const box = node.getBoundingClientRect(); return { tag: node.tagName, label: node.getAttribute('aria-label') || node.closest('label')?.firstChild?.textContent?.trim(), x: box.x, y: box.y, width: box.width, height: box.height }; }) }), selector);
  writeFileSync(test.info().outputPath(`geometry-${geometrySequence++}.json`), JSON.stringify(measurements, null, 2));
}

for (const width of [320, 390, 768, 900, 1158, 1440]) test(`project controls fit ${width}px in both sidebar states`, async ({ page }, info) => {
  await fixture(page, '/projects', width);
  await page.getByRole('button', { name: /^Project Alpha/ }).click();
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Project Alpha');
  if (width === 1158) await page.screenshot({ path: info.outputPath('projects-basic-1158.png') });
  for (const details of await page.locator('.project-editor-panel details').all()) await details.locator(':scope > summary').click();
  for (let state = 0; state < 2; state++) {
    await geometry(page, '.project-console input,.project-console textarea,.project-console select,.project-console button');
    await page.screenshot({ path: info.outputPath(`projects-${width}-${state}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  }
});

test('new project and company switch clear publishing credentials while unrelated edits preserve them', async ({ page }) => {
  const { writes } = await fixture(page);
  await page.getByRole('button', { name: /^Project Alpha/ }).click();
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Unrelated update');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ publishToken: '[redacted]', publishRepoUrl: 'https://example.test/publish-alpha', setupCommand: 'echo setup-alpha' });
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByLabel('Publish token', { exact: true }).fill('SYNTHETIC-NOT-A-CREDENTIAL-ALPHA');
  await page.getByRole('button', { name: /^New project/ }).click();
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Project Beta');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body).toMatchObject({ publishToken: null, publishRepoUrl: null });
  await page.getByRole('button', { name: /^Project Alpha/ }).click();
  await page.getByRole('textbox', { name: 'Publish token', exact: true }).fill('SYNTHETIC-NOT-A-CREDENTIAL-COMPANY');
  await page.getByRole('combobox', { name: 'Company', exact: true }).selectOption(companyB);
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Company Beta Project');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2].body).toMatchObject({ companyId: companyB, publishToken: null, publishRepoUrl: null });
});

test('goal body occupies a separate row and goal editing survives validation errors', async ({ page }, info) => {
  const { writes, fail } = await fixture(page, '/projects', 1440);
  await page.getByRole('button', { name: /^Project Alpha/ }).click();
  const title = page.getByRole('textbox', { name: 'Goal title', exact: true }); const body = page.getByRole('textbox', { name: 'Goal body', exact: true });
  const titleBox = (await title.boundingBox())!; const bodyBox = (await body.boundingBox())!;
  expect(bodyBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
  await expect(title).toHaveAttribute('maxlength', '160'); await expect(body).toHaveAttribute('maxlength', '4000');
  await title.fill('Ship a usable result'); await body.fill('People can complete their work on a phone.');
  await page.locator('.project-section').filter({ has: page.getByRole('heading', { name: 'Project Goals' }) }).screenshot({ path: info.outputPath('goal-fields.png') });
  fail(); await page.getByRole('button', { name: 'Add project goal' }).click();
  await expect(page.getByText('Synthetic validation failure')).toBeVisible();
  await expect(title).toHaveValue('Ship a usable result'); await expect(body).toHaveValue('People can complete their work on a phone.');
  await body.fill('People can complete their work on any screen.');
  await page.getByRole('button', { name: 'Add project goal' }).click();
  await expect(page.locator('.table-list').getByText('Ship a usable result')).toBeVisible();
  expect(writes.at(-1)?.body).toEqual({ companyId: companyA, projectId: projectA, title: 'Ship a usable result', body: 'People can complete their work on any screen.' });
});

test('project advanced controls start hidden and saving enables goals immediately', async ({ page }) => {
  const { writes } = await fixture(page);
  await expect(page.getByLabel('Setup command', { exact: true })).toBeHidden();
  await expect(page.getByText(/Save or select a project before adding goals|Save the project first/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Saved first');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Goal title', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Goal title', exact: true }).fill('New project goal');
  await page.getByRole('button', { name: 'Add project goal' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body.projectId).toBe(projectB);
});

test('department charter is directly below head in create and settings forms', async ({ page }) => {
  await fixture(page, '/departments', 1440);
  for (const create of [false, true]) {
    if (create) await page.getByRole('button', { name: 'New Department', exact: true }).click();
    const panel = create ? page.getByRole('dialog') : page.locator('.section-card').filter({ has: page.getByRole('heading', { name: 'Department settings', exact: true }) });
    const headField = panel.locator('select').first();
    const charter = panel.locator('textarea[rows="2"]').first();
    const h = (await (create ? panel.locator('select').last() : headField).boundingBox())!; const b = (await charter.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(h.y + h.height);
    expect(await charter.locator('..').evaluate(n => n.previousElementSibling?.querySelector('select') !== null)).toBe(true);
    await geometry(page, create ? '.department-create-modal input,.department-create-modal textarea,.department-create-modal select,.department-create-modal button' : '.department-workbench textarea');
  }
});

test('dashboard long content fits phone panels', async ({ page }) => {
  await fixture(page, '/dashboard', 390);
  await expect(page.getByText('Long message', { exact: false })).toBeVisible();
  await geometry(page, '.stat-card,.data-grid .section-card,.dashboard-chart-card,.data-grid .list-row');
});

test('basic new card follows board company and posts a plain goal without explicit routing gates', async ({ page }) => {
  const { writes } = await fixture(page, '/kanban');
  await page.locator('select').filter({ has: page.locator('option', { hasText: 'Company Beta' }) }).first().selectOption(companyB);
  await page.getByRole('button', { name: 'New Card', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Card' });
  await expect(dialog.locator('select').first()).toHaveValue(companyB);
  await expect(dialog.getByRole('combobox', { name: 'Assignee', exact: true })).toBeHidden();
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Make progress visible');
  await dialog.getByRole('textbox', { name: 'Request', exact: true }).fill('Show the result and the next step in ordinary language.');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect.poll(() => writes.filter(w => w.path === '/api/cards').length).toBe(1);
  expect(writes.at(-1)?.body).toMatchObject({ companyId: companyB, title: 'Make progress visible', body: 'Show the result and the next step in ordinary language.', assigneeId: null, reviewerId: null, requiresApproval: false });
});

test('new card reviewer choices exclude executor and company switch clears incompatible choices', async ({ page }) => {
  const { writes, fail } = await fixture(page, '/kanban', 390);
  await page.getByRole('button', { name: 'New Card', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Card' });
  await dialog.getByText('Advanced', { exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption(head);
  await expect(dialog.getByRole('combobox', { name: 'Reviewer', exact: true }).locator(`option[value="${head}"]`)).toHaveCount(0);
  await dialog.getByRole('combobox', { name: 'Reviewer', exact: true }).selectOption(reviewer);
  await dialog.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption(reviewer);
  await expect(dialog.getByRole('combobox', { name: 'Reviewer', exact: true })).toHaveValue('');
  await dialog.getByLabel('Needs client approval', { exact: true }).check();
  await dialog.getByRole('combobox', { name: 'Company', exact: true }).selectOption(companyB);
  await expect(dialog.getByRole('combobox', { name: 'Assignee', exact: true })).toHaveValue('');
  await expect(dialog.getByRole('combobox', { name: 'Reviewer', exact: true }).locator(`option[value="${head}"]`)).toHaveCount(0);
  await geometry(page, '.kanban-create-modal input,.kanban-create-modal textarea,.kanban-create-modal select,.kanban-create-modal button');
  await dialog.getByText('Advanced', { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Retained on error');
  fail(); await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Retained on error');
  expect(writes.at(-1)?.body.requiresApproval).toBe(true);
});

test('card reviewer edits preserve client approval and retries, and changing assignee clears self review', async ({ page }) => {
  const { writes } = await fixture(page, '/kanban');
  await page.getByText('Existing card', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit fields', exact: true }).click();
  await page.locator('[data-field="reviewerId"]').selectOption('');
  await expect(page.locator('[data-field="requiresApproval"]')).toBeChecked();
  await page.locator('[data-field="requiresApproval"]').uncheck();
  await page.locator('[data-field="reviewerId"]').selectOption(reviewer);
  await expect(page.locator('[data-field="requiresApproval"]')).not.toBeChecked();
  await page.locator('[data-field="requiresApproval"]').check();
  await page.locator('[data-field="assigneeId"]').selectOption(reviewer);
  await expect(page.locator('[data-field="reviewerId"]')).toHaveValue('');
  await expect(page.locator('[data-field="reviewerId"] option[value="foreign-agent"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ requiresApproval: true, maxRetries: 7, reviewerId: null, assigneeId: reviewer });
});

test('work product uses one deliverable URL with inferred PR type and retains advanced values when closed', async ({ page }, info) => {
  const { writes } = await fixture(page, '/kanban', 390);
  await page.getByText('Existing card', { exact: true }).click();
  await page.getByRole('button', { name: /^Outputs/ }).click();
  await expect(page.getByRole('textbox', { name: 'Commit SHA', exact: true })).toBeHidden();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Review this change');
  await page.getByRole('textbox', { name: 'Deliverable URL', exact: true }).fill('https://github.com/example/project/pull/12');
  await page.screenshot({ path: info.outputPath('product-basic-390.png') });
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Branch', exact: true }).fill('feature/result');
  await geometry(page, '.detail-panel .section-card input,.detail-panel .section-card textarea,.detail-panel .section-card select,.detail-panel .section-card button');
  await page.screenshot({ path: info.outputPath('product-advanced-390.png') });
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByRole('button', { name: 'Add work product', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ type: 'pull_request', title: 'Review this change', url: 'https://github.com/example/project/pull/12', branch: 'feature/result', pullRequestUrl: null });
  await expect(page.getByRole('link', { name: 'Open product' })).toHaveAttribute('href', 'https://github.com/example/project/pull/12');
});

test('company draft clears the previous company NFS share after its removal', async ({ page }) => {
  await fixture(page, '/projects');
  let companies: any[] = [{ id: companyA, name: 'Company Alpha', slug: 'alpha', nfsShareUrl: 'nfs://synthetic-host/company-alpha' }];
  await page.route('**/api/proxy/api/companies**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'DELETE') { companies = []; return route.fulfill({ json: { ok: true } }); }
    if (path.endsWith('execution-readiness')) return route.fulfill({ json: { ready: true, issues: [], runtimeIssues: [], setupIssues: [] } });
    if (path.endsWith('deletion-preview')) return route.fulfill({ json: { canDelete: true, blocking: {}, inventory: {} } });
    return route.fulfill({ json: companies });
  });
  await page.route('**/api/proxy/api/me', route => route.fulfill({ json: { user: { id: head, email: 'forms@example.test', role: 'admin' }, memberships: [{ companyId: companyA, role: 'admin' }] } }));
  await page.goto('/companies');
  await expect(page.getByLabel(/^NFS share URL/)).toHaveValue('nfs://synthetic-host/company-alpha');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete company', exact: true }).click();
  await page.getByRole('button', { name: 'Return to company settings', exact: true }).click();
  await expect(page.getByLabel(/^NFS share URL/)).toHaveValue('');
});

for (const width of [320, 390, 768, 900, 1158, 1440]) test(`department forms fit ${width}px with either navigation state`, async ({ page }, info) => {
  await fixture(page, '/departments', width);
  for (let state = 0; state < 2; state++) {
    await geometry(page, '.department-workbench input,.department-workbench textarea,.department-workbench select,.department-workbench button');
    if (width === 390) await page.locator('.section-card').filter({ has: page.getByRole('heading', { name: 'Department settings', exact: true }) }).screenshot({ path: info.outputPath(`department-settings-${state}.png`) });
    await page.getByRole('button', { name: 'New Department', exact: true }).click();
    await geometry(page, '.department-create-modal input,.department-create-modal textarea,.department-create-modal select,.department-create-modal button');
    if (width === 390 || width === 1158) await page.screenshot({ path: info.outputPath(`department-${width}-${state}.png`) });
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  }
});

for (const width of [320, 390, 768, 900, 1158, 1440]) test(`expanded new card controls fit ${width}px with either navigation state`, async ({ page }, info) => {
  await fixture(page, '/kanban', width);
  for (let state = 0; state < 2; state++) {
    await page.getByRole('button', { name: 'New Card', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New Card' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('..')).toHaveCSS('opacity', '1');
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('A clear request');
    await dialog.getByRole('textbox', { name: 'Request', exact: true }).fill('Show the result and the next step.');
    const createBox = (await dialog.getByRole('button', { name: 'Create', exact: true }).boundingBox())!;
    expect(createBox.y).toBeGreaterThanOrEqual(0);
    expect(createBox.y + createBox.height).toBeLessThanOrEqual(900);
    await geometry(page, '.kanban-create-modal input,.kanban-create-modal textarea,.kanban-create-modal select,.kanban-create-modal button');
    if (width === 390 || width === 1158) await page.screenshot({ path: info.outputPath(`new-card-basic-${width}-${state}.png`) });
    await dialog.getByText('Advanced', { exact: true }).click();
    await geometry(page, '.kanban-create-modal input,.kanban-create-modal textarea,.kanban-create-modal select,.kanban-create-modal button');
    if (width === 390 || width === 1158) await page.screenshot({ path: info.outputPath(`new-card-${width}-${state}.png`) });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  }
});

test('conversation keeps one request body and preserves optional routing in Advanced', async ({ page }) => {
  const { writes } = await fixture(page, '/kanban', 390);
  await page.getByText('Existing card', { exact: true }).click();
  const composer = page.locator('.conv-composer');
  await expect(composer.getByRole('combobox', { name: 'Action', exact: true })).toBeHidden();
  await composer.getByRole('textbox', { name: 'Message', exact: true }).fill('Please explain the remaining blocker.');
  await composer.getByText('Advanced', { exact: true }).click();
  await composer.getByRole('combobox', { name: 'Action', exact: true }).selectOption('send_to_agent');
  await composer.getByText('Advanced', { exact: true }).click();
  await composer.getByRole('button', { name: 'Send to context', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({ body: 'Please explain the remaining blocker.', action: 'send_to_agent', agentId: null });
});
