import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export default defineConfig({
  testDir: './test', fullyParallel: false, workers: 1, timeout: 45000,
  use: { baseURL: 'http://localhost:3000', headless: true, viewport: { width: 1440, height: 1000 },
    ...(process.platform === 'win32' ? { channel: 'chrome' } : {}), screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  outputDir: '../.browser-test/results', reporter: [['list'], ['html', { outputFolder: '../.browser-test/report', open: 'never' }]],
  webServer: [
    { command: 'node --import tsx scripts/browser-test-server.ts', cwd: root, url: 'http://127.0.0.1:4100/health/ready', timeout: 90000, reuseExistingServer: false, env: { NODE_ENV: 'test' } },
    { command: 'npm run admin:dev', cwd: root, url: 'http://localhost:3000', timeout: 90000, reuseExistingServer: false,
      env: { ADMIN_API_PROXY_TARGET: 'http://127.0.0.1:4100', GOOGLE_MAPS_API_KEY: '', GOOGLE_MAPS_MAP_ID: '' } },
  ],
});
