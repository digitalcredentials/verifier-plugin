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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__done = 0;
    document.addEventListener('verification-complete', () => (window.__done as number)++);
    document.addEventListener('verification-failed', () => (window.__done as number)++);
  });
  await page.goto('/');
  await page.waitForFunction(() => (window.__done ?? 0) > 0, null, { timeout: 30_000 });
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
  expect(rows.join(' ')).toContain('Withdrawn by issuer');
});

test.describe('lifecycle, from review', () => {
  test('a slow earlier check cannot overwrite a newer one', async ({ page }) => {
    // Switch twice without waiting. Whatever lands must match the last pick.
    await page.getByRole('button', { name: 'Withdrawn', exact: true }).click();
    await page.getByRole('button', { name: 'Expired', exact: true }).click();
    await page.waitForTimeout(3000);
    const c = await card(page);
    expect(c.severity).toBe('warning');
    expect(c.headline).toContain('end date');
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
        { name: 'Local Dev Registry', type: 'dcc-legacy', url: 'http://localhost:5180/fixtures/registry.json' },
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
