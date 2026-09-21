import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser',
  use: { baseURL: 'http://localhost:5180' },
  // The status list and the dev registry are served by the dev server, on the
  // same origin as the page. They have to be: fetching a status list
  // cross-origin fails in a browser today. See src/verify.ts.
  webServer: {
    command: 'npx vite --port 5180',
    url: 'http://localhost:5180',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
