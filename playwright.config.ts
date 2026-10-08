import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 浏览器测试以单个本地宿主验证工作台；不调用外部模型服务。 */
export default defineConfig({
  testDir: './tests',
  testMatch: 'ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4320',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --import tsx scripts/test-ui-dev.mjs',
    url: 'http://127.0.0.1:4320/api/project',
    reuseExistingServer: false,
    env: {
      PIXEL_PORT: '4320',
      PIXEL_API_PORT: '4321',
      PIXEL_STORAGE_DIR: join(tmpdir(), `pixel-e2e-${randomUUID()}`),
    },
    timeout: 60_000,
  },
});
