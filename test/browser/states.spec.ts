import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { CHECK, PROBLEM } from '../../src/types.js';
import { card, preparePages, settle } from './support.js';

/**
 * Drives the real component against really-signed credentials, in a real
 * browser, with real verification. The unit tests cover the mapping; this
 * covers the parts only a browser can tell us.
 */

preparePages();

test.beforeEach(async ({ page }) => {
  // Relative, so it lands in the site's sub-folder when the tests run
  // against a published copy (PLAYWRIGHT_BASE_URL), not at the domain root.
  await page.goto('./');
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
  // after it). The issuer set up no way to deactivate it, so "the issuer
  // hasn't deactivated it" isn't said.
  expect(c.headline).toContain('Expired on');
  expect(c.detail).toBe("It hasn't been tampered with.");
  expect(c.detail).not.toContain('run out');
});

test('a withdrawn credential is an error and asks for a replacement', async ({ page }) => {
  const c = await pick(page, 'Withdrawn');
  expect(c.severity).toBe('error');
  expect(c.action).toContain('current copy');
});

test('an altered credential is an error and asks for a fresh copy', async ({ page }) => {
  const c = await pick(page, 'Changed');
  expect(c.severity).toBe('error');
  expect(c.action).toContain('fresh copy');
});

/**
 * The one state verifier-core itself calls a pass. Its schema result never
 * reaches `verified`, so this whole case is invisible to anything reading the
 * log alone — and it only shows up here because the credential was really
 * validated against the Open Badges schema bundled with the library.
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
  // Said without assuming the reader knows what a signature is for: the
  // word comes with what it does.
  expect(c.headline).toContain("can't tell if this is genuine");
  expect(c.detail).toContain('digital signature');
  expect(c.detail).toContain('the part that proves it came from them');
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

test('the issuer row speaks the earner\'s language, and lends no name without the seal', async ({ page }) => {
  const issuerRow = () =>
    page.evaluate(() =>
      [...document.getElementById('vc')!.shadowRoot!.querySelectorAll('.check')]
        .map((r) => r.textContent!.replace(/\s+/g, ' ').trim())
        .find((t) => t.startsWith('Issuer')) ?? '',
    );

  await pick(page, 'Changed');
  const changed = await issuerRow();
  expect(changed).toContain("can't confirm — the digital signature doesn't match");
  expect(changed).not.toContain('Springfield College');
  expect(changed).not.toContain('Registry');

  await pick(page, 'Verified');
  expect(await issuerRow()).toContain('Springfield College — a known issuer');
  // The registry's own name is still there for developers, in the library's words.
  await page.locator('#vc').getByRole('button', { name: 'Developer view', exact: true }).click();
  const dev = await page.evaluate(
    () => document.getElementById('vc')!.shadowRoot!.querySelector('.dev')!.textContent!,
  );
  expect(dev).toContain('Issuer found in registry: Local Dev Registry');
});

/**
 * The situations verifier-core has named by type since its main of 7 October
 * 2026 (d217b04): each runs the real library over a real fixture, signed in
 * scripts/make-fixtures.js.
 */
test('a credential not valid yet is a warning that says when it will be', async ({ page }) => {
  const c = await pick(page, 'Not yet valid');
  expect(c.severity).toBe('warning');
  expect(c.headline).toContain('Not valid until 1 January 2099');
  // Its test credential has no way to be deactivated, so that half isn't said.
  expect(c.detail).toBe("It hasn't been tampered with.");
  expect(c.action).toBe('Check it again on or after that date.');
});

test('a suspended credential is an error of its own, and may be temporary', async ({ page }) => {
  const c = await pick(page, 'Suspended');
  expect(c.severity).toBe('error');
  expect(c.headline).toContain('The issuer has put this copy on hold');
  expect(c.detail).toContain('may be temporary');
  expect(await detailRows(page)).toContainEqual(expect.stringContaining('put on hold by the issuer'));
});

test("a seal made with someone else's key is not called tampering", async ({ page }) => {
  const c = await pick(page, 'Not their seal');
  expect(c.severity).toBe('error');
  expect(c.headline).toContain("We couldn't confirm who signed this");
  expect(`${c.headline} ${c.detail}`).not.toMatch(/tamper/i);
  expect(c.action).toBe('Ask the issuer for an official copy.');
  expect(await detailRows(page)).toContainEqual(expect.stringContaining("the digital signature can't be tied to them"));
});

/**
 * A list signed by someone other than the issuer, and clear. Read like the
 * issuer's own by default (Nate Otto, 22 October 2026: DCC's own status
 * service signs every list with its own key), so it reads Verified; the
 * mismatch is the library's warning, in the Developer view. Not a demo button
 * any more, since it would look exactly like "Not withdrawn".
 */
test("a withdrawal list the issuer didn't sign is read like theirs, and flagged for developers", async ({ page }) => {
  await settle(page, async () => {
    await page.evaluate(async () => {
      const el = document.getElementById('vc') as HTMLElement & { credential?: unknown; registries?: unknown };
      const credential = await (await fetch('./fixtures/list-not-issuers.json')).json();
      el.registries = [
        { name: 'Local Dev Registry', type: 'dcc-legacy', url: new URL('./fixtures/registry.json', location.href).href },
      ];
      el.credential = credential;
    });
  });
  const c = await card(page);
  expect(c.severity).toBe('success');
  expect(c.headline).toContain('Verified');
  expect(c.detail).toContain("the issuer hasn't deactivated it");
  expect(await detailRows(page)).toContainEqual(expect.stringContaining('not deactivated or on hold'));

  await viewButton(page, 'Developer view').click();
  const text = await page.evaluate(
    () => document.getElementById('vc')!.shadowRoot!.querySelector('.dev')!.textContent!.replace(/\s+/g, ' '),
  );
  expect(text).toContain('Failed: list-issuer');
  expect(text).toContain('STATUS_LIST_ISSUER_MISMATCH');
});

test('an unrecognised issuer is never called fake', async ({ page }) => {
  const c = await pick(page, 'Issuer unknown');
  expect(c.severity).not.toBe('error');
  expect(c.headline).toContain('Genuine');
  // Neither "fake" nor "doesn't mean it's fake", which leans positive.
  expect(c.detail).not.toMatch(/fake/i);
  expect(c.detail).toContain('which is common');
});

test('an unreachable registry reads differently from an unlisted issuer', async ({ page }) => {
  const offline = await pick(page, 'Registry offline');
  const unknown = await pick(page, 'Issuer unknown');

  // Both come back from the library as the same plain failure. If these ever
  // read alike, the distinction has been lost somewhere.
  expect(offline.headline).not.toBe(unknown.headline);
  expect(offline.severity).toBe('unchecked');
  // In the earner's terms, not the registry's name — that's in the developer view.
  expect(offline.detail).toContain("our list of known issuers didn't load");
  expect(offline.detail).not.toContain('Local Dev Registry');
  expect(offline.action).not.toBe('');
});

/**
 * On a phone the Details rows stack and long values wrap. When the words were
 * still right-aligned there, the mark beside a value stayed at the row's left
 * edge once its text wrapped, a column away from the words it belongs to.
 */
const rowLayout = (page: Page) =>
  page.evaluate(() =>
    [...document.getElementById('vc')!.shadowRoot!.querySelectorAll('.check')].map((row) => {
      const mark = row.querySelector('.mark')!.getBoundingClientRect();
      // The words alone, one rectangle per line, without the hidden label
      const range = document.createRange();
      range.selectNodeContents(row.querySelector('.mark + span')!.lastChild!);
      const lines = [...range.getClientRects()];
      const first = lines[0]!;
      return {
        label: row.querySelector('.k')!.textContent,
        lines: lines.length,
        sameLine: Math.abs(mark.top + mark.height / 2 - (first.top + first.height / 2)) < 6,
        gap: first.left - mark.right,
      };
    }),
  );

for (const situation of ['Registry offline', 'Not their seal']) {
  test(`each Details mark stays beside its text when the text wraps (${situation})`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await pick(page, situation);
    const rows = await rowLayout(page);
    // At this width a row wraps, so this is about wrapped text
    expect(rows.some((r) => r.lines > 1), 'no row wrapped').toBe(true);
    for (const r of rows) {
      expect(r.sameLine, `${r.label}: the mark is on a line of its own`).toBe(true);
      expect(r.gap, `${r.label}: gap between the mark and its text`).toBeGreaterThanOrEqual(0);
      expect(r.gap, `${r.label}: gap between the mark and its text`).toBeLessThan(10);
    }
  });
}

/**
 * The mark is a bullet: it stays on its value's first line, and every line of
 * the value starts just after it. As an inline box in the text, it was left
 * alone on a line above a word too long to fit beside it, such as an issuer's
 * did:key, and a wrapped value's next line started back under it.
 */
for (const [width, rows] of [
  [360, 'stacked'],
  [1024, 'side by side'],
] as const) {
  test(`an issuer's did:key starts beside its mark and stays inside the card (${rows})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await pick(page, 'Issuer unknown');
    const layout = await page.evaluate(() => {
      const root = document.getElementById('vc')!.shadowRoot!;
      // An issuer with no name is shown by its identifier, which no demo
      // credential has; the Issuer row is given one to lay out.
      const row = [...root.querySelectorAll('.check')].find((r) => r.querySelector('.k')!.textContent === 'Issuer')!;
      const text = row.querySelector('.mark + span')!.lastChild!;
      text.textContent = 'did:key:z6MknNQD1WHLGGraFi6zcbGevuAgkVfdyCdtZnQTGWVVvR5Q — not on our list of known issuers';
      const card = root.querySelector('.card')!;
      const mark = row.querySelector('.mark')!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(text);
      const rects = [...range.getClientRects()];
      const first = rects[0]!;
      return {
        wrapped: rects.some((r) => r.top > first.bottom - 2),
        stacked: mark.top >= row.querySelector('.k')!.getBoundingClientRect().bottom - 1,
        fits: card.scrollWidth <= card.clientWidth,
        sameLine: Math.abs(mark.top + mark.height / 2 - (first.top + first.height / 2)) < 6,
        gap: first.left - mark.right,
        squashed: Math.abs(mark.width - mark.height) > 0.5,
      };
    });
    expect(layout.stacked, 'not the layout this case is for').toBe(rows === 'stacked');
    expect(layout.wrapped, 'the identifier did not wrap').toBe(true);
    expect(layout.fits, 'the identifier runs off the card').toBe(true);
    expect(layout.sameLine, 'the mark is on a line of its own').toBe(true);
    expect(layout.gap, 'gap between the mark and the identifier').toBeGreaterThanOrEqual(0);
    expect(layout.gap, 'gap between the mark and the identifier').toBeLessThan(10);
    // Beside words that fill the line, a flex item may shrink; the mark must not
    expect(layout.squashed, 'the mark is squashed out of round').toBe(false);
  });
}

// Side by side at 480px: the element is about 440px wide (the demo page pads
// it), over the 380px stacking width, yet the Issuer value still wraps.
for (const [width, rows, dir] of [
  [360, 'stacked', 'ltr'],
  [360, 'stacked', 'rtl'],
  [480, 'side by side', 'ltr'],
] as const) {
  test(`a wrapped value's lines all start where its first line does, just after the mark (${rows}, ${dir})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((d) => document.documentElement.setAttribute('dir', d), dir);
    await pick(page, 'Issuer unknown');
    const found = await page.evaluate(
      (rtl) =>
        [...document.getElementById('vc')!.shadowRoot!.querySelectorAll('.check')].map((row) => {
          const label = row.querySelector('.k')!.getBoundingClientRect();
          const mark = row.querySelector('.mark')!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(row.querySelector('.mark + span')!.lastChild!);
          // Where each line starts: its left edge, or its right in a right-to-left
          // page. A line can come back as several rectangles, one per run of
          // text in one direction, so they are grouped by line first.
          const lines: { top: number; start: number }[] = [];
          for (const r of [...range.getClientRects()].sort((a, b) => a.top - b.top)) {
            const start = rtl ? r.right : r.left;
            const line = lines.find((l) => Math.abs(l.top - r.top) < 2);
            if (!line) lines.push({ top: r.top, start });
            else line.start = rtl ? Math.max(line.start, start) : Math.min(line.start, start);
          }
          const starts = lines.map((l) => l.start);
          return {
            label: row.querySelector('.k')!.textContent,
            stacked: mark.top >= label.bottom - 1,
            squashed: Math.abs(mark.width - mark.height) > 0.5,
            gap: rtl ? mark.left - starts[0]! : starts[0]! - mark.right,
            starts,
          };
        }),
      dir === 'rtl',
    );
    expect(found.find((r) => r.label === 'Issuer')!.starts.length, 'the Issuer value did not wrap').toBeGreaterThan(1);
    for (const r of found) {
      expect(r.stacked, `${r.label}: not the layout this case is for`).toBe(rows === 'stacked');
      expect(r.squashed, `${r.label}: the mark is squashed out of round`).toBe(false);
      expect(r.gap, `${r.label}: gap between the mark and its first line`).toBeGreaterThanOrEqual(0);
      expect(r.gap, `${r.label}: gap between the mark and its first line`).toBeLessThan(10);
      for (const start of r.starts.slice(1)) {
        expect(Math.abs(start - r.starts[0]!), `${r.label}: a wrapped line starts elsewhere`).toBeLessThanOrEqual(1);
      }
    }
  });
}

/**
 * Where each value starts, against its label and its row. In a narrow card
 * (380px or less) each row stacks, label over value; a wide card keeps them
 * side by side.
 */
const valueEdges = (page: Page) =>
  page.evaluate(() =>
    [...document.getElementById('vc')!.shadowRoot!.querySelectorAll('.check')].map((row) => {
      const label = row.querySelector('.k')!.getBoundingClientRect();
      const mark = row.querySelector('.mark')!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(row.querySelector('.mark + span')!.lastChild!);
      const rects = [...range.getClientRects()];
      const wrapped = rects.some((r) => r.top > rects[0]!.bottom - 2);
      // The value's far edge: its text, while it is one line; once it wraps,
      // its lines start after the mark and end raggedly, so the words' box,
      // which then reaches across to the row's end
      const box = row.querySelector('.mark + span')!.getBoundingClientRect();
      const far = wrapped
        ? { left: box.left, right: box.right }
        : { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) };
      const rowBox = row.getBoundingClientRect();
      return {
        label: row.querySelector('.k')!.textContent,
        below: mark.top >= label.bottom - 1,
        fromLabelLeft: Math.abs(mark.left - label.left),
        fromLabelRight: Math.abs(mark.right - label.right),
        fromRowRight: Math.abs(rowBox.right - far.right),
        fromRowLeft: Math.abs(rowBox.left - far.left),
      };
    }),
  );

test('stacked in a right-to-left page, each value starts under its label, at the right', async ({ page }) => {
  // The alignment is start and end, not left and right, so it follows the
  // page's direction. So is the gap after the mark, so the mark starts
  // exactly under its label, as it does left to right.
  await page.setViewportSize({ width: 360, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
  await pick(page, 'Verified');
  for (const r of await valueEdges(page)) {
    expect(r.below, `${r.label}: the value is not under its label`).toBe(true);
    expect(r.fromLabelRight, `${r.label}: the value does not start under its label`).toBeLessThan(1);
  }
});

for (const situation of ['Verified', 'Registry offline']) {
  test(`stacked on a phone, each value starts under its label (${situation})`, async ({ page }) => {
    // Right-aligned under a label at the left, a short value sat at the far
    // edge of the card and a long one wrapped ragged, away from its label
    await page.setViewportSize({ width: 360, height: 900 });
    await pick(page, situation);
    for (const r of await valueEdges(page)) {
      expect(r.below, `${r.label}: the value is not under its label`).toBe(true);
      expect(r.fromLabelLeft, `${r.label}: the value does not start under its label`).toBeLessThan(1);
    }
  });

  test(`side by side in a wide card, each value keeps to the right (${situation})`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await pick(page, situation);
    for (const r of await valueEdges(page)) {
      expect(r.below, `${r.label}: the value went under its label`).toBe(false);
      expect(r.fromRowRight, `${r.label}: the value does not end at the right`).toBeLessThan(1);
    }
  });
}

test("a host page that centres its text doesn't move the rows", async ({ page }) => {
  // text-align is inherited into the card; centred, a stacked label sat in
  // the middle of the row while its value started at the edge
  await page.setViewportSize({ width: 360, height: 900 });
  await page.evaluate(() => (document.getElementById('vc')!.style.textAlign = 'center'));
  await pick(page, 'Verified');
  const rows = await page.evaluate(() =>
    [...document.getElementById('vc')!.shadowRoot!.querySelectorAll('.check')].map((row) => {
      // The label's words, not its box, which spans the row however its
      // words are aligned
      const range = document.createRange();
      range.selectNodeContents(row.querySelector('.k')!);
      return {
        label: row.querySelector('.k')!.textContent,
        fromLabelText: Math.abs(row.querySelector('.mark')!.getBoundingClientRect().left - range.getBoundingClientRect().left),
      };
    }),
  );
  for (const r of rows) expect(r.fromLabelText, `${r.label}: the value does not start under its label`).toBeLessThan(1);
});

test('side by side in a right-to-left page, each value keeps to the left', async ({ page }) => {
  // The row's end, mirrored: the value is placed by start and end, not by
  // left and right
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
  await pick(page, 'Registry offline');
  for (const r of await valueEdges(page)) {
    expect(r.below, `${r.label}: the value went under its label`).toBe(false);
    expect(r.fromRowLeft, `${r.label}: the value does not end at the left`).toBeLessThan(1);
  }
});

for (const width of [1024, 480]) {
  test(`words that cannot break never push the mark over the label (${width}px)`, async ({ page }) => {
    // A host page that sets white-space: nowrap, which the card inherits,
    // stands in for any words that cannot break, as in a browser without
    // overflow-wrap: anywhere. They may run past the row's end, as before
    // this layout; they must not run back over the label (or, further, off
    // the card's start).
    await page.setViewportSize({ width, height: 900 });
    await pick(page, 'Issuer unknown');
    const layout = await page.evaluate(() => {
      const host = document.getElementById('vc')!;
      host.style.whiteSpace = 'nowrap';
      const root = host.shadowRoot!;
      const row = [...root.querySelectorAll('.check')].find((r) => r.querySelector('.k')!.textContent === 'Issuer')!;
      row.querySelector('.mark + span')!.lastChild!.textContent =
        'did:key:z6MknNQD1WHLGGraFi6zcbGevuAgkVfdyCdtZnQTGWVVvR5Q — not on our list of known issuers';
      const label = row.querySelector('.k')!.getBoundingClientRect();
      const mark = row.querySelector('.mark')!.getBoundingClientRect();
      return { overLabel: mark.left < label.right };
    });
    expect(layout.overLabel, 'the mark is over the label').toBe(false);
  });
}

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
  expect(c.live).toContain('deactivated');
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
  expect(rows.join(' ')).toContain('Status');
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
    expect(shown.text).toContain('Credential Revoked');
    expect(shown.text).toMatch(/The status list \S+ marks the credential revoked \(index 42\)\./);
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
    expect((await detailRows(page)).join(' ')).toContain('deactivated by the issuer');
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
    expect(c.headline).toContain("couldn't check this right now");
    expect(c.detail).toBe("Something went wrong while we were checking, so we can't tell you yet whether it's valid.");
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
    // sitting under a verdict that no longer describes them. Counted as the
    // check starts: with nothing to fetch, it can now finish within a tick.
    const during = await page.evaluate(async () => {
      const el = document.getElementById('vc') as HTMLElement & { registries?: unknown };
      const started = new Promise<number>((resolve) =>
        el.addEventListener(
          'verification-started',
          () => resolve(el.shadowRoot!.querySelectorAll('.check, .dev-check').length),
          { once: true },
        ),
      );
      el.registries = [];
      return started;
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

  test('each detail row is read out as its label, its status word and its value, without the mark', async ({ page }) => {
    // The mark is laid out beside the words, not among them; how it is laid
    // out must not run the words together or have the mark read out.
    for (const situation of ['Issuer unknown', 'Not their seal']) {
      await pick(page, situation);
      const rows = page.locator('#vc .check');
      for (let i = 0; i < (await rows.count()); i++) {
        const row = rows.nth(i);
        const snapshot = (await row.ariaSnapshot()).replace(/^- text: /, '');
        const spoken = snapshot.startsWith('"') ? (JSON.parse(snapshot) as string) : snapshot;
        const label = await row.locator('.k').textContent();
        const words = (await row.locator('.mark + span').textContent())!.replace(/\s+/g, ' ').trim();
        expect(words, `${situation}, ${label}: no status word`).toMatch(/^[A-Z][^:]*: \S/);
        expect(spoken, `${situation}, ${label}`).toBe(`${label} ${words}`);
        await expect(row.locator('.mark')).toHaveAttribute('aria-hidden', 'true');
      }
    }
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
    expect(after.text).toContain('deactivated');
  });
});

/**
 * A did:web issuer publishes its signing key in a did.json on its own website.
 * When that won't load, verifier-core reports DID_WEB_UNRESOLVED, which reads
 * "couldn't reach" (verifier-core#65, fixed in 2.0.0-beta.1; until then it
 * called the signature invalid, and verify.ts carried a stopgap). The credential is vc-test-fixtures' badDidWeb.json (see
 * test/did-web-outages.test.ts). Its issuer's did.json is answered here, so
 * nothing reaches the real site. Against a published copy, this exercises
 * the built-in fetcher that builds use.
 */
test.describe("an issuer's website that won't serve its key", () => {
  const UNREACHABLE: unknown = JSON.parse(
    readFileSync(new URL('../fixtures/did-web-unreachable.json', import.meta.url), 'utf8'),
  );
  const DID_JSON = 'https://digitalcredentials.github.io/dcc-did-web-bad/did.json';

  const cases: [string, Parameters<Page['route']>[1]][] = [
    ['answers 404', (route) => route.fulfill({ status: 404, body: 'Not Found', headers: { 'access-control-allow-origin': '*' } })],
    ["doesn't answer", (route) => route.abort('connectionrefused')],
  ];
  for (const [name, answer] of cases) {
    test(`reads as unreachable, not tampered, when it ${name}`, async ({ page }) => {
      await page.route(DID_JSON, answer);
      await settle(page, async () => {
        await page.evaluate((credential) => {
          (document.getElementById('vc') as HTMLElement & { credential?: unknown }).credential = credential;
        }, UNREACHABLE);
      });
      const c = await card(page);
      expect(c.severity).toBe('unchecked');
      expect(c.headline).toContain("We couldn't check this right now");
      expect(c.detail).toContain("We couldn't reach the issuer's website");
    });
  }
});

/**
 * A wallet meets every withdrawal list on another site, and GitHub Pages
 * refuses the CORS preflight that a fetch with custom headers triggers. These
 * credentials come from pages-like-server.js on 127.0.0.1:5182 and name its
 * own list, so the card on localhost:5180 has to read that list across sites.
 * Local runs only: against a published copy, playwright.config.ts starts no
 * local servers, so there is no second site to fetch from.
 */
test.describe('a withdrawal list on another site', () => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, 'needs the local second site');

  const OTHER_SITE = 'http://127.0.0.1:5182';

  // No routes here: any active Playwright route stops Chromium refusing
  // preflighted requests across sites (checked 1 October 2026), which would
  // hide exactly the failure these tests exist to catch. So support.ts's
  // refusal of purl goes; its watch, which only listens, stays.
  test.beforeEach(async ({ page }) => {
    await page.unroute('https://purl.imsglobal.org/**');
  });

  /** Gives the card a credential from the other site; returns the library's seal and status checks. */
  const fromOtherSite = async (page: Page, file: string) => {
    let found = { seal: '', status: '' };
    await settle(page, async () => {
      found = await page.evaluate(async ({ url, ids }) => {
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
                id?: string;
                outcome: { status: string; problems?: { type?: string }[] };
              }[];
              // The problem's type too: "failure" alone is also what an
              // unreachable list gives.
              const of = (id: string) => {
                const o = results.find((r) => r.id === id)?.outcome;
                return o ? [o.status, o.problems?.[0]?.type].filter(Boolean).join(': ') : 'absent';
              };
              resolve({ seal: of(ids.seal), status: of(ids.status) });
            },
            { once: true },
          );
        });
        const credential = await (await fetch(url)).json();
        // Both in one go: set apart, the registries alone would re-check the
        // demo's own credential first.
        el.registries = [
          { name: 'Local Dev Registry', type: 'dcc-legacy', url: new URL('./fixtures/registry.json', location.href).href },
        ];
        el.credential = credential;
        return done;
      }, { url: `${OTHER_SITE}/${file}.json`, ids: { seal: CHECK.signature, status: CHECK.status } });
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
    expect(status).toBe(`failure: ${PROBLEM.revoked}`);
    expect(c.severity).toBe('error');
    expect(c.action).toContain('current copy');
  });

  test('a credential not withdrawn on another site is checked and clear', async ({ page }) => {
    const { seal, status, card: c } = await fromOtherSite(page, 'not-withdrawn');
    expect(seal).toBe('success');
    expect(status).toBe('success');
    expect(c.severity).toBe('success');
  });
});

test.describe('when the host could not get its list of registries', () => {
  /** Everything in the card as the earner reads it, minus when it was checked. */
  const wholeCard = (page: Page) =>
    page.evaluate(() =>
      (document.getElementById('vc')!.shadowRoot!.querySelector('.card') as HTMLElement).innerText
        .replace(/Checked .*$/m, '')
        .trim(),
    );

  /** Sets registriesUnavailable, waits for the check it starts, and lists the registry requests it made. */
  const setUnavailable = async (page: Page, value: boolean) => {
    const lookups: string[] = [];
    const listen = (r: { url(): string }) => {
      if (/\/fixtures\/(registry|nope)\.json/.test(r.url())) lookups.push(r.url());
    };
    page.on('request', listen);
    await settle(page, async () => {
      await page.evaluate((v) => {
        (document.getElementById('vc') as HTMLElement & { registriesUnavailable: boolean }).registriesUnavailable = v;
      }, value);
    });
    page.off('request', listen);
    return lookups;
  };

  test("says our list didn't load, and looks nothing up", async ({ page }) => {
    await pick(page, 'Verified');
    const lookups = await setUnavailable(page, true);
    expect(lookups, 'looked the issuer up anyway').toEqual([]);
    const c = await card(page);
    expect(c.severity).toBe('unchecked');
    expect(c.headline).toContain("We couldn't confirm who issued this");
    expect(c.detail).toContain("our list of known issuers didn't load,");
    expect(await wholeCard(page)).toContain("we couldn't load our list of known issuers");
  });

  test('reads exactly like a registry that did not answer', async ({ page }) => {
    // The same credential both ways, so any difference is the wording's.
    await pick(page, 'Registry offline');
    const offline = { card: await card(page), whole: await wholeCard(page) };
    await pick(page, 'Verified');
    await setUnavailable(page, true);
    expect({ card: await card(page), whole: await wholeCard(page) }).toEqual(offline);
  });

  test("the developer view shows the library's own account: the lookup never ran", async ({ page }) => {
    await pick(page, 'Verified');
    await setUnavailable(page, true);
    await page.locator('#vc').getByRole('button', { name: 'Developer view', exact: true }).click();
    expect(await wholeCard(page)).toContain('No registries configured in verification context.');
  });

  test('clearing it checks against the registries again', async ({ page }) => {
    await pick(page, 'Verified');
    await setUnavailable(page, true);
    const lookups = await setUnavailable(page, false);
    expect(lookups.length, 'did not look the issuer up again').toBeGreaterThan(0);
    expect((await card(page)).severity).toBe('success');
  });
});
