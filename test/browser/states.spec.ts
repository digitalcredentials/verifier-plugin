import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';

/**
 * Drives the real component against really-signed credentials, in a real
 * browser, with real verification. The unit tests cover the mapping; this
 * covers the parts only a browser can tell us.
 */

/** Reads the card once the verification that follows an action has landed. */
const settle = async (page: Page, act: () => Promise<void>) => {
  const before = await page.evaluate(() => window.__done ?? 0);
  await act();
  await page.waitForFunction((n) => (window.__done ?? 0) > n, before, { timeout: 30_000 });
};

const card = (page: Page) =>
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
 * verifier-core; once it is gone, delete the copy, this route, and its other
 * use in pages-like-server.js.
 */
const SCHEMA = 'https://purl.imsglobal.org/spec/ob/v3p0/schema/json/ob_v3p0_achievementcredential_schema.json';
const SCHEMA_COPY = fileURLToPath(new URL('./fixtures/ob_v3p0_achievementcredential_schema.json', import.meta.url));
const stray: string[] = [];

test.beforeEach(async ({ page }) => {
  stray.length = 0;
  await page.route('https://purl.imsglobal.org/**', (route) => {
    if (route.request().url() === SCHEMA) {
      return route.fulfill({ path: SCHEMA_COPY, headers: { 'access-control-allow-origin': '*' } });
    }
    stray.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  await page.addInitScript(() => {
    window.__done = 0;
    document.addEventListener('verification-complete', () => (window.__done as number)++);
    document.addEventListener('verification-failed', () => (window.__done as number)++);
  });
  // Relative, so it lands in the site's sub-folder when the tests run
  // against a published copy (PLAYWRIGHT_BASE_URL), not at the domain root.
  await page.goto('./');
  await page.waitForFunction(() => (window.__done ?? 0) > 0, null, { timeout: 30_000 });
});

test.afterEach(() => {
  expect(stray, 'requests to purl.imsglobal.org other than the schema').toEqual([]);
});

const pick = async (page: Page, label: string) => {
  await settle(page, async () => {
    await page.getByRole('button', { name: label, exact: true }).click();
  });
  return card(page);
};

test('a good credential from a known issuer verifies', async ({ page }) => {
  const c = await pick(page, 'Verified');
  expect(c.severity).toBe('success');
  expect(c.headline).toContain('Verified');
});

test('an expired credential is a warning, and says what to do', async ({ page }) => {
  const c = await pick(page, 'Expired');
  expect(c.severity).toBe('warning');
  expect(c.action).not.toBe('');
});

test('a withdrawn credential is an error and asks for a replacement', async ({ page }) => {
  const c = await pick(page, 'Withdrawn');
  expect(c.severity).toBe('error');
  expect(c.action).toContain('new copy');
});

test('an altered credential is an error and asks for a fresh copy', async ({ page }) => {
  const c = await pick(page, 'Changed');
  expect(c.severity).toBe('error');
  expect(c.action).toContain('fresh copy');
});

/**
 * The one state verifier-core itself calls a pass. Its schema result never
 * reaches `verified`, so this whole case is invisible to anything reading the
 * log alone — and it only shows up here because the schema was really
 * fetched and really validated against.
 */
test('a credential built wrong is a warning, and asks nothing of the holder', async ({ page }) => {
  const c = await pick(page, 'Built wrong');
  expect(c.severity).toBe('warning');
  expect(c.severity).not.toBe('error');
  expect(c.headline).toContain('missing information');
  // It is the issuer's to fix, and the card says so rather than inventing a
  // task for someone who cannot perform it.
  expect(c.action).toContain('Springfield College');
  expect(c.action).toContain('nothing for you to do');
});

test('a credential with no signature says so plainly', async ({ page }) => {
  const c = await pick(page, 'No signature');
  expect(c.severity).toBe('error');
  expect(c.headline).toContain('no signature');
});

test('an unrecognised issuer is never called fake', async ({ page }) => {
  const c = await pick(page, 'Issuer unknown');
  expect(c.severity).not.toBe('error');
  expect(c.headline).toContain('Genuine');
  expect(c.detail).toContain("doesn't mean the credential is fake");
});

test('an unreachable registry reads differently from an unlisted issuer', async ({ page }) => {
  const offline = await pick(page, 'Registry offline');
  const unknown = await pick(page, 'Issuer unknown');

  // Both come back from the library as the same plain failure. If these ever
  // read alike, the distinction has been lost somewhere.
  expect(offline.headline).not.toBe(unknown.headline);
  expect(offline.severity).toBe('unchecked');
  expect(offline.detail).toContain('Local Dev Registry');
  expect(offline.action).not.toBe('');
});

/**
 * Found in review. The spoken headline was HTML-escaped on its way into a
 * `textContent` assignment, so a screen reader on the unconfirmed-issuer card
 * heard "we can&#39;t confirm who issued this". Only a headline carrying an
 * ASCII apostrophe showed it, which is why every earlier test missed it.
 */
test('the spoken verdict is words, not HTML entities', async ({ page }) => {
  for (const label of ['Issuer unknown', 'Registry offline', 'Built wrong']) {
    const c = await pick(page, label);
    expect(c.live, `${label} is read out with an entity in it`).not.toMatch(/&(#\d+|amp|quot|lt|gt);/);
    expect(c.live).not.toBe('');
  }
  // The card itself still escapes, because that path really is HTML.
  const c = await pick(page, 'Issuer unknown');
  expect(c.headline).toContain("can't");
});

test('the result is announced, not only drawn', async ({ page }) => {
  const c = await pick(page, 'Withdrawn');
  expect(c.live).toContain('Problem');
  expect(c.live).toContain('withdrawn');
});

test('the severity is not said twice when the headline already says it', async ({ page }) => {
  const c = await pick(page, 'Verified');
  expect(c.live).not.toMatch(/verified[.,]?\s+verified/i);
});

test('details open and list the checks that ran', async ({ page }) => {
  await pick(page, 'Withdrawn');
  const toggle = page.locator('#vc').locator('#toggle');
  await toggle.click();
  const rows = await page.evaluate(() =>
    [...document.getElementById('vc')!.shadowRoot!.querySelectorAll('.check')].map((r) =>
      r.textContent!.replace(/\s+/g, ' ').trim(),
    ),
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.join(' ')).toContain('Withdrawal');
});

test.describe('lifecycle, from review', () => {
  test('a slow earlier check cannot overwrite a newer one', async ({ page }) => {
    // Switch twice without waiting. Whatever lands must match the last pick.
    await page.getByRole('button', { name: 'Withdrawn', exact: true }).click();
    await page.getByRole('button', { name: 'Expired', exact: true }).click();
    await page.waitForTimeout(3000);
    const c = await card(page);
    expect(c.severity).toBe('warning');
    expect(c.headline).toContain('Expired');
  });

  test('a credential set while detached is still verified on reattach', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const el = document.createElement('verifier-credential') as HTMLElement & {
        credential?: unknown;
        registries?: unknown;
      };
      const credential = await (await fetch('./fixtures/verified.json')).json();
      // Set before it is ever in the document, as React does on remount.
      el.registries = [
        { name: 'Local Dev Registry', type: 'dcc-legacy', url: new URL('./fixtures/registry.json', location.href).href },
      ];
      el.credential = credential;
      const done = new Promise((resolve) =>
        el.addEventListener('verification-complete', (e) => resolve((e as CustomEvent).detail.outcome), { once: true }),
      );
      document.body.append(el);
      const outcome = (await Promise.race([
        done,
        new Promise((r) => setTimeout(() => r(null), 20000)),
      ])) as { severity: string } | null;
      el.remove();
      return outcome;
    });
    expect(result, 'never verified after being attached').not.toBeNull();
    expect(result!.severity).toBe('success');
  });

  test('clearing the credential clears the verdict with it', async ({ page }) => {
    await pick(page, 'Verified');
    await page.evaluate(() => {
      (document.getElementById('vc') as HTMLElement & { credential?: unknown }).credential = undefined;
    });
    const c = await card(page);
    expect(c.headline).toBe('');
    expect(c.severity).toBe('');
  });

  test('changing the registries re-checks rather than keeping a stale verdict', async ({ page }) => {
    await pick(page, 'Verified');
    expect((await card(page)).severity).toBe('success');

    const severity = await page.evaluate(async () => {
      const el = document.getElementById('vc') as HTMLElement & { registries?: unknown };
      const done = new Promise((resolve) =>
        el.addEventListener('verification-complete', (e) => resolve((e as CustomEvent).detail.outcome.severity), { once: true }),
      );
      el.registries = [];
      const timeout = new Promise((r) => setTimeout(() => r(null), 20000));
      return (await Promise.race([done, timeout])) as string | null;
    });
    expect(severity, 'setting registries did not re-verify').not.toBeNull();
    expect(severity).toBe('unchecked');
  });

  test('setting registries and credential together checks once, not twice', async ({ page }) => {
    // A host sets several properties in a row. Verifying on each one would
    // check the old credential against the new registries and discard the
    // answer, doubling every registry and status-list fetch.
    const starts = await page.evaluate(async () => {
      const el = document.getElementById('vc') as HTMLElement & {
        credential?: unknown;
        registries?: unknown;
      };
      let started = 0;
      const count = () => started++;
      el.addEventListener('verification-started', count);
      const credential = await (await fetch('./fixtures/expired.json')).json();
      el.registries = [];
      el.credential = credential;
      await new Promise((r) => setTimeout(r, 4000));
      el.removeEventListener('verification-started', count);
      return started;
    });
    expect(starts).toBe(1);
  });

  test('a credential that stopped early still says it was checked', async ({ page }) => {
    await pick(page, 'No signature');
    const foot = await page.evaluate(
      () => document.getElementById('vc')!.shadowRoot!.querySelector('.foot')?.textContent?.trim(),
    );
    expect(foot).toContain('Checked');
    // ...but there is no per-check list to open.
    const toggle = await page.evaluate(
      () => !!document.getElementById('vc')!.shadowRoot!.querySelector('#toggle'),
    );
    expect(toggle).toBe(false);
  });

  test('does not say "checked just now" while it is still checking', async ({ page }) => {
    // The footer reports when we checked, so it has no business appearing
    // before a check has finished.
    const footWhileChecking = await page.evaluate(async () => {
      const el = document.getElementById('vc') as HTMLElement & { credential?: unknown };
      const credential = await (await fetch('./fixtures/verified.json')).json();
      el.credential = credential;
      await new Promise((r) => setTimeout(r, 0));
      const root = el.shadowRoot!;
      return {
        headline: root.querySelector('.headline')?.textContent?.trim() ?? '',
        foot: root.querySelector('.foot')?.textContent?.trim() ?? '',
      };
    });
    expect(footWhileChecking.headline).toContain('Checking');
    expect(footWhileChecking.foot).toBe('');
  });

  test('changing the registries clears the previous details, not just the verdict', async ({ page }) => {
    await pick(page, 'Verified');
    await page.locator('#vc').locator('#toggle').click();
    const before = await page.evaluate(
      () => document.getElementById('vc')!.shadowRoot!.querySelectorAll('.check').length,
    );
    expect(before).toBeGreaterThan(0);

    // Mid-check, the old run's rows must be gone rather than sitting under a
    // verdict that no longer describes them.
    const during = await page.evaluate(async () => {
      const el = document.getElementById('vc') as HTMLElement & { registries?: unknown };
      el.registries = [];
      await new Promise((r) => setTimeout(r, 0));
      return el.shadowRoot!.querySelectorAll('.check').length;
    });
    expect(during).toBe(0);
  });

  test('a detail row is not read out as "Verified: none"', async ({ page }) => {
    await pick(page, 'Verified');
    await page.locator('#vc').locator('#toggle').click();
    const spoken = await page.evaluate(() =>
      [...document.getElementById('vc')!.shadowRoot!.querySelectorAll('.check')]
        .map((r) => r.textContent!.replace(/\s+/g, ' ').trim())
        .join(' | '),
    );
    expect(spoken).toContain('Passed:');
    expect(spoken).not.toContain('Verified:');
  });

  test('the verdict is written into a live region that was already on the page', async ({ page }) => {
    // An innerHTML rebuild that creates the region already populated may never
    // be announced. It has to exist first and be written to afterwards.
    const before = await page.evaluate(() => {
      const r = document.getElementById('vc')!.shadowRoot!;
      return r.querySelectorAll('[role="status"]').length;
    });
    expect(before).toBe(1);

    await pick(page, 'Withdrawn');
    const after = await page.evaluate(() => {
      const r = document.getElementById('vc')!.shadowRoot!;
      return {
        count: r.querySelectorAll('[role="status"]').length,
        text: r.querySelector('[role="status"]')!.textContent!.trim(),
      };
    });
    expect(after.count).toBe(1);
    expect(after.text).toContain('withdrawn');
  });
});

/**
 * A wallet meets every withdrawal list on another site, and GitHub Pages
 * refuses the CORS preflight that a fetch with custom headers triggers. These
 * credentials come from pages-like-server.js on 127.0.0.1:5182 and name its
 * own list, so the card on localhost:5180 has to read that list across sites.
 * Local runs only: a published page is https, and cannot reach a server on
 * this machine.
 */
test.describe('a withdrawal list on another site', () => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, 'needs the local second site');

  const OTHER_SITE = 'http://127.0.0.1:5182';
  const purl: string[] = [];

  // Any active Playwright route stops Chromium refusing preflighted requests
  // across sites, so the schema route above has to go. These credentials name
  // the other site's copy of the schema instead, and listening (unlike
  // routing) leaves the browser's rules alone.
  test.beforeEach(async ({ page }) => {
    await page.unroute('https://purl.imsglobal.org/**');
    purl.length = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).hostname === 'purl.imsglobal.org') purl.push(r.url());
    });
  });

  test.afterEach(() => {
    expect(purl, 'requests to purl.imsglobal.org').toEqual([]);
  });

  /** Gives the card a credential from the other site; returns the library's seal and status checks. */
  const fromOtherSite = async (page: Page, file: string) => {
    let found = { seal: '', status: '' };
    await settle(page, async () => {
      found = await page.evaluate(async (url) => {
        const el = document.getElementById('vc') as HTMLElement & { credential?: unknown; registries?: unknown };
        const done = new Promise<{ seal: string; status: string }>((resolve) => {
          // Failed as well as complete, or a run that throws hangs to the
          // test timeout instead of saying why.
          el.addEventListener(
            'verification-failed',
            (e) => resolve({ seal: `verification failed: ${(e as CustomEvent).detail.error}`, status: '' }),
            { once: true },
          );
          el.addEventListener(
            'verification-complete',
            (e) => {
              const results = (e as CustomEvent).detail.response.results as {
                check: string;
                outcome: { status: string; problems?: { type: string }[] };
              }[];
              // The problem's name too: "failure" alone is also what an
              // unreachable list gives.
              const of = (id: string) => {
                const o = results.find((r) => r.check === id)?.outcome;
                const problem = o?.problems?.[0]?.type.split('#')[1];
                return o ? [o.status, problem].filter(Boolean).join(': ') : 'absent';
              };
              resolve({ seal: of('proof.signature'), status: of('status.bitstring') });
            },
            { once: true },
          );
        });
        const credential = await (await fetch(url)).json();
        // Both in one go: set apart, the registries alone would re-check the
        // demo's own credential, which fetches the schema from purl.
        el.registries = [
          { name: 'Local Dev Registry', type: 'dcc-legacy', url: new URL('./fixtures/registry.json', location.href).href },
        ];
        el.credential = credential;
        return done;
      }, `${OTHER_SITE}/${file}.json`);
    });
    return { ...found, card: await card(page) };
  };

  test('the other site refuses a preflight, as GitHub Pages does', async ({ page }) => {
    // If this stops holding, the tests below prove nothing about GitHub Pages.
    const probe = await page.evaluate(async (url) => {
      const plain = await fetch(url).then((r) => r.status, () => 'blocked');
      const preflighted = await fetch(url, { headers: { 'x-probe': '1' } }).then((r) => r.status, () => 'blocked');
      // A different host, not just a different port: ports don't make a
      // different site, and GitHub Pages is a different site to a wallet.
      return { plain, preflighted, otherHost: new URL(url).hostname !== location.hostname };
    }, `${OTHER_SITE}/status-list.json`);
    expect(probe).toEqual({ plain: 200, preflighted: 'blocked', otherHost: true });
  });

  test('a credential withdrawn on another site is still found withdrawn', async ({ page }) => {
    const { seal, status, card: c } = await fromOtherSite(page, 'withdrawn');
    // The seal too: a credential that fails it is an error anyway, and would
    // pass the rest of this for the wrong reason.
    expect(seal).toBe('success');
    expect(status).toBe('failure: CREDENTIAL_REVOKED_OR_SUSPENDED');
    expect(c.severity).toBe('error');
    expect(c.action).toContain('new copy');
  });

  test('a credential not withdrawn on another site is checked and clear', async ({ page }) => {
    const { seal, status, card: c } = await fromOtherSite(page, 'not-withdrawn');
    expect(seal).toBe('success');
    expect(status).toBe('success');
    expect(c.severity).toBe('success');
  });
});
