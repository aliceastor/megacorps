import { expect, test, type Page, type Route } from '@playwright/test';

type RequestRecord = { path: string; search: string };

async function mockLogs(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  const requests: RequestRecord[] = [];
  let activityFails = true;
  let heldOld: Route | null = null;
  const corpusSize = 273;
  const promptRows = Array.from({ length: 50 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    companyId: 'company-1', agentId: 'agent-1', source: 'chat', adapterType: 'codex-app',
    title: `Prompt ${index}`, preview: `Preview ${index}`, promptHash: `hash-${index}`, contextMode: 'full_bootstrap', createdAt: '2026-09-06T01:02:03.000Z',
  }));
  await page.route('**/api/proxy/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/proxy', '');
    requests.push({ path, search: url.search });
    if (path === '/api/me') return route.fulfill({ json: { user: { id: 'user', role: 'admin' }, memberships: [{ companyId: 'company-1', role: 'admin' }] } });
    if (path.startsWith('/api/notifications')) return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path === '/api/agents') return route.fulfill({ json: [{ id: 'agent-1', name: 'Agent One', companyId: 'company-1' }] });
    if (path === '/api/prompt-logs' && url.searchParams.get('q') === 'old') { heldOld = route; return; }
    if (path === '/api/prompt-logs') {
      const q = url.searchParams.get('q');
      if (q === 'new') return route.fulfill({ json: { items: [{ ...promptRows[0], title: 'New result' }], nextCursor: null } });
      if (url.searchParams.get('cursor')) return route.fulfill({ json: { items: [{ ...promptRows[0], id: '00000000-0000-4000-8000-999999999999', title: 'Next page result' }], nextCursor: null } });
      return route.fulfill({ json: { items: promptRows, nextCursor: 'synthetic-cursor' } });
    }
    if (/^\/api\/prompt-logs\//.test(path)) return route.fulfill({ json: { ...promptRows[0], prompt: 'FULL SYNTHETIC PROMPT BODY', metadata: { contextMode: 'full_bootstrap' } } });
    if (path === '/api/activity') {
      if (activityFails) return route.fulfill({ status: 503, json: { error: 'temporary_log_failure' } });
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (path === '/api/cron/status') return route.fulfill({ json: { enabled: true, running: false, intervalMs: 30000, lastStatus: 'success', recentRuns: [] } });
    if (['/api/cron/runs', '/api/task-runs', '/api/heartbeat-runs', '/api/system-logs'].includes(path)) return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ json: [] });
  });
  return {
    corpusSize,
    summaryResponseBytes: Buffer.byteLength(JSON.stringify({ items: promptRows, nextCursor: 'synthetic-cursor' })),
    detailResponseBytes: Buffer.byteLength(JSON.stringify({ ...promptRows[0], prompt: 'FULL SYNTHETIC PROMPT BODY', metadata: { contextMode: 'full_bootstrap' } })),
    requests,
    recoverActivity: () => { activityFails = false; },
    releaseOld: async () => { await heldOld?.fulfill({ json: { items: [{ ...promptRows[0], title: 'Old result' }], nextCursor: null } }); },
  };
}

for (const width of [390, 1158]) test(`logs stay lazy, bounded and truthful at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const state = await mockLogs(page, width);
  await page.goto('/logs?agentId=agent-1&surface=chat&companyId=company-1');
  await expect(page.getByText('Prompt 0', { exact: true })).toBeVisible();
  const initialLogReads = state.requests.filter(row => /\/(prompt-logs|system-logs|activity|heartbeat-runs|task-runs|cron\/)/.test(row.path));
  expect(initialLogReads.map(row => row.path)).toEqual(['/api/prompt-logs']);
  expect(initialLogReads[0]!.search).toContain('view=summary');
  expect(initialLogReads[0]!.search).toContain('limit=50');
  expect(initialLogReads[0]!.search).toContain('agentId=agent-1');
  expect(initialLogReads[0]!.search).toContain('surface=chat');
  const renderedRows = await page.locator('.prompt-log-row').count();
  const hiddenPromptBodies = await page.locator('.prompt-log-body').count();
  const initialDomNodes = await page.locator('*').count();
  expect(renderedRows).toBe(50);
  expect(hiddenPromptBodies).toBe(0);

  await page.getByRole('button', { name: 'Show details' }).first().click();
  await expect(page.getByText('FULL SYNTHETIC PROMPT BODY', { exact: true })).toBeVisible();
  expect(state.requests.filter(row => /^\/api\/prompt-logs\//.test(row.path))).toHaveLength(1);

  await page.getByPlaceholder('Filter logs').fill('bounded');
  await page.waitForTimeout(120);
  expect(state.requests.filter(row => row.path === '/api/prompt-logs' && row.search.includes('q=bounded'))).toHaveLength(0);
  await expect.poll(() => state.requests.filter(row => row.path === '/api/prompt-logs' && row.search.includes('q=bounded')).length).toBe(1);

  await page.getByPlaceholder('Filter logs').fill('old');
  await page.waitForTimeout(280);
  await page.getByPlaceholder('Filter logs').fill('new');
  await expect(page.getByText('New result', { exact: true })).toBeVisible();
  await state.releaseOld();
  await expect(page.getByText('Old result', { exact: true })).toHaveCount(0);

  await page.getByPlaceholder('Filter logs').fill('');
  await expect(page.getByText('Prompt 0', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Next page result', { exact: true })).toBeVisible();
  expect(await page.locator('.prompt-log-row').count()).toBe(1);

  await page.getByRole('tab', { name: /Activity/ }).click();
  await expect(page.locator('.form-error[role="alert"]')).toContainText('temporary_log_failure');
  state.recoverActivity();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('No activity logs on this page.', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const metrics = { width, corpusSize: state.corpusSize, initialLogRequests: initialLogReads.length, summaryResponseBytes: state.summaryResponseBytes, renderedRows, hiddenPromptBodies, initialDomNodes, detailRequests: state.requests.filter(row => /^\/api\/prompt-logs\//.test(row.path)).length, detailResponseBytes: state.detailResponseBytes, fitsViewport: true };
  console.log(`LOGS_METRICS ${JSON.stringify(metrics)}`);
  await testInfo.attach(`logs-metrics-${width}`, { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath(`logs-${width}.png`), fullPage: true });
});
