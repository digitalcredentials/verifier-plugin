/**
 * A second site for the browser tests, answering the way GitHub Pages does:
 * a plain GET gets the file and `access-control-allow-origin: *`, and a CORS
 * preflight (OPTIONS) gets a 405 with no CORS headers. Checked against
 * digitalcredentials.github.io on 1 October 2026.
 *
 * It serves a set of test credentials signed fresh at startup, whose
 * withdrawal list is this server's own status-list.json. It is on 127.0.0.1,
 * which browsers treat as a different site from the demo page on localhost,
 * so a card checking one of these has to fetch the list across sites: what a
 * wallet does with every credential.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 5182;
const ORIGIN = `http://${HOST}:${PORT}`;

/**
 * Ctrl-C or a SIGTERM during the signing below would otherwise end the process
 * on the spot, skipping the `finally` that deletes the folder. Handled, a
 * signal sent to this process alone waits for the synchronous signing and
 * clean-up, then exits. One sent to the whole process group, as Ctrl-C and
 * Playwright's shutdown both are, also stops the signing script, so the
 * server exits with that script's error instead; the clean-up still runs. A
 * SIGKILL can't be handled, which is why playwright.config.ts stops this
 * server with a SIGTERM: Playwright's default is a SIGKILL, and Ctrl-C on
 * `npx playwright test` reaches this server only through Playwright, since it
 * runs in its own process group. (A second Ctrl-C still makes Playwright
 * SIGKILL it; mid-signing, that window is about a third of a second.) Checked
 * by hand on 2 October 2026, through Playwright as well as directly.
 */
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => process.exit(code));
}

/**
 * Every file, signed and read into memory before the server answers anything,
 * so Playwright's readiness poll can't find it half-written, and nothing is
 * left on disk afterwards.
 */
const files = (() => {
  const out = mkdtempSync(join(tmpdir(), 'pages-like-'));
  try {
    // The credentials name this server's copy of the Open Badges schema, so
    // the tests using them need no request interception. They can't use any:
    // once a Playwright route is active, Chromium stops refusing preflighted
    // requests across sites (checked 1 October 2026), so a route here would
    // hide exactly the failure these tests exist to catch.
    copyFileSync(
      fileURLToPath(new URL('./fixtures/ob_v3p0_achievementcredential_schema.json', import.meta.url)),
      join(out, 'schema.json'),
    );
    execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/make-fixtures.js', import.meta.url))], {
      env: {
        ...process.env,
        FIXTURES_OUT: out,
        FIXTURES_STATUS_LIST_URL: `${ORIGIN}/status-list.json`,
        FIXTURES_SCHEMA_URL: `${ORIGIN}/schema.json`,
      },
      // Quiet unless it fails: Playwright shows only that the server never came up.
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    return new Map(readdirSync(out).map((name) => [`/${name}`, readFileSync(join(out, name))]));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
})();

createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const body = files.get(new URL(req.url ?? '/', ORIGIN).pathname);
  if (!body) {
    res.writeHead(404, { 'access-control-allow-origin': '*' }).end();
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
})
  // One line, not a stack trace, when something else already has the port.
  .on('error', (error) => {
    console.error(error.message);
    process.exit(1);
  })
  .listen(PORT, HOST);
