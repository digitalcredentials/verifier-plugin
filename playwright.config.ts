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
  // The status list and the dev registry are served by the dev server, on the
  // same origin as the page. They have to be: fetching a status list
  // cross-origin fails in a browser today. See src/verify.ts.
  webServer: published
    ? undefined
    : {
        command: 'npx vite --port 5180',
        url: 'http://localhost:5180',
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
