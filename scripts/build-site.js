/**
 * Builds the demo page as a published site, for GitHub Pages.
 *
 *   node scripts/build-site.js https://digitalcredentials.github.io/verifier-plugin/
 *   node scripts/build-site.js https://digitalcredentials.github.io/verifier-plugin/pr-16/
 *
 * The address matters twice. The page's own files are served from its
 * sub-folder, and the test credentials name their withdrawal list by full
 * address, so they are signed fresh for wherever this copy will live. The
 * local fixtures in dev/fixtures point at localhost and are left alone.
 *
 * Writes everything to site/, plus site/version.txt holding the commit, so a
 * workflow can tell when the published copy is the one it just built.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/build-site.js <published address, ending in />');
  process.exit(1);
}
const url = new URL(arg.endsWith('/') ? arg : `${arg}/`);

const run = (command, args, env = {}) =>
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

// The page itself, with every asset path under the sub-folder.
run('npx', ['vite', 'build', '--mode', 'site'], { SITE_BASE: url.pathname });

// The test credentials, signed for this address.
run('node', ['scripts/make-fixtures.js'], {
  FIXTURES_OUT: join(SITE, 'fixtures'),
  FIXTURES_STATUS_LIST_URL: new URL('fixtures/status-list.json', url).href,
});

const commit = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
writeFileSync(join(SITE, 'version.txt'), `${commit}\n`);

console.log(`\nbuilt for ${url.href} (commit ${commit.slice(0, 7)})`);
