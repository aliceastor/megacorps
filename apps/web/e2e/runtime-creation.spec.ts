import { expect, test } from '@playwright/test';
test('new runtimes hide SSH and unrelated legacy edits preserve every connection field', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  const legacy = {
    id: 'legacy',
    companyId: 'company',
    name: 'Legacy runtime',
    adapterType: 'hermes-ssh',
    localWorkspaceRoot: '/synthetic/work',
    localScratchRoot: '/synthetic/scratch',
    nfsMountRoot: '/synthetic/nfs',
    isActive: true,
    config: {
      sshHost: 'runtime.example.test',
      sshUser: 'worker',
      sshPort: 2222,
      sshKeyPath: '/synthetic/key',
      sshOptions: '-o BatchMode=yes',
      hermesCommand: 'hermes',
      model: 'legacy-model',
      customField: 'preserve-me',
      apiToken: 'synthetic-credential-sentinel',
    },
  };
  let saved: any;
  await page.route('**/api/proxy/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/proxy', '');
    let json: any = [];
    if (path === '/api/me')
      json = { user: { id: 'user', email: 'legacy@example.test', role: 'admin' }, memberships: [] };
    else if (path === '/api/companies') json = [{ id: 'company', name: 'Company', slug: 'company' }];
    else if (path === '/api/agent-runtimes') json = [legacy];
    else if (path === '/api/agent-runtimes/legacy' && req.method() === 'PUT') {
      saved = req.postDataJSON();
      json = { ...legacy, ...saved };
    } else if (path.includes('/api/notifications')) json = { notifications: [], unreadCount: 0 };
    await route.fulfill({ json });
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Adapter', exact: true }).locator('option[value="hermes-ssh"]'),
  ).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Adapter', exact: true })).toHaveValue('a2a');
  await page.screenshot({ path: testInfo.outputPath('new-runtime-modes.png'), fullPage: true });
  await page
    .locator('.list-row')
    .filter({ hasText: 'Legacy runtime' })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Adapter', exact: true }).locator('option:checked'),
  ).toContainText('legacy');
  await page.getByRole('combobox', { name: 'Adapter', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('legacy-runtime-edit.png'), fullPage: true });
  await page.getByLabel('Name', { exact: true }).fill('Renamed legacy');
  await page.getByRole('button', { name: 'Save runtime', exact: true }).click();
  await expect.poll(() => saved?.name).toBe('Renamed legacy');
  expect(saved.adapterType).toBe('hermes-ssh');
  expect(saved.config).toEqual(legacy.config);
  expect(saved.localWorkspaceRoot).toBe(legacy.localWorkspaceRoot);
  expect(saved.localScratchRoot).toBe(legacy.localScratchRoot);
  expect(saved.nfsMountRoot).toBe(legacy.nfsMountRoot);
  await page.goto('/agents');
  await page.getByRole('button', { name: 'New Agent', exact: true }).click();
  const modal = page.locator('.agent-wizard-modal');
  await modal.getByRole('textbox', { name: 'Name', exact: true }).fill('New agent');
  await modal.getByRole('textbox', { name: 'Slug', exact: true }).fill('new-agent');
  await modal.getByRole('button', { name: 'Next', exact: true }).click();
  await modal.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(modal.getByRole('combobox', { name: 'Adapter', exact: true })).toHaveValue('a2a');
  await expect(modal.locator('option[value="hermes-ssh"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('new-agent-modes.png'), fullPage: true });
});
