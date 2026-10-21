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
 * Every request to purl.imsglobal.org, where the Open Badges schemas live,
 * seen by listening, which (unlike a route) changes nothing.
 *
 * Until 2.0.0-beta.1 verifier-core fetched a schema from there on every
 * verification, uncached; on 1 October 2026 one fetch took 52s and timed out
 * 11 tests, and the tests served a copy. It now validates against schemas
 * bundled with it, so any request there fails the test: a new dependency on
 * that host shows up straight away rather than as a slow run.
 */
export const purl: string[] = [];

/**
 * Sets up every test in the calling file: the watch on purl above, and a
 * count of finished verifications (`window.__done`) for settle() to wait on.
 * Before the page is opened, which each file does its own way.
 */
export const preparePages = () => {
  test.beforeEach(async ({ page }) => {
    purl.length = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).hostname === 'purl.imsglobal.org') purl.push(r.url());
    });
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
    expect(purl, 'requests to purl.imsglobal.org').toEqual([]);
  });
};
