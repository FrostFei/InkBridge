import { defineConfig } from '@playwright/test';
import shared from './playwright.config';

export default defineConfig({
  ...shared,
  testDir: './tests/pages',
  use: { ...shared.use, baseURL: 'http://127.0.0.1:4174/InkBridge/' },
  webServer: {
    command: 'npm run preview:pages',
    url: 'http://127.0.0.1:4174/InkBridge/',
    reuseExistingServer: false,
  },
});
