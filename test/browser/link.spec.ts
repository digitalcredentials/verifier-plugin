import { test, expect, type Page } from '@playwright/test';
import { card, preparePages } from './support.js';

/**
 * The demo page opened from a link to a credential: `?vc=<address>`, or
 * VerifierPlus's `#verify?vc=<address>`.
 *
 * The page checks a linked credential against DCC's known-registries list.
 * The tests serve that list themselves, naming only the test registry, so a
 * test credential reads as from a known issuer and no real registry is asked.
 * Anything shared from another site is served from ELSEWHERE, by a route.
 */

const KNOWN_REGISTRIES = 'https://digitalcredentials.github.io/dcc-known-registries/known-did-registries.json';
const ELSEWHERE = 'https://credentials.example';
const CORS = { 'access-control-allow-origin': '*' };

preparePages();

/** The page's own address, ending in `/`: the test credentials and registry are under it. */
let base: string;

test.beforeEach(async ({ page, baseURL }) => {
  base = baseURL!.endsWith('/') ? baseURL! : `${baseURL}/`;
  await page.route(KNOWN_REGISTRIES, (route) =>
    route.fulfill({
      json: [{ name: 'Local Dev Registry', type: 'dcc-legacy', url: `${base}fixtures/registry.json` }],
      headers: CORS,
    }),
  );
});

/** Opens a link and waits until it has either been checked or turned down. */
const open = async (page: Page, path: string) => {
  await page.goto(path);
  await page.waitForFunction(
    () => (window.__done ?? 0) > 0 || !!document.getElementById('problem')?.textContent,
    null,
    { timeout: 30_000 },
  );
};

const problem = (page: Page) => page.locator('#problem').innerText();

/** The test credential from a known issuer, as the page's own server has it. */
const verified = async (page: Page) =>
  (await (await page.request.get(`${base}fixtures/verified.json`)).json()) as Record<string, unknown>;

/** Serves `body` at ELSEWHERE, and lists every address asked for there. */
const shareElsewhere = async (page: Page, body: unknown) => {
  const asked: string[] = [];
  await page.route(`${ELSEWHERE}/**`, (route) => {
    asked.push(route.request().url());
    return route.fulfill({ json: body, headers: CORS });
  });
  return asked;
};

test('a link to a credential checks it against the known registries, with no situations to pick', async ({ page }) => {
  const lists: string[] = [];
  page.on('request', (r) => {
    if (r.url() === KNOWN_REGISTRIES) lists.push(r.url());
  });
  await open(page, `./?vc=${base}fixtures/verified.json`);
  // Known only through the served list: the card's own default registry
  // doesn't list the test issuer.
  const c = await card(page);
  expect(c.severity).toBe('success');
  expect(c.headline).toContain('Verified');
  expect(lists).toHaveLength(1);
  await expect(page.getByRole('group', { name: 'Situation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Verified', exact: true })).toHaveCount(0);
  expect(await problem(page)).toBe('');
});

test("the link can be VerifierPlus's, and its address encoded or not", async ({ page }) => {
  const address = `${base}fixtures/verified.json`;
  for (const path of [
    `./#verify?vc=${address}`,
    `./?vc=${encodeURIComponent(address)}`,
    `./#verify?vc=${encodeURIComponent(address)}`,
    // A `#verify?` without a vc= of its own doesn't hide the query's.
    `./?vc=${address}#verify?lang=en`,
  ]) {
    await open(page, path);
    // Link mode, not the situations: their first one is a success too.
    await expect(page.getByRole('group', { name: 'Situation' }), path).toHaveCount(0);
    expect((await card(page)).severity, path).toBe('success');
  }
});

test('everything after vc= is the address, & and + included, as the wallet writes it', async ({ page }) => {
  const asked = await shareElsewhere(page, await verified(page));
  const address = `${ELSEWHERE}/shared?id=a+b&v=2`;
  await open(page, `./#verify?vc=${address}`);
  expect(asked).toEqual([address]);
  expect((await card(page)).severity).toBe('success');
});

test('a credential shared from the wallet, in its envelope, is taken out of it', async ({ page }) => {
  const vc = await verified(page);

  await shareElsewhere(page, { type: ['VerifiablePresentation'], verifiableCredential: [vc] });
  await open(page, `./?vc=${ELSEWHERE}/one`);
  expect((await card(page)).severity).toBe('success');
  await expect(page.locator('#note')).toHaveText('');

  // A presentation may hold one credential as itself, not in a list.
  await page.unroute(`${ELSEWHERE}/**`);
  await shareElsewhere(page, { type: ['VerifiablePresentation'], verifiableCredential: vc });
  await open(page, `./?vc=${ELSEWHERE}/single`);
  expect((await card(page)).severity).toBe('success');

  await page.unroute(`${ELSEWHERE}/**`);
  await shareElsewhere(page, { type: ['VerifiablePresentation'], verifiableCredential: [vc, vc] });
  await open(page, `./?vc=${ELSEWHERE}/two`);
  expect((await card(page)).severity).toBe('success');
  await expect(page.locator('#note')).toHaveText('This link holds 2 credentials. This is the first.');
});

test("a link that can't be fetched says so, and shows no card", async ({ page }) => {
  // A site that answers but won't be read from another one can't be tested
  // here: while a route is active, Chromium doesn't hold a routed answer to
  // that rule. The browser reports it exactly as it reports `down`, though —
  // the same error, which is why the message names both.
  const cases: [string, Parameters<Page['route']>[1], string][] = [
    ['down', (route) => route.abort('connectionrefused'), "didn't answer, or doesn't let other websites read it."],
    ['missing', (route) => route.fulfill({ status: 404, body: 'Not Found', headers: CORS }), 'answered with an error (404).'],
  ];
  for (const [name, answer, reason] of cases) {
    await page.unroute(`${ELSEWHERE}/**`);
    await page.route(`${ELSEWHERE}/**`, answer);
    await open(page, `./?vc=${ELSEWHERE}/${name}.json`);
    const said = await problem(page);
    expect(said, name).toContain("We couldn't fetch that credential");
    expect(said, name).toContain(`${ELSEWHERE}/${name}.json ${reason}`);
    await expect(page.locator('#vc'), name).toBeHidden();
    expect(await page.evaluate(() => window.__done), name).toBe(0);
  }
});

test("a credential that can't be fetched is said so without waiting on the registry list", async ({ page }) => {
  // The list never answers; the page's own time limit is 10s, open()'s 30s.
  await page.unroute(KNOWN_REGISTRIES);
  await page.route(KNOWN_REGISTRIES, () => {});
  await page.route(`${ELSEWHERE}/**`, (route) => route.fulfill({ status: 404, headers: CORS }));
  const started = Date.now();
  await open(page, `./?vc=${ELSEWHERE}/missing.json`);
  expect(await problem(page)).toContain("We couldn't fetch that credential");
  expect(Date.now() - started).toBeLessThan(8_000);
});

test("a link to something that isn't a credential says so", async ({ page }) => {
  const cases: [string, Parameters<Page['route']>[1]][] = [
    ['page', (route) => route.fulfill({ body: '<!doctype html><title>Hi</title>', contentType: 'text/html', headers: CORS })],
    ['list', (route) => route.fulfill({ json: [1, 2], headers: CORS })],
    ['object', (route) => route.fulfill({ json: { hello: 'world' }, headers: CORS })],
    ['empty-presentation', (route) => route.fulfill({ json: { type: ['VerifiablePresentation'], verifiableCredential: [] }, headers: CORS })],
  ];
  for (const [name, answer] of cases) {
    await page.unroute(`${ELSEWHERE}/**`);
    await page.route(`${ELSEWHERE}/**`, answer);
    await open(page, `./?vc=${ELSEWHERE}/${name}`);
    const said = await problem(page);
    expect(said, name).toContain("That link doesn't point to a credential");
    expect(said, name).toContain(`${ELSEWHERE}/${name} sent something that isn't a credential.`);
    await expect(page.locator('#vc'), name).toBeHidden();
  }
});

test('a link with no usable address says what it gave, as text, never as HTML', async ({ page }) => {
  const lists: string[] = [];
  page.on('request', (r) => {
    if (r.url() === KNOWN_REGISTRIES) lists.push(r.url());
  });
  await open(page, './?vc=<img src=x onerror="window.__xss=1">');
  const said = await problem(page);
  expect(said).toContain("That link doesn't say where the credential is");
  expect(said).toContain('It gives <img src=x onerror="window.__xss=1">.');
  await expect(page.locator('#problem img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();

  await open(page, './?vc=');
  expect(await problem(page)).toContain('It gives nothing.');

  await open(page, './?vc=ftp://credentials.example/x.json');
  expect(await problem(page)).toContain("That link doesn't say where the credential is");
  // Turned down before anything was fetched.
  expect(lists).toEqual([]);
});

test('a build fetches only https addresses', async ({ page }) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'the dev server also fetches http, for these tests');
  await open(page, './?vc=http://credentials.example/x.json');
  expect(await problem(page)).toContain("That link doesn't say where the credential is");
});

test("when the known-registries list doesn't load, the card says so and looks nobody up", async ({ page }) => {
  const lookups: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/fixtures/registry.json')) lookups.push(r.url());
  });
  const cases: [string, Parameters<Page['route']>[1]][] = [
    ['an error', (route) => route.fulfill({ status: 500, headers: CORS })],
    ['not a list', (route) => route.fulfill({ json: { registries: [] }, headers: CORS })],
    ['no answer', (route) => route.abort('connectionrefused')],
  ];
  for (const [name, answer] of cases) {
    await page.unroute(KNOWN_REGISTRIES);
    await page.route(KNOWN_REGISTRIES, answer);
    await open(page, `./?vc=${base}fixtures/verified.json`);
    const c = await card(page);
    expect(c.severity, name).toBe('unchecked');
    expect(c.detail, name).toContain("Our list of known issuers didn't load,");
  }
  expect(lookups).toEqual([]);
});

test("when part of the list doesn't respond, the card says so, with no try again", async ({ page }) => {
  // One registry answers without listing the issuer, one never answers: what
  // a browser meets on the real list, where several registries refuse it.
  // Here the second answers 404, since a route can't make Chromium refuse a
  // read. A refusal reaches the page as a thrown fetch, which the library
  // reports in the same shape (probed 10 October 2026), and the real list's
  // refusing registries gave that shape in the browser on 9 October.
  await page.unroute(KNOWN_REGISTRIES);
  await page.route(KNOWN_REGISTRIES, (route) =>
    route.fulfill({
      json: [
        { name: 'Answers', type: 'dcc-legacy', url: `${base}fixtures/registry-unlisted.json` },
        { name: 'Never answers', type: 'dcc-legacy', url: `${base}fixtures/nope.json` },
      ],
      headers: CORS,
    }),
  );
  await open(page, `./?vc=${base}fixtures/verified.json`);
  const c = await card(page);
  expect(c.severity).toBe('unchecked');
  expect(c.headline).toContain("We couldn't confirm who issued this");
  expect(c.detail).toBe("Some of our lists of known issuers didn't respond, so we don't know whether they're on them. That doesn't mean anything is wrong with your credential.");
  expect(c.action).toBe('');
});

test('changing the link after # opens the new one', async ({ page }) => {
  await open(page, './');
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate((address) => (location.hash = `#verify?vc=${address}`), `${base}fixtures/verified.json`),
  ]);
  await page.waitForFunction(() => (window.__done ?? 0) > 0, null, { timeout: 30_000 });
  await expect(page.getByRole('group', { name: 'Situation' })).toHaveCount(0);
  expect((await card(page)).severity).toBe('success');
});

test("a change after # that isn't a link leaves the page as it is", async ({ page }) => {
  await open(page, './');
  const reloaded = page.waitForEvent('load', { timeout: 2_000 }).then(
    () => true,
    () => false,
  );
  await page.evaluate(() => (location.hash = '#elsewhere'));
  expect(await reloaded).toBe(false);
  await expect(page.getByRole('button', { name: 'Verified', exact: true })).toHaveCount(1);
});
