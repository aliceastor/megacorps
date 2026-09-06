import { expect, test } from '@playwright/test';
import { companyId, secondCompanyId, productFixture, settlePage } from './product-fixture';

test('Knowledge read failure is visible and retry restores company docs', async ({ page }) => {
  const state = await productFixture(page, true);
  state.fail('/api/knowledge-docs');
  await page.goto('/knowledge'); await settlePage(page);
  await expect.poll(() => state.reads.some(path => path.startsWith('/api/knowledge-docs'))).toBe(true);
  await expect(page.locator('.knowledge-page [role="alert"]')).toContainText('synthetic_read_unavailable');
  await expect(page.getByRole('button', { name: 'Save knowledge doc', exact: true })).toBeDisabled();
  state.fail('');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText(/^Guidance Alpha/)).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test('Knowledge late company response cannot replace the current docs', async ({ page }) => {
  const state = await productFixture(page, true); state.holdDocs(companyId);
  await page.goto('/knowledge'); await settlePage(page);
  await expect.poll(state.hasHeld).toBe(true);
  await page.getByRole('combobox', { name: 'Company', exact: true }).selectOption(secondCompanyId);
  await expect(page.getByText('Guidance Beta', { exact: true })).toBeVisible();
  await state.releaseDocs();
  await expect(page.getByRole('combobox', { name: 'Company', exact: true })).toHaveValue(secondCompanyId);
  await expect(page.getByText('Guidance Beta', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Guidance Alpha/)).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test('Knowledge save errors keep the draft and a retry creates one doc', async ({ page }) => {
  const state = await productFixture(page, true); state.failWrite(true);
  await page.goto('/knowledge'); await settlePage(page);
  await expect(page.getByText(/^Guidance Alpha/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('New policy');
  await page.getByRole('textbox', { name: 'Markdown', exact: true }).fill('Keep the policy draft.');
  await page.getByRole('button', { name: 'Save knowledge doc', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.locator('.knowledge-page [role="alert"]')).toContainText('synthetic_write_unavailable');
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('New policy');
  state.failWrite(false); await page.getByRole('button', { name: 'Save knowledge doc', exact: true }).click();
  await expect(page.getByText('New policy', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('');
  expect(state.writes).toHaveLength(2); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
