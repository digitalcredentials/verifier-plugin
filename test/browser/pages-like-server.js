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
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 5182;
const ORIGIN = `http://${HOST}:${PORT}`;
// One fixed folder, rewritten at every start, so runs don't pile up copies:
// Playwright stops this server without giving it a chance to clean up.
const out = join(tmpdir(), 'verifier-plugin-pages-like');

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const name = new URL(req.url ?? '/', ORIGIN).pathname.slice(1);
  let body;
  try {
    // Flat names only: nothing outside the folder we just wrote.
    if (!/^[a-z-]+\.json$/.test(name)) throw new Error('not found');
    body = readFileSync(join(out, name));
  } catch {
    res.writeHead(404, { 'access-control-allow-origin': '*' }).end();
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

// The port first: a second copy that can't have it exits here, before it
// touches the folder the running one is serving from.
server.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);

  // The credentials name this server's copy of the Open Badges schema, so the
  // tests using them need no request interception. They can't use any: once a
  // Playwright route is active, Chromium stops refusing preflighted requests
  // across sites (checked 1 October 2026), so a route here would hide exactly
  // the failure these tests exist to catch.
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
});
