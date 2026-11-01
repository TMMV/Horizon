// @ts-check
const { defineConfig } = require('@playwright/test');
const fs = require('fs');

// Use the locally installed Microsoft Edge on Windows (no browser download needed).
// Elsewhere (CI, cloud sessions) run `npx playwright install chromium` first.
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const channel = process.env.PW_CHANNEL || (process.platform === 'win32' && fs.existsSync(edgePath) ? 'msedge' : undefined);

module.exports = defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    channel,
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
    acceptDownloads: true,
  },
});
