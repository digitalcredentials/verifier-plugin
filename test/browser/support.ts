import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

/** Reads the card once the verification that follows an action has landed. */
export const settle = async (page: Page, act: () => Promise<void>) => {
  const before = await page.evaluate(() => window.__done ?? 0);
  await act();
  await page.waitForFunction((n) => (window.__done ?? 0) > n, before, { timeout: 30_000 });
};

export const card = (page: Page) =>
  page.evaluate(() => {
    const root = document.getElementById('vc')!.shadowRoot!;
    const text = (sel: string) => root.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const glyph = root.querySelector('.glyph');
    return {
      severity: glyph ? [...glyph.classList].find((c) => c.startsWith('s-'))!.slice(2) : '',
      headline: text('.headline'),
      detail: text('.detail'),
      action: text('.action'),
      live: text('[role="status"]'),
    };
  });

/**
 * verifier-core fetches the Open Badges schema from purl.imsglobal.org on
 * every verification, uncached. On 1 October 2026 one fetch took 52s and
 * timed out 11 tests, so the tests serve a copy instead, downloaded from
 * SCHEMA on that date (Last-Modified 23 October 2025). To refresh it,
 * download SCHEMA over the copy. Any other request to that host is refused
 * and fails the test, so a new dependency on it shows up straight away
 * rather than as a slow run. Nate plans to drop this schema check from
 * verifier-core; once it is gone, delete the copy and this route, and the
 * schema plumbing for the cross-site tests in states.spec.ts: its copy in
 * pages-like-server.js, FIXTURES_SCHEMA_URL in scripts/make-fixtures.js, and
 * its empty override in scripts/build-site.js.
 */
export const SCHEMA = 'https://purl.imsglobal.org/spec/ob/v3p0/schema/json/ob_v3p0_achievementcredential_schema.json';
const SCHEMA_COPY = fileURLToPath(new URL('./fixtures/ob_v3p0_achievementcredential_schema.json', import.meta.url));
/** Every request to purl.imsglobal.org, seen by listening, which (unlike a route) changes nothing. */
export const purl: string[] = [];

/**
 * Sets up every test in the calling file: the schema copy above, and a count
 * of finished verifications (`window.__done`) for settle() to wait on.
 * Before the page is opened, which each file does its own way.
 */
export const preparePages = () => {
  test.beforeEach(async ({ page }) => {
    purl.length = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).hostname === 'purl.imsglobal.org') purl.push(r.url());
    });
    await page.route('https://purl.imsglobal.org/**', (route) =>
      route.request().url() === SCHEMA
        ? route.fulfill({ path: SCHEMA_COPY, headers: { 'access-control-allow-origin': '*' } })
        : route.abort('blockedbyclient'),
    );
    await page.addInitScript(() => {
      window.__done = 0;
      document.addEventListener('verification-complete', (e) => {
        window.__response = (e as CustomEvent).detail.response;
        (window.__done as number)++;
      });
      document.addEventListener('verification-failed', () => (window.__done as number)++);
    });
  });

  test.afterEach(() => {
    expect(
      purl.filter((url) => url !== SCHEMA),
      'requests to purl.imsglobal.org other than the schema',
    ).toEqual([]);
  });
};
