import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests: the built app (out/), driven through Playwright's
 * Electron support. Each test starts its own app on a fresh data folder.
 * Run with `npm run test:e2e` (builds first).
 */
export default defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: true,
    workers: process.env.CI ? 2 : 4,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
});
