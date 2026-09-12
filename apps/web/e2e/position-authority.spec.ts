import { expect, test } from '@playwright/test';
import { productFixture, settlePage } from './product-fixture';
test('positions redirect to department tabs and company leadership keeps Boss outside departments', async ({ page }) => {
  await productFixture(page, true);
  await page.goto('/positions'); await settlePage(page);
  await expect(page).toHaveURL(/\/departments\?tab=positions/);
  await expect(page.getByRole('tab', { name: 'Positions', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Positions', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Company leadership', exact: true }).click();
  await expect(page.getByLabel('Department Head', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Rank', { exact: true })).toHaveValue('0');
  await expect(page.getByRole('combobox', { name: 'Department', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Manager position', exact: true })).toBeDisabled();
});

import { fixture } from './org-chart-fixture';
test('department head position fixes rank and prevents a duplicate head even in a new draft', async ({ page }) => {
  await fixture(page);
  await page.goto('/departments?tab=positions');
  await expect(page.getByRole('tab', { name: 'Positions', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.locator('.positions-page .selectable-row').filter({ hasText: 'Position 100' }).click();
  await expect(page.getByLabel('Department Head', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Rank', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Rank', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'New Position', exact: true }).click();
  await expect(page.getByLabel('Department Head', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Rank', { exact: true })).toHaveValue('2');
  await expect(page.getByRole('combobox', { name: 'Department', exact: true })).toHaveValue('engineering');
  await expect(page.getByRole('combobox', { name: 'Department', exact: true })).toBeDisabled();
});
test('Agent editor locks membership and leadership reports but keeps staff reporting editable on mobile', async ({ page }) => {
  await fixture(page, 390);
  await page.goto('/agents');
  await page.locator('.agent-name-button').filter({ hasText: 'Engineering manager' }).click();
  await expect(page.getByRole('combobox', { name: 'Department', exact: true }).last()).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Reports to', exact: true }).last()).toBeDisabled();
  await page.locator('.agent-name-button').filter({ hasText: 'Design specialist' }).click();
  await expect(page.getByRole('combobox', { name: 'Reports to', exact: true }).last()).toBeEnabled();
  await expect(page.getByRole('combobox', { name: 'Reports to', exact: true }).last()).toHaveValue('manager');
});

test('unassigned department excludes company leadership and never exposes all positions', async ({ page }) => {
  await fixture(page);
  await page.goto('/departments?tab=positions');
  const unassigned = page.locator('.department-rail button').filter({ hasText: 'No department' });
  await expect(unassigned).toContainText('0 agents');
  await unassigned.click();
  await expect(page.getByText('Choose a department to manage its positions.', { exact: true })).toBeVisible();
  await expect(page.locator('.positions-page')).toHaveCount(0);
});
test('company leadership selection survives organization refetch', async ({ page }) => {
  await fixture(page);
  let reads = 0;
  await page.route('**/api/proxy/api/departments', route => route.fulfill({ json: [{ id: 'engineering', companyId: 'company-chart', name: `Engineering revision ${++reads}`, slug: 'engineering' }] }));
  await page.goto('/departments');
  const leadership = page.getByRole('button', { name: 'Company leadership', exact: true });
  await leadership.click();
  await page.getByRole('tab', { name: 'Members & settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Reports to for Design specialist', exact: true }).selectOption('boss');
  await expect.poll(() => reads).toBeGreaterThan(1);
  await expect(leadership).toHaveClass(/active/);
});
