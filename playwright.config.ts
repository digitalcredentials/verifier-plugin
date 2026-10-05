import { defineConfig } from '@playwright/test';

/**
 * Set PLAYWRIGHT_BASE_URL to run these against a published copy instead of a
 * local server — the preview workflow does, against each GitHub Pages
 * preview. Unset, they start the dev server on 5180 as before.
 */
// `||`, not `??`: an empty value means "not set". And always a trailing
// slash, or the tests' relative `./` would land one folder too high.
const raw = process.env.PLAYWRIGHT_BASE_URL || undefined;
const published = raw && (raw.endsWith('/') ? raw : `${raw}/`);

export default defineConfig({
  testDir: 'test/browser',
  use: { baseURL: published ?? 'http://localhost:5180' },
  // The demo's status list and dev registry are served by the dev server, on
  // the same origin as the page. The second server stands in for another
  // site, so the tests can also fetch a status list across sites, as a wallet
  // does. See test/browser/pages-like-server.js.
  webServer: published
    ? undefined
    : [
        {
          command: 'npx vite --port 5180',
          url: 'http://localhost:5180',
          reuseExistingServer: true,
          timeout: 60_000,
        },
        {
          command: 'node test/browser/pages-like-server.js',
          url: 'http://127.0.0.1:5182/status-list.json',
          // Never someone else's: a stray server on 5182 should fail the
          // run, not quietly answer for this one.
          reuseExistingServer: false,
          timeout: 30_000,
          // Not Playwright's default SIGKILL, which can't be handled: stopped
          // mid-start, the server would leave its temp folder behind. See
          // test/browser/pages-like-server.js.
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
        },
      ],
});
