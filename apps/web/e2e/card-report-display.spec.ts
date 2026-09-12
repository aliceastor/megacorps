import { expect, test } from '@playwright/test';
import { cardId, companyId, headId, productFixture } from './product-fixture';

const summary = 'Delivery verified and merged to main.';
const artifactTitle = '受審 head ab11290670d6aea9c57e1101860d8794bee6ad65';
const report = JSON.stringify({
  kind: 'megacorps-report',
  status: 'completed',
  verdict: 'approved',
  score: 9,
  summary,
  workProducts: [{ type: 'pull_request', title: artifactTitle, url: 'https://example.test/acme/pulls/17' }],
});
const raw = `⚠️ Normalized model name\n  ┊ review diff\n@@ -0,0 +1 @@\n+${report}\n${report}`;
const at = '2026-09-12T12:00:00.000Z';

for (const width of [390, 1280]) test(`terminal report is readable without protocol noise at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await productFixture(page, true);
  const comments = [{
    id: 'report-comment', cardId, authorType: 'agent', agentId: headId, action: 'agent_update', body: raw,
    metadata: { via: 'report' }, createdAt: at,
  }];
  const logs = [{
    id: 'report-log', cardId, agentId: headId, type: 'dispatch', status: 'success', message: 'Agent completed task.',
    output: raw, costUsd: '0.01000000', durationSeconds: 12, createdAt: at,
  }];
  await page.route(`**/api/proxy/api/cards/${cardId}/comments`, route => route.fulfill({ json: comments }));
  await page.route(`**/api/proxy/api/cards/${cardId}/logs`, route => route.fulfill({ json: logs }));

  await page.goto('/kanban');
  await page.getByText(/^Task Alpha /).click();
  await page.getByRole('button', { name: /Conversation/ }).click();

  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(conversation.getByText(summary, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText('Report completed', { exact: true })).toBeVisible();
  await expect(conversation.getByText('Approved', { exact: true })).toBeVisible();
  await expect(conversation.getByText('Score 9/10', { exact: true })).toBeVisible();
  await expect(conversation.getByRole('link', { name: artifactTitle })).toHaveAttribute('href', 'https://example.test/acme/pulls/17');

  const rawRecord = conversation.getByText('Raw record', { exact: true });
  await expect(rawRecord).toHaveCount(1);
  const details = rawRecord.locator('..');
  await expect(details).not.toHaveAttribute('open', '');
  await expect(conversation.getByText(/Normalized model name/)).toBeHidden();
  await rawRecord.click();
  await expect(conversation.getByText(/Normalized model name/)).toBeVisible();
  await expect(conversation.getByText(/review diff/)).toBeVisible();
  await expect(conversation.getByText(/megacorps-report/)).toBeVisible();

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await conversation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await conversation.screenshot({ path: info.outputPath(`report-${width}.png`) });
  expect(fixture.errors).toEqual([]);
  expect(fixture.failed).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
