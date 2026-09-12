import { expect, test, type Page } from '@playwright/test';
import { fixture } from './org-chart-fixture';

async function managerFixture(page: Page, route: string, width = 1158) {
  await fixture(page, width);
  const companyId = 'company-chart';
  const positions = [
    { id: 'boss-position', name: 'CEO', rank: 0, isCompanyBoss: true, isCompanyLeadership: true },
    { id: 'head-position', name: 'CTO', rank: 1, isDepartmentHead: true, defaultDepartmentId: 'engineering', managerPositionId: 'boss-position' },
    { id: 'senior-position', name: 'Senior Engineer', rank: 2, defaultDepartmentId: 'engineering', managerPositionId: 'head-position' },
    { id: 'intern-position', name: 'Internship', rank: 9, defaultDepartmentId: 'engineering', managerPositionId: 'senior-position' },
    { id: 'director-position', name: 'Company Director', rank: 2, isCompanyLeadership: true, managerPositionId: 'boss-position' },
    { id: 'other-position', name: 'Unrelated role', rank: 3, defaultDepartmentId: 'engineering', managerPositionId: 'boss-position' },
    { id: 'vacant-manager', name: 'Vacant manager', rank: 4, defaultDepartmentId: 'engineering', managerPositionId: 'head-position' },
    { id: 'vacancy-staff', name: 'Vacancy staff', rank: 8, defaultDepartmentId: 'engineering', managerPositionId: 'vacant-manager' },
  ].map(position => ({ companyId, slug: position.id, isActive: true, ...position }));
  const agents = [
    { id: 'boss', name: 'Company Boss', positionId: 'boss-position', departmentId: null, bossId: null },
    { id: 'head', name: 'Engineering Head', positionId: 'head-position', departmentId: 'engineering', bossId: 'boss' },
    { id: 'senior-a', name: 'Senior A', positionId: 'senior-position', departmentId: 'engineering', bossId: 'head' },
    { id: 'senior-b', name: 'Senior B', positionId: 'senior-position', departmentId: 'engineering', bossId: 'head' },
    { id: 'intern', name: 'Intern', positionId: 'intern-position', departmentId: 'engineering', bossId: 'senior-a' },
    { id: 'director', name: 'Director', positionId: 'director-position', departmentId: null, bossId: 'boss' },
    { id: 'unrelated', name: 'Unrelated Agent', positionId: 'other-position', departmentId: 'engineering', bossId: 'boss' },
  ].map(agent => ({ companyId, slug: agent.id, role: 'worker', isActive: true, adapterType: 'a2a', runtimeId: 'runtime', adapterConfig: {}, ...agent }));
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/proxy/api/departments', request => request.fulfill({ json: [{ id: 'engineering', companyId, name: 'Engineering', slug: 'engineering', headAgentId: 'head' }] }));
  await page.route('**/api/proxy/api/positions', request => request.fulfill({ json: positions }));
  await page.route('**/api/proxy/api/agents**', async request => {
    if (request.request().method() === 'PUT') {
      const patch = request.request().postDataJSON(); writes.push(patch);
      const agent = agents.find(agent => request.request().url().endsWith(`/${agent.id}`))!;
      Object.assign(agent, patch); return request.fulfill({ json: agent });
    }
    return request.fulfill({ json: agents });
  });
  await page.goto(route);
  return { writes };
}
async function values(select: ReturnType<Page['locator']>) { return select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)); }

for (const route of ['/agents', '/departments/o-chart']) test(`manager-position options preserve a valid supervisor and exclude unrelated Agents on ${route}`, async ({ page }) => {
  const { writes } = await managerFixture(page, route);
  if (route === '/agents') await page.locator('.agent-name-button').filter({ hasText: 'Intern' }).click();
  else await page.locator('[data-org-agent="intern"]').click();
  const reports = page.getByRole('combobox', { name: 'Reports to', exact: true });
  await expect.poll(() => values(reports)).toEqual(['', 'senior-a', 'senior-b']);
  await expect(reports).toHaveValue('senior-a');
  await reports.selectOption('senior-b');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ bossId: 'senior-b' });
  await page.getByRole('combobox', { name: 'Position', exact: true }).selectOption('vacancy-staff');
  await expect.poll(() => values(reports)).toEqual(['']);
  await expect(page.getByText('Manager position is vacant or unconfigured. No eligible supervisor.', { exact: true })).toBeVisible();
});

test('department tabs separate panels, leadership counts company-direct Agents and position scope has no department input', async ({ page }) => {
  await managerFixture(page, '/departments', 390);
  await expect(page.getByRole('tab')).toHaveText(['Settings', 'Goals', 'Members', 'Positions']);
  await expect(page.getByRole('heading', { name: 'Department settings', exact: true })).toBeVisible();
  await expect(page.locator('.org-assignment-table')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Goals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Department Goals', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Department settings', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Company leadership', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Company leadership', exact: true })).toContainText('2 agents');
  await expect(page.getByRole('combobox', { name: 'Department', exact: true })).toHaveCount(0);
  await expect(page.locator('.positions-page')).toContainText('Company Director');
  await page.getByRole('tab', { name: 'Members', exact: true }).click();
  await expect(page.locator('.org-assignment-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.org-assignment-table .agent-name-button b')).toHaveText(['Company Boss', 'Director']);
  await page.goto('/departments/o-chart');
  await expect(page.locator('[data-org-agent="director"]')).toHaveAttribute('data-org-group-id', '__company_leadership__');
  await expect(page.locator('[data-org-group="__unassigned__"]')).toHaveCount(0);
});

test('department table and inline editor stage a new position until an eligible supervisor is chosen', async ({ page }) => {
  const { writes } = await managerFixture(page, '/departments');
  await page.getByRole('tab', { name: 'Members', exact: true }).click();
  const row = page.locator('.org-assignment-table tbody tr').filter({ hasText: 'Unrelated Agent' });
  await row.getByRole('combobox', { name: 'Position for Unrelated Agent', exact: true }).selectOption('intern-position');
  expect(writes).toHaveLength(0);
  const reports = row.getByRole('combobox', { name: 'Reports to for Unrelated Agent', exact: true });
  await expect.poll(() => values(reports)).toEqual(['', 'senior-a', 'senior-b']);
  await expect(row.getByRole('button', { name: 'Save assignment', exact: true })).toBeDisabled();
  await row.locator('.agent-name-button').click();
  const inline = page.locator('.agent-inline-editor');
  await expect.poll(() => values(inline.getByRole('combobox', { name: 'Reports to', exact: true }))).toEqual(['', 'senior-a', 'senior-b']);
  await inline.getByRole('combobox', { name: 'Reports to', exact: true }).selectOption('senior-b');
  await inline.getByRole('button', { name: 'Save assignment', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ positionId: 'intern-position', departmentId: 'engineering', bossId: 'senior-b' });
});

test('Agent creation uses manager-position candidates instead of all Agents', async ({ page }) => {
  await managerFixture(page, '/agents');
  await page.getByRole('button', { name: 'New Agent', exact: true }).click();
  const wizard = page.locator('.agent-wizard-modal');
  await wizard.getByRole('textbox', { name: 'Name', exact: true }).fill('New intern');
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  await wizard.getByRole('combobox', { name: 'Position', exact: true }).selectOption('intern-position');
  const reports = wizard.getByRole('combobox', { name: 'Reports to', exact: true });
  await expect.poll(() => values(reports)).toEqual(['', 'senior-a', 'senior-b']);
  await expect(reports).toHaveValue('');
  await wizard.getByRole('combobox', { name: 'Position', exact: true }).selectOption('director-position');
  await expect.poll(() => values(reports)).toEqual(['', 'boss']);
  await expect(reports).toHaveValue('boss');
  await expect(wizard.getByRole('combobox', { name: 'Department', exact: true })).toHaveValue('');
});

test('O-Chart saved-Agent actions ignore an incomplete unsaved supervisor choice', async ({ page }) => {
  const { writes } = await managerFixture(page, '/departments/o-chart');
  const actions: string[] = [];
  await page.route('**/api/proxy/api/agents/unrelated/*', route => {
    actions.push(new URL(route.request().url()).pathname.split('/').at(-1)!);
    return route.fulfill({ json: { ok: true } });
  });
  await page.locator('[data-org-agent="unrelated"]').click();
  await page.getByRole('combobox', { name: 'Position', exact: true }).selectOption('intern-position');
  await expect(page.getByRole('combobox', { name: 'Reports to', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Choose an eligible supervisor from the manager position.', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect.poll(() => actions).toEqual(['test-connection']);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => actions).toEqual(['test-connection', 'pause']);
  expect(writes).toHaveLength(0);
});
