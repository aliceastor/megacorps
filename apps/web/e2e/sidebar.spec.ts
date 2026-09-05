import { expect, test, type Page } from '@playwright/test';

const preferenceKey = 'megacorps.sidebarOpen';

async function openShell(page: Page, width: number, saved = 'true') {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(({ key, saved }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, saved);
    localStorage.setItem('locale', 'en');
  }, { key: preferenceKey, saved });
  await page.route('**/api/proxy/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith('/api/me')
      ? { user: { email: 'sidebar@example.test', role: 'admin' } }
      : path.includes('/api/notifications')
        ? { notifications: [], unreadCount: 0 }
        : path.endsWith('/api/dashboard')
          ? { stats: {}, stages: {}, recentTaskLogs: [], recentApiEvents: [] }
          : path.endsWith('/api/dashboard/timeseries')
            ? { days: 30, points: [] }
        : { service: 'MegaCorps', endpoints: [], adapters: [], auth: { mode: 'session' },
            kanban: { stages: [], legacyAliases: {} }, cli: { commands: [] } };
    await route.fulfill({ json });
  });
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: 'Help', exact: true })).toBeVisible();
  // Wait for AppShell's client effect rather than interacting with pre-hydration HTML.
  await expect(page.locator('.user-btn span')).toHaveText('sidebar@example.test');
}

async function expectInlineLayout(page: Page) {
  await expect.poll(async () => {
    const sidebar = await page.locator('.sidebar').boundingBox();
    const main = await page.getByRole('main').boundingBox();
    return Boolean(sidebar && main && main.y >= sidebar.y + sidebar.height - 1);
  }, { message: 'Main content must start below the narrow sidebar, never underneath it' }).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [320, 390, 768, 900]) {
  test(`${width}px: collapsed and expanded navigation stays above the page`, async ({ page }, testInfo) => {
    await openShell(page, width);
    await expectInlineLayout(page);
    const toggle = page.getByRole('button', { name: 'Toggle sidebar' });
    const primary = page.getByRole('navigation', { name: 'Primary' });
    const utility = page.getByRole('navigation', { name: 'Utility' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(primary).toBeHidden();
    await expect(utility).toBeHidden();
    const closedHeight = (await page.locator('.sidebar').boundingBox())!.height;
    expect(closedHeight).toBeLessThan(100);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('phone-closed.png') });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(primary).toBeVisible();
    await expect(utility).toBeVisible();
    await expect(primary.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
    await expectInlineLayout(page);
    expect((await page.locator('.sidebar').boundingBox())!.height).toBeGreaterThan(closedHeight);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('phone-open.png'), fullPage: true });

    await toggle.click();
    await expect(primary).toBeHidden();
    await expectInlineLayout(page);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe('true');
  });
}

test('narrow menu supports keyboard dismissal and closes after navigation', async ({ page }) => {
  await openShell(page, 390, 'false');
  const toggle = page.getByRole('button', { name: 'Toggle sidebar' });
  const primary = page.getByRole('navigation', { name: 'Primary' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(primary).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(primary.getByRole('link').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(primary).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.sidebar a:focus')).toHaveCount(0);

  await toggle.click();
  await page.locator('.brand-lockup').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(primary).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  // A same-route link does not remount AppShell, so it must dismiss the menu itself.
  await primary.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(primary).toBeHidden();
});

test('Escape closes an open narrow menu while focus is in the main page', async ({ page }) => {
  await openShell(page, 390);
  const toggle = page.getByRole('button', { name: 'Toggle sidebar' });
  await toggle.click();
  await page.getByRole('button', { name: 'Copy', exact: true }).first().focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('Escape dismisses a foreground dialog without stealing its keyboard event', async ({ page }) => {
  await openShell(page, 390);
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
});

for (const saved of ['true', 'false']) {
  test(`resizing and reload preserve desktop preference ${saved}`, async ({ page }, testInfo) => {
    await openShell(page, 1280, saved);
    const toggle = page.getByRole('button', { name: 'Toggle sidebar' });
    await expect(toggle).toHaveAttribute('aria-expanded', saved);
    const expectedWidth = saved === 'true' ? 252 : 84;
    await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBe(expectedWidth);
    await expect.poll(async () => (await page.getByRole('main').boundingBox())?.x).toBe(expectedWidth);
    if (saved === 'true') await page.screenshot({ path: testInfo.outputPath('desktop.png') });

    await page.setViewportSize({ width: 900, height: 844 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expectInlineLayout(page);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expectInlineLayout(page);
    await page.setViewportSize({ width: 901, height: 844 });
    await expect(toggle).toHaveAttribute('aria-expanded', saved);
    await expect.poll(async () => (await page.getByRole('main').boundingBox())?.x).toBe(expectedWidth);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.setViewportSize({ width: 1280, height: 844 });
    await toggle.click();
    const next = saved === 'true' ? 'false' : 'true';
    await expect(toggle).toHaveAttribute('aria-expanded', next);
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-expanded', next);
  });
}

test('cached account and sidebar preferences hydrate without replacing the shell', async ({ page }) => {
  await openShell(page, 390, 'false');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.reload();
  await expect(page.locator('.user-btn span')).toHaveText('sidebar@example.test');
  await expect(page.getByRole('button', { name: 'Toggle sidebar' })).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});
