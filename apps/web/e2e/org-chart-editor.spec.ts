import { expect, test } from '@playwright/test';
import { fixture } from './org-chart-fixture';

test('relationship edit preserves advanced fields and explicit clears persist', async ({ page }) => {
  const { agents, writes } = await fixture(page);
  const original = structuredClone(agents.find(a => a.id === 'analyst')!);
  await page.getByRole('button', { name: /Product analyst/ }).click();
  const editor = page.locator('.company-o-details');
  await expect(editor.getByRole('combobox', { name: 'Department', exact: true })).toBeDisabled();
  await editor.getByRole('combobox', { name: 'Position', exact: true }).selectOption('rank-50');
  await editor.getByRole('combobox', { name: 'Reports to', exact: true }).selectOption('boss');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Agent saved', { exact: true })).toBeVisible();
  const saved = agents.find(a => a.id === 'analyst')!;
  expect(saved.capabilities).toEqual(original.capabilities);
  expect(saved.adapterConfig).toEqual(original.adapterConfig);
  for (const key of ['role', 'soul', 'runtimeId', 'hermesProfile', 'budgetPerTask', 'budgetMonthly', 'memoryConfig', 'defaultTimeoutSeconds'] as const) expect(saved[key]).toEqual(original[key]);
  expect(writes[0]).toEqual({ departmentId: 'product', positionId: 'rank-50', bossId: 'boss' });
  await expect(editor.getByRole('combobox', { name: 'Department', exact: true })).toHaveValue('product');
  await editor.getByRole('combobox', { name: 'Position', exact: true }).selectOption('');
  await editor.getByRole('combobox', { name: 'Reports to', exact: true }).selectOption('');
  await editor.getByLabel('Profile', { exact: true }).fill('');
  await editor.getByLabel('Per-task budget', { exact: true }).fill('');
  await editor.getByLabel('Monthly budget', { exact: true }).fill('');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ departmentId: null, positionId: null, bossId: null, hermesProfile: null, budgetPerTask: null, budgetMonthly: null });
  expect(saved.capabilities).toEqual(original.capabilities);
});


for (const route of ['/departments/o-chart', '/agents']) test(`name-only edit preserves legacy unpositioned organization on ${route}`, async ({ page }) => {
  const { agents, writes } = await fixture(page);
  const legacy = agents.find(agent => agent.id === 'unassigned')!;
  Object.assign(legacy, { positionId: null, departmentId: 'engineering', bossId: 'manager' });
  await page.goto(route);
  if (route === '/agents') await page.locator('.agent-name-button').filter({ hasText: 'Unassigned colleague' }).click();
  else await page.getByRole('button', { name: /Unassigned colleague/ }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Legacy colleague renamed');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).not.toHaveProperty('departmentId');
  expect(writes[0]).not.toHaveProperty('positionId');
  expect(writes[0]).not.toHaveProperty('bossId');
  expect(legacy.departmentId).toBe('engineering');
  expect(legacy.bossId).toBe('manager');
});
