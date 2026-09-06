import { expect, test } from '@playwright/test';
import { companyId, longText, productFixture, settlePage, waitForProductPage } from './product-fixture';

test('completed held reads stay recorded when the page closes before a response lookup can finish', async ({ page }) => {
  let finish!: () => void, closed!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const afterClose = new Promise<void>(resolve => { closed = resolve; });
  let intercepted = false;
  // Make the CI teardown ordering deterministic for one real routed request.
  // A response lookup started from requestfinished cannot return until close.
  page.on('requestfinished', request => {
    if (intercepted || !request.url().includes('/api/knowledge-docs')) return;
    intercepted = true;
    const response = request.response.bind(request);
    request.response = async () => { await afterClose; return response(); };
    finish();
  });
  const state = await productFixture(page, true);
  state.holdDocs(companyId);
  await page.goto('/knowledge');
  await expect.poll(state.hasHeld).toBe(true);
  expect(state.completedReads.some(url => url?.includes('/api/knowledge-docs'))).toBe(false);
  await state.releaseDocs();
  await finished;
  await page.close();
  closed();
  await new Promise(resolve => setImmediate(resolve));
  expect(intercepted).toBe(true);
  expect(state.completedReads.some(url => url?.includes('/api/knowledge-docs'))).toBe(true);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('product readiness waits for held page data after shell and heading render', async ({ page }) => {
  const state = await productFixture(page, true);
  state.holdDocs(companyId);
  const readOffset = state.reads.length;
  await page.goto('/knowledge');
  await settlePage(page);
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect.poll(() => state.reads.length).toBeGreaterThan(readOffset);
  await expect.poll(state.hasHeld).toBe(true);
  await expect(page.locator('.knowledge-page').getByRole('status')).toHaveText('Loading company docs...');
  // The old smoke's shell/heading/any-read checks above all pass. Readiness
  // must still reject while the intended populated rows cannot be rendered.
  await expect(waitForProductPage(page, state, '/knowledge', true, readOffset, 500)).rejects.toThrow('/knowledge completed page-data requests');
  await state.releaseDocs();
  await waitForProductPage(page, state, '/knowledge', true, readOffset);
  await expect(page.locator('.knowledge-doc-row b')).toHaveText('Guidance Alpha ' + longText);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(state.failed).toEqual([]);
});
