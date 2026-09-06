import { expect, test, type Page, type Route } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const agentA = '33333333-3333-4333-8333-333333333333';
const agentB = '44444444-4444-4444-8444-444444444444';
const tiny = '0.00000019';
const period = { key: '2026-09', start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z', timezone: 'UTC' };
const usage = { actualUsd: tiny, estimatedUsd: '0.00000000', totalUsd: tiny, reservedUsd: '0.25000000', unknownAttempts: 1, attempts: 25, period, reservationAsOf: '2026-09-06T00:00:00.000Z', accounting: 'Runtime-reported, estimated and unknown usage; not invoice reconciliation.', taskScope: 'Direct card executions; child cards accounted independently.' };

async function fixture(page: Page) {
  const reads: { path: string; query: string }[] = [];
  const writes: { path: string; method: string; body: any }[] = [];
  const unexpected: string[] = [];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let summaryFails = false, policyFails = false, holdCompanyA = false;
  let held: Route | undefined;
  const policies: any[] = [];
  await page.addInitScript(() => { localStorage.setItem('locale', 'en'); localStorage.setItem('megacorps.sidebarOpen', 'true'); });
  await page.route('**/api/proxy/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname.replace('/api/proxy', '');
    if (request.method() !== 'GET') {
      const body = request.postDataJSON(); writes.push({ path, method: request.method(), body });
      if (path === '/api/budget-policies' && request.method() === 'POST') {
        if (policyFails) return route.fulfill({ status: 400, json: { error: 'synthetic_policy_rejected' } });
        const policy = { ...body, monthlyLimitUsd: body.monthlyLimitUsd == null ? null : Number(body.monthlyLimitUsd).toFixed(8), perTaskLimitUsd: body.perTaskLimitUsd == null ? null : Number(body.perTaskLimitUsd).toFixed(8), id: '55555555-5555-4555-8555-555555555555' }; policies.push(policy);
        return route.fulfill({ status: 201, json: policy });
      }
      if (path === '/api/budget-policies/55555555-5555-4555-8555-555555555555' && request.method() === 'PUT') {
        Object.assign(policies[0], body, { monthlyLimitUsd: String(body.monthlyLimitUsd), perTaskLimitUsd: String(body.perTaskLimitUsd) });
        return route.fulfill({ json: policies[0] });
      }
      unexpected.push(`${request.method()} ${path}`); return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_write' } });
    }
    reads.push({ path, query: url.search });
    if (path === '/api/me') return route.fulfill({ json: { user: { id: 'user', email: 'budget@example.test', role: 'admin' } } });
    if (path === '/api/notifications') return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path === '/api/companies') return route.fulfill({ json: [{ id: companyA, name: 'Company Alpha' }, { id: companyB, name: 'Company Beta' }] });
    if (path === '/api/agents') return route.fulfill({ json: [{ id: agentA, companyId: companyA, name: 'Agent Alpha', isActive: false, spentThisMonth: '999', budgetMonthly: '10', budgetPerTask: '1' }, { id: agentB, companyId: companyB, name: 'Agent Beta', isActive: true }] });
    if (path === '/api/cards' || path === '/api/approvals') return route.fulfill({ json: [] });
    if (path === '/api/budget-policies') return route.fulfill({ json: policies });
    if (path === '/api/dashboard') return route.fulfill({ json: { stats: { companies: 2, monthlyCost: Number(tiny) }, usage, stages: {}, recentTaskLogs: [], recentApiEvents: [] } });
    if (path === '/api/dashboard/timeseries') return route.fulfill({ json: { days: 30, points: [] } });
    if (path === '/api/usage-summary') {
      if (summaryFails) return route.fulfill({ status: 503, json: { error: 'synthetic_usage_unavailable' } });
      if (holdCompanyA && url.searchParams.get('companyId') === companyA) { held = route; return; }
      const value = url.searchParams.get('companyId') === companyB ? '2.00000000' : tiny;
      return route.fulfill({ json: { ...usage, actualUsd: value, totalUsd: value, period: url.searchParams.get('period') === 'all' ? null : period } });
    }
    if (path === '/api/cost-events') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const rows = offset ? [{ id: 'last', companyId: companyA, agentId: agentA, provider: 'Final page provider', model: 'fixture-model', costUsd: '0.00000000', costStatus: 'actual', occurredAt: '2026-09-05T00:00:00Z', usage: { costStatus: 'actual', tokenStatus: 'actual', totalTokens: 0 } }] : Array.from({ length: 25 }, (_, index) => ({ id: `cost-${index}`, companyId: companyA, agentId: agentA, provider: index === 0 ? 'unknown' : `Synthetic Provider ${index}`, model: 'fixture-model', costUsd: index === 0 ? null : index === 1 ? tiny : '0.00000000', costStatus: index === 0 ? 'unknown' : index === 1 ? 'actual' : 'estimated', occurredAt: '2026-09-06T00:00:00Z', source: index === 2 ? 'legacy_fixed_rate' : 'dispatch', usage: { costStatus: index === 0 ? 'unknown' : index === 1 ? 'actual' : 'estimated', tokenStatus: index === 0 ? 'unknown' : 'actual', totalTokens: index === 0 ? null : 12 } }));
      return route.fulfill({ json: rows });
    }
    unexpected.push(`GET ${path}`); return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_read' } });
  });
  return {
    reads, writes, unexpected, errors,
    failSummary: (value: boolean) => { summaryFails = value; },
    failPolicy: (value: boolean) => { policyFails = value; },
    holdOld: () => { holdCompanyA = true; },
    hasHeld: () => Boolean(held),
    releaseOld: async () => { holdCompanyA = false; await held?.fulfill({ json: usage }).catch(() => {}); },
  };
}

test('budget preserves tiny decimal costs and separates missing usage from factual zero', async ({ page }) => {
  const state = await fixture(page); await page.goto('/budget');
  await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible();
  const total = page.locator('.stat-card').filter({ hasText: /Total recorded cost|Known total/ });
  await expect(total).toContainText('$0.00000019');
  await expect(page.getByLabel('Usage summary')).toContainText('Runtime reported');
  await expect(page.getByLabel('Usage summary')).toContainText('Unknown cost attempts');
  await expect(page.getByLabel('Usage summary')).toContainText('$0.25');
  const attempts = page.getByRole('region', { name: 'Recent attempts (all time)' });
  await expect(attempts.locator('[data-usage-status="unknown"]').first()).toContainText('Unknown cost');
  await expect(attempts.locator('[data-usage-status="unknown"]').first()).not.toContainText('$0.00');
  await expect(attempts).toContainText('Legacy estimate');
  await expect(page.getByText('$999')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next attempts' }).click();
  await expect(attempts).toContainText('Final page provider');
  await expect(attempts).toContainText('$0.00');
  expect(state.reads.some(row => row.path === '/api/cost-events' && row.query.includes('offset=25'))).toBe(true);
  expect(state.unexpected).toEqual([]);
});

test('dashboard uses the exact usage subtotal with explicit provenance', async ({ page }) => {
  const state = await fixture(page); await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.locator('.stat-card').filter({ hasText: /Monthly cost|Known cost this month/ })).toContainText('$0.00000019');
  await expect(page.getByLabel('Usage summary')).toContainText('Unknown cost attempts');
  await expect(page.getByLabel('Usage summary')).toContainText('UTC');
  expect(state.unexpected).toEqual([]);
});

test('budget policy errors retain the draft and retry preserves warning-only settings', async ({ page }) => {
  const state = await fixture(page); state.failPolicy(true); await page.goto('/budget');
  await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Warning only policy');
  await page.getByRole('spinbutton', { name: 'Warn at percent', exact: true }).fill('90');
  await page.getByRole('checkbox', { name: /Hard stop when exceeded|Stop new work at the limit/ }).uncheck();
  await page.getByRole('checkbox', { name: 'Policy active', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole('alert').filter({ hasText: 'synthetic_policy_rejected' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Warning only policy');
  state.failPolicy(false);
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Budget policy saved' })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].body).toMatchObject({ companyId: companyA, warnAtPercent: 90, hardStop: false, isActive: false });
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(3);
  expect(state.writes[2].method).toBe('PUT');
  expect(state.unexpected).toEqual([]);
});

test('budget summary errors are retryable and old company responses cannot replace the selection', async ({ page }) => {
  const state = await fixture(page); state.failSummary(true); await page.goto('/budget');
  await expect(page.getByRole('alert').filter({ hasText: 'synthetic_usage_unavailable' })).toBeVisible();
  await expect(page.getByLabel('Usage summary')).toHaveCount(0);
  state.failSummary(false); await page.getByRole('button', { name: 'Retry usage' }).click();
  await expect(page.getByLabel('Usage summary')).toContainText('$0.00000019');
  state.holdOld(); await page.getByRole('combobox', { name: 'Reporting company', exact: true }).selectOption(companyA);
  await expect.poll(state.hasHeld).toBe(true);
  await page.getByRole('combobox', { name: 'Reporting company', exact: true }).selectOption(companyB);
  await expect(page.getByLabel('Usage summary')).toContainText('$2.00');
  await state.releaseOld();
  await expect(page.getByRole('combobox', { name: 'Reporting company', exact: true })).toHaveValue(companyB);
  await expect(page.getByLabel('Usage summary')).toContainText('$2.00');
  await page.getByRole('checkbox', { name: 'All time', exact: true }).check();
  await expect.poll(() => state.reads.some(row => row.path === '/api/usage-summary' && row.query.includes('period=all'))).toBe(true);
  expect(state.unexpected).toEqual([]);
});

for (const width of [390, 1158, 1440]) test(`budget controls fit ${width}px in both sidebar states`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); const state = await fixture(page); await page.goto('/budget');
  await expect(page.getByLabel('Usage summary')).toBeVisible();
  for (const expanded of [false, true]) {
    const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', width <= 900 ? 'false' : /true|false/);
    if (await toggle.getAttribute('aria-expanded') !== String(expanded)) await toggle.click();
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
    const geometry = await page.locator('.budget-page').evaluate(root => {
      const controls = [...root.querySelectorAll<HTMLElement>('input,select,button')].filter(node => node.checkVisibility()).map(node => { const b = node.getBoundingClientRect(); return { tag: node.tagName, left: b.left, right: b.right, width: b.width }; });
      const clipped: string[] = [];
      for (const node of root.querySelectorAll<HTMLElement>('input,select,button')) {
        if (!node.checkVisibility()) continue;
        const b = node.getBoundingClientRect();
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (!/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowX)) continue;
          const p = parent.getBoundingClientRect(); const left = p.left + parent.clientLeft;
          if (b.left < left - 1 || b.right > left + parent.clientWidth + 1) clipped.push(node.tagName + ':' + parent.className);
        }
      }
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, controls, clipped };
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(width + 1);
    expect(geometry.controls.filter(node => node.left < -1 || node.right > width + 1)).toEqual([]);
    expect(geometry.clipped).toEqual([]);
    writeFileSync(info.outputPath(`budget-${width}-${expanded}.json`), JSON.stringify(geometry, null, 2));
    await page.screenshot({ path: info.outputPath(`budget-${width}-${expanded}.png`), fullPage: true });
  }
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const [locale, title, summaryName] of [['zh-TW', '預算', '用量摘要'], ['ja', '予算', '使用量の概要']]) test(`budget accounting copy is localized in ${locale}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 }); const state = await fixture(page);
  await page.addInitScript(value => localStorage.setItem('locale', value), locale!);
  await page.goto('/budget');
  await expect(page.getByRole('heading', { name: title!, exact: true })).toBeVisible();
  await expect(page.getByLabel(summaryName!)).toContainText('$0.00000019');
  await expect(page.getByLabel(summaryName!)).not.toContainText('Unknown cost attempts');
  await page.screenshot({ path: info.outputPath(`budget-${locale}.png`), fullPage: true });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
