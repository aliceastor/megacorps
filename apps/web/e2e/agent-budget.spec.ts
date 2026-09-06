import { expect, test } from '@playwright/test';
import { productFixture, settlePage } from './product-fixture';

test('Agents management shows configured limits and links to usage instead of a stale spend cache', async ({ page }) => {
  const state = await productFixture(page, true);
  await page.goto('/agents'); await settlePage(page);
  await expect(page.locator('.agent-management-table')).not.toContainText('$999.00000000');
  await expect(page.getByRole('columnheader', { name: 'Budget limits', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Boss Alpha', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View recorded usage', exact: true })).toHaveAttribute('href', '/budget');
  await expect(page.locator('.content-area')).not.toContainText('$999.00000000');
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
