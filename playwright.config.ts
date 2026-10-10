import { defineConfig } from '@playwright/test';

const voicePort = 7810;
const demoPort = 5183;
// Set to test an already running stack instead, e.g. `docker compose up`:
//   E2E_BASE_URL=http://localhost:5173 npx playwright test
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: external ?? `http://localhost:${demoPort}`,
    launchOptions: {
      // Fake microphone (a tone) and auto-granted permissions: real audio
      // flows end to end without a sound card.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    permissions: ['microphone'],
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: external
    ? undefined
    : {
        command: 'node scripts/dev.mjs --no-build',
        url: `http://localhost:${voicePort}/healthz`,
        reuseExistingServer: false,
        timeout: 30_000,
        env: {
          PORT: String(voicePort),
          DEMO_PORT: String(demoPort),
          RTC_PORT_BASE: '40100',
          NUM_WORKERS: '2',
          LOG_LEVEL: 'warn',
          // Keep test runs out of the developer's manual-test logs.
          DEV_LOG_DIR: 'test-results/dev-logs',
        },
      },
});
