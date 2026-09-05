import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    browserName: 'chromium',
    colorScheme: 'dark',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.CI
      ? 'npm run start -- --hostname 127.0.0.1 --port 3100'
      : 'npm run dev -- --webpack --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100/help',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
