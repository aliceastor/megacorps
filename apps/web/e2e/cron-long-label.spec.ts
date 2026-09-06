import { expect, test } from '@playwright/test';
import { productFixture, settlePage, waitForProductPage } from './product-fixture';

test('Cron long company keeps Use horizontal at 390px in both sidebar states', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const state = await productFixture(page, true);
  await page.goto('/cron');
  await waitForProductPage(page, state, '/cron', true, 0);
  for (const open of [false, true]) {
    const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
    if (await toggle.getAttribute('aria-expanded') !== String(open)) await toggle.click();
    await settlePage(page);
    const row = page.locator('.heartbeat-row').filter({ hasText: 'Company Alpha' });
    const geometry = await row.evaluate(node => {
      const name = node.querySelector('b')!, button = node.querySelector('button')!;
      const range = document.createRange(); range.selectNodeContents(button);
      const buttonLines = [...range.getClientRects()].filter(rect => rect.width > 0);
      range.selectNodeContents(name);
      const nameLines = [...range.getClientRects()].filter(rect => rect.width > 0);
      const action = button.getBoundingClientRect(), frame = node.getBoundingClientRect();
      return { buttonLines: buttonLines.length, nameLines: nameLines.length, actionLeft: action.left, actionRight: action.right, rowRight: frame.right, viewport: innerWidth };
    });
    await page.screenshot({ path: info.outputPath(`cron-390-${open}.png`), fullPage: true });
    expect.soft(geometry.buttonLines, `Use must be one line; sidebar=${open}`).toBe(1);
    expect.soft(geometry.nameLines).toBeGreaterThan(1);
    expect.soft(geometry.actionLeft).toBeGreaterThanOrEqual(0);
    expect.soft(geometry.actionRight).toBeLessThanOrEqual(Math.min(geometry.rowRight, geometry.viewport));
    await row.getByRole('button', { name: 'Use', exact: true }).focus();
    await expect(row.getByRole('button', { name: 'Use', exact: true })).toBeFocused();
  }
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
