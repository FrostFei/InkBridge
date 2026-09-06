import { defineConfig, devices, chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
const localChrome =
  process.platform === 'win32' &&
  existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const channel =
  process.env.PLAYWRIGHT_CHANNEL ||
  (!existsSync(chromium.executablePath()) && localChrome ? 'chrome' : undefined);
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-ipad',
      use: { ...devices['iPad Pro 11'], defaultBrowserType: 'chromium', browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
