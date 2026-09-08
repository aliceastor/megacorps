import { expect, test } from '@playwright/test';
import { bossId, cardId, companyId, headId, productFixture } from './product-fixture';

for (const width of [390, 1280]) test(`recovery ownership and reason stay readable at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await productFixture(page, true);
  const row = { id: cardId, companyId, title: 'Recovery fixture', body: 'Deliver the assigned project artifact.', columnStatus: 'needs_review', assigneeId: headId, reviewerId: bossId, priority: 0, tags: [], protocolRepairState: { recovery: { mode: 'awaiting_manager', ownerId: bossId, reason: 'Reported PR belongs to a different repository.', round: 1 } } };
  await page.route(/\/api\/proxy\/api\/cards(?:\?|$)/, route => route.fulfill({ json: [row] }));
  await page.goto('/kanban');
  await page.getByText('Recovery fixture', { exact: true }).click();
  const situation = page.locator('.overview-situation');
  await expect(situation).toContainText('Waiting for Boss Alpha to resolve');
  await expect(situation).toContainText('Reported PR belongs to a different repository.');
  const box = (await situation.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await situation.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await situation.screenshot({ path: info.outputPath('recovery-owner.png') });
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('human recovery requires guidance and resumes without approving the deliverable', async ({ page }) => {
  const fixture = await productFixture(page, true);
  const row = { id: cardId, companyId, title: 'Human recovery fixture', body: 'Deliver the assigned project artifact.', columnStatus: 'in_review', assigneeId: headId, priority: 0, tags: [], protocolRepairState: { recovery: { mode: 'awaiting_human', reason: 'Clarify the required project scope.', round: 3 } } };
  const gate = { id: 'recovery-gate', cardId, companyId, type: 'task_review', status: 'pending', payload: { humanGate: true, kind: 'recovery', reason: 'Clarify the required project scope.' } };
  const writes: unknown[] = [];
  await page.route(/\/api\/proxy\/api\/cards(?:\?|$)/, route => route.fulfill({ json: [row] }));
  await page.route(/\/api\/proxy\/api\/approvals(?:\?|$)/, route => route.fulfill({ json: [gate] }));
  await page.route('**/api/proxy/api/approvals/recovery-gate', async route => {
    expect(route.request().method()).toBe('PUT');
    writes.push(route.request().postDataJSON());
    gate.status = 'answered'; row.columnStatus = 'todo'; row.protocolRepairState.recovery.mode = 'reworking';
    await route.fulfill({ json: gate });
  });
  await page.goto('/kanban');
  await page.getByText('Human recovery fixture', { exact: true }).click();
  const form = page.locator('.approval-decision-form');
  const resume = form.getByRole('button', { name: 'Send guidance and resume', exact: true });
  await expect(resume).toBeDisabled();
  await expect(form).not.toContainText('→ Done');
  await form.getByRole('textbox').fill('Use the assigned project and return through its normal review.');
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect.poll(() => writes).toEqual([{ status: 'approved', decisionNote: 'Use the assigned project and return through its normal review.' }]);
  await expect(form).toHaveCount(0);
  await expect(page.locator('.overview-situation')).toContainText('Clarify the required project scope.');
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
