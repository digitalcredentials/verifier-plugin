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
    document.addEventListener('verification-complete', (e) => {
      window.__response = (e as CustomEvent).detail.response;
      (window.__done as number)++;
    });
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
  // The headline names the date, so nothing restates it underneath. What
  // does sit there is what reported: the seal held (the library checks dates
  // after it), and the issuer set up no way to withdraw it.
  expect(c.headline).toContain('Expired on');
  expect(c.detail).toBe("It hasn't been tampered with, and the issuer hasn't withdrawn it.");
  expect(c.detail).not.toContain('run out');
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
  // Said without assuming the reader knows what a signature is for.
  expect(c.headline).toContain("can't tell if this is genuine");
  expect(c.detail).toContain('digital seal');
  expect(c.detail).not.toContain('signature');
});

test('the issuer name is marked when the seal did not hold', async ({ page }) => {
  // Changed and No signature: the name at the top is only the credential's
  // own claim, and it says so, as Issuer unknown already does.
  for (const label of ['Changed', 'No signature']) {
    await pick(page, label);
    const meta = await page.evaluate(
      () => document.getElementById('vc')!.shadowRoot!.querySelector('.meta')?.textContent ?? '',
    );
    expect(meta, label).toContain('Springfield College (unconfirmed)');
  }
  // ...and not when it held, expired or not.
  for (const label of ['Verified', 'Expired']) {
    await pick(page, label);
    const meta = await page.evaluate(
      () => document.getElementById('vc')!.shadowRoot!.querySelector('.meta')?.textContent ?? '',
    );
    expect(meta, label).not.toContain('unconfirmed');
  }
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

/** One of the card's three views, found the way a person finds it: by name. */
const viewButton = (page: Page, name: string) =>
  page.locator('#vc').getByRole('button', { name, exact: true });

/** Which view is showing, as a screen reader is told it. */
const pressedView = (page: Page) =>
  page.evaluate(() =>
    [...document.getElementById('vc')!.shadowRoot!.querySelectorAll('button[data-view]')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent!.trim()),
  );

const detailRows = (page: Page) =>
  page.evaluate(() =>
    [...document.getElementById('vc')!.shadowRoot!.querySelectorAll('.check')].map((r) =>
      r.textContent!.replace(/\s+/g, ' ').trim(),
    ),
  );

test('details are showing without being asked for, and list the checks that ran', async ({ page }) => {
  await pick(page, 'Withdrawn');
  expect(await pressedView(page)).toEqual(['Details']);
  const rows = await detailRows(page);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.join(' ')).toContain('Withdrawal');
});

test.describe('the three views', () => {
  test('switching views does not re-announce, and keeps focus on the button used', async ({ page }) => {
    await pick(page, 'Withdrawn');
    // Count every write to the live region from here on. Showing the same
    // result another way is not news.
    await page.evaluate(() => {
      const live = document.getElementById('vc')!.shadowRoot!.querySelector('[role="status"]')!;
      window.__announced = 0;
      new MutationObserver(() => (window.__announced as number)++).observe(live, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });

    const focusedView = () =>
      page.evaluate(
        () => (document.getElementById('vc')!.shadowRoot!.activeElement as HTMLElement | null)?.dataset['view'],
      );

    await viewButton(page, 'Developer view').click();
    expect(await pressedView(page)).toEqual(['Developer view']);
    expect(await focusedView()).toBe('developer');

    // And from the keyboard alone.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    expect(await pressedView(page)).toEqual(['JSON']);
    expect(await focusedView()).toBe('json');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Space');
    expect(await pressedView(page)).toEqual(['Details']);
    expect(await focusedView()).toBe('details');

    expect(await page.evaluate(() => window.__announced)).toBe(0);
  });

  test('the developer view shows every check, in the library’s groups and words', async ({ page }) => {
    await pick(page, 'Withdrawn');
    await viewButton(page, 'Developer view').click();
    const { shown, expected } = await page.evaluate(() => {
      const root = document.getElementById('vc')!.shadowRoot!;
      const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const r = window.__response as {
        verified: boolean;
        summary: { id: string; message: string }[];
        results: { outcome: { status: string } }[];
      };
      return {
        shown: {
          bar: text(root.querySelector('.dev-bar')),
          groups: [...root.querySelectorAll('.suite')].map((g) => ({
            id: text(g.querySelector('.suite-id')),
            message: text(g.querySelector('.suite-count')),
          })),
          checks: root.querySelectorAll('.dev-check').length,
          text: text(root.querySelector('.dev')),
        },
        expected: {
          verified: r.verified,
          groups: r.summary.map((s) => ({ id: s.id, message: s.message })),
          checks: r.results.length,
        },
      };
    });
    expect(shown.bar).toContain(`verified: ${expected.verified}`);
    expect(shown.groups).toEqual(expected.groups);
    expect(shown.checks).toBe(expected.checks);
    // Passed, skipped and failed checks all appear, each in the library's own
    // words, with the status said as well as drawn.
    expect(shown.text).toContain('Passed: context-exists');
    expect(shown.text).toContain('Credential has a valid @context property.');
    expect(shown.text).toContain('Failed: bitstring');
    expect(shown.text).toContain('Credential Revoked or Suspended');
    expect(shown.text).toContain('The credential has been revoked or suspended according to the status list.');
    // A real space, or a screen reader says "context-existsfatal".
    expect(shown.text).toContain('context-exists fatal');
  });

  test('the developer view says why a check was skipped', async ({ page }) => {
    await pick(page, 'Verified');
    await viewButton(page, 'Developer view').click();
    const text = await page.evaluate(
      () => document.getElementById('vc')!.shadowRoot!.querySelector('.dev')!.textContent!.replace(/\s+/g, ' '),
    );
    expect(text).toContain('Skipped: bitstring');
    expect(text).toContain('Credential has no credentialStatus.');
  });

  test('the JSON view shows the credential exactly as it was passed in', async ({ page }) => {
    await pick(page, 'Expired');
    await viewButton(page, 'JSON').click();
    // Compared with a fresh copy of the file, not with the object the card
    // holds, so a credential altered in place during checking would show up.
    const { shown, given } = await page.evaluate(async () => {
      const el = document.getElementById('vc')!;
      const given = await (await fetch('./fixtures/expired.json')).json();
      return { shown: el.shadowRoot!.querySelector('pre.json')!.textContent!, given };
    });
    expect(JSON.parse(shown)).toEqual(given);
    // Not the verification result, which has its own view.
    expect(shown).not.toContain('"results"');
  });

  test('a new credential opens on Details again', async ({ page }) => {
    await pick(page, 'Verified');
    await viewButton(page, 'JSON').click();
    await pick(page, 'Withdrawn');
    expect(await pressedView(page)).toEqual(['Details']);
    expect((await detailRows(page)).join(' ')).toContain('withdrawn by the issuer');
  });

  /**
   * verifier-core returns a result for everything we could find to feed it —
   * strings, null, bad registries — so the only way to reach this state is a
   * credential that throws when the library reads it. `toJSON` hands back a
   * plain copy, so the JSON view can still show what was given.
   */
  const hostileCredential = (page: Page, thrown: 'error' | 'object') =>
    settle(page, () =>
      page.evaluate(async (thrown) => {
        const plain = await (await fetch('./fixtures/verified.json')).json();
        const credential: Record<string, unknown> = { ...plain, toJSON: () => plain };
        Object.defineProperty(credential, 'proof', {
          enumerable: true,
          get() {
            throw thrown === 'error' ? new TypeError('proof exploded') : {};
          },
        });
        (document.getElementById('vc') as HTMLElement & { credential?: unknown }).credential = credential;
      }, thrown),
    );

  test('a check that failed outright still shows the credential, and the error', async ({ page }) => {
    await hostileCredential(page, 'error');
    const c = await card(page);
    expect(c.headline).toContain('couldn’t finish checking');
    expect(await pressedView(page)).toEqual(['Details']);
    const root = () => page.evaluate(() => {
      const r = document.getElementById('vc')!.shadowRoot!;
      return {
        empty: r.querySelector('.empty')?.textContent ?? '',
        dev: r.querySelector('.dev')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        json: r.querySelector('pre.json')?.textContent ?? '',
        foot: !!r.querySelector('.foot'),
      };
    });
    const details = await root();
    expect(details.empty).toContain('Developer view shows the error');
    // There was no check to report "just now".
    expect(details.foot).toBe(false);

    await viewButton(page, 'Developer view').click();
    const dev = (await root()).dev;
    expect(dev).toContain('TypeError');
    expect(dev).toContain('proof exploded');
    // The message, never the stack.
    expect(dev).not.toMatch(/\bat\s+\S+\s*\(/);

    await viewButton(page, 'JSON').click();
    const given = await page.evaluate(async () => (await fetch('./fixtures/verified.json')).json());
    expect(JSON.parse((await root()).json)).toEqual(given);
  });

  test('an error with no message says so, rather than showing nothing', async ({ page }) => {
    await hostileCredential(page, 'object');
    await viewButton(page, 'Developer view').click();
    const dev = await page.evaluate(
      () => document.getElementById('vc')!.shadowRoot!.querySelector('.dev')!.textContent!,
    );
    expect(dev).toContain('It gave no message.');
  });

  test('there are no views to switch while checking', async ({ page }) => {
    const buttons = await page.evaluate(async () => {
      const el = document.getElementById('vc') as HTMLElement & { credential?: unknown };
      el.credential = await (await fetch('./fixtures/verified.json')).json();
      await new Promise((r) => setTimeout(r, 0));
      return el.shadowRoot!.querySelectorAll('button[data-view]').length;
    });
    expect(buttons).toBe(0);
  });
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
    // ...but Details has no rows to show, and says where to look instead.
    expect(await detailRows(page)).toEqual([]);
    const empty = await page.evaluate(
      () => document.getElementById('vc')!.shadowRoot!.querySelector('.empty')?.textContent ?? '',
    );
    expect(empty).toContain('Developer view');
    // The library still ran checks, and the developer view has them.
    await viewButton(page, 'Developer view').click();
    const checks = await page.evaluate(
      () => document.getElementById('vc')!.shadowRoot!.querySelectorAll('.dev-check').length,
    );
    expect(checks).toBeGreaterThan(0);
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
    expect((await detailRows(page)).length).toBeGreaterThan(0);
    await viewButton(page, 'Developer view').click();

    // Mid-check, the old run's rows and checks must be gone rather than
    // sitting under a verdict that no longer describes them.
    const during = await page.evaluate(async () => {
      const el = document.getElementById('vc') as HTMLElement & { registries?: unknown };
      el.registries = [];
      await new Promise((r) => setTimeout(r, 0));
      return el.shadowRoot!.querySelectorAll('.check, .dev-check').length;
    });
    expect(during).toBe(0);

    // And the new result opens on Details, not on the view the old one was left in.
    await page.waitForFunction(
      () => !!document.getElementById('vc')!.shadowRoot!.querySelector('button[data-view]'),
    );
    expect(await pressedView(page)).toEqual(['Details']);
  });

  test('a detail row is not read out as "Verified: none"', async ({ page }) => {
    await pick(page, 'Verified');
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
