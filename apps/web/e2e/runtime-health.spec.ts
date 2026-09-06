import { expect, test } from '@playwright/test';
import { productFixture, settlePage } from './product-fixture';

test('runtime status separates recorded configuration from an actual connection check', async ({ page }) => {
  const state = await productFixture(page, true);
  await page.goto('/settings'); await settlePage(page);
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Runtime health', exact: true }) });
  await expect(panel).toContainText('Connection not checked');
  await expect(panel).toContainText('Configuration and recent runs');
  await expect(panel).toContainText('a2a, json-rpc, task-push-notifications');
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
