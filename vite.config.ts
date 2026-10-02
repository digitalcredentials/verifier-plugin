import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Fails the library build if dist imports anything but its own files.
 *
 * verifier-core is a devDependency only because it is bundled: a host app
 * never installs it. Anything left external would resolve to whatever the host
 * has, or to nothing, and our own tests would not notice, because here it is
 * installed. The bundler lists each chunk's imports, so this reads those
 * rather than searching the output.
 *
 * It does not see a CommonJS `require()` of an external package: the bundler
 * records none (checked 2 October 2026). There are no externals at all today,
 * and adding one for verifier-core brings back the ESM imports this does see.
 */
const selfContained = (): Plugin => ({
  name: 'self-contained',
  apply: 'build',
  generateBundle(_, bundle) {
    const outside = Object.values(bundle).flatMap((file) =>
      file.type === 'chunk'
        ? [...file.imports, ...file.dynamicImports].filter((id) => !(id in bundle)).map((id) => `${file.fileName} → ${id}`)
        : [],
    );
    if (outside.length) this.error(`dist must not import anything outside itself:\n  ${outside.join('\n  ')}`);
  },
});

/** The folder of the nearest package.json with a name, at or above `dir`. */
const packageRoot = (dir: string): string | undefined => {
  for (let at = dir; ; at = dirname(at)) {
    try {
      if ((JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')) as { name?: string }).name) return at;
    } catch {
      // No package.json here, or one without a name (a nested `dist/` marker).
    }
    if (dirname(at) === at) return undefined;
  }
};

/** What package.json says about the licence, in any of the shapes it has had. */
const declaredLicence = (pkg: { license?: unknown; licenses?: unknown }): string => {
  const one = (l: unknown) => (typeof l === 'string' ? l : ((l as { type?: string } | null)?.type ?? '?'));
  if (pkg.license !== undefined) return one(pkg.license);
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(one).join(' OR ');
  return 'nothing';
};

/**
 * Ships the licence of every package with code in dist, as
 * dist/THIRD_PARTY_LICENSES.txt.
 *
 * Bundled, their code reaches a host inside our files rather than as installed
 * packages with their own LICENSE files, and most keep their licence only in
 * that file, not in a comment the bundler could carry along.
 */
const thirdPartyLicenses = (): Plugin => ({
  name: 'third-party-licenses',
  apply: 'build',
  generateBundle(_, bundle) {
    const own = resolve(import.meta.dirname);
    // Modules with code that made it into the output, not everything the
    // bundler looked at: tree-shaking can leave a package out entirely.
    const ids = Object.values(bundle).flatMap((file) =>
      file.type === 'chunk' ? Object.entries(file.modules).filter(([, m]) => m.renderedLength > 0).map(([id]) => id) : [],
    );
    const packages = new Map<string, string>();
    for (const id of ids) {
      if (id.startsWith('\0')) continue;
      const root = packageRoot(dirname(id.split('?')[0]!));
      if (!root || resolve(root) === own) continue;
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version?: string };
      const key = `${pkg.name}@${pkg.version ?? '(no version)'}`;
      if (!packages.has(key)) packages.set(key, root);
    }
    const sections = [...packages]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, root]) => {
        const files = readdirSync(root)
          .filter((f) => /^(licen[cs]e|copying|unlicense)/i.test(f) && statSync(join(root, f)).isFile())
          .sort();
        const text = files.length
          ? files.map((f) => readFileSync(join(root, f), 'utf8').trim()).join('\n\n')
          : `(no licence file in the package; package.json says: ${declaredLicence(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))})`;
        return `${'='.repeat(72)}\n${key}\n${'='.repeat(72)}\n\n${text}\n`;
      });
    this.emitFile({
      type: 'asset',
      fileName: 'THIRD_PARTY_LICENSES.txt',
      source: `Code from these packages is bundled into dist/.\n\n${sections.join('\n')}`,
    });
  },
});

export default defineConfig(({ mode }) => ({
  root: 'dev',
  // The withdrawal fixtures have localhost:5180 signed into them, so the dev
  // server has to be there. strictPort fails loudly if 5180 is taken, rather
  // than moving to another port where Withdrawn and Not withdrawn quietly break.
  server: { port: 5180, strictPort: true },
  // `--mode site` builds the demo page for the published site instead of the
  // library. It lives in a sub-folder (/verifier-plugin/, or /verifier-plugin/
  // pr-16/ for a preview), so every asset path is relative to that. See
  // scripts/build-site.js, which sets SITE_BASE.
  base: mode === 'site' ? (process.env.SITE_BASE ?? '/verifier-plugin/') : '/',
  build:
    mode === 'site'
      ? { outDir: '../site', emptyOutDir: true }
      : {
          outDir: '../dist',
          emptyOutDir: true,
          // verifier-core 2.x is bundled in, not left for the host app to
          // provide. The wallet has 1.x, and under its Vite dev server a linked
          // package's bare import gets the app's copy: the card then ran 1.x's
          // verifyCredential with 2.x's openbadges and reported "couldn't reach
          // the registry" for everything. Its production build was fine.
          // Checked in lcw-front-end on 1 October 2026. Bundled, both worked,
          // and so did the wallet's own 1.x check. It also spares a host the
          // git-SHA install, whose prepare script needs pnpm.
          //
          // Revisit when the host apps are on 2.x: then one shared copy beats
          // two. Going back means `rollupOptions.external` with a regex,
          // /^@digitalcredentials\/verifier-core(\/.*)?$/, not a string:
          // `external` matches exactly, so a string leaves subpath imports like
          // `verifier-core/openbadges` bundled, which is the very mix of
          // versions described above. Then move verifier-core back to
          // `dependencies`, drop the self-contained check, and drop or keep
          // the licence file depending on what is still bundled.
          lib: { entry: '../src/index.ts', formats: ['es'], fileName: 'index' },
        },
  // Library builds only: the published site's own copy is a page, not a package.
  plugins: mode === 'site' ? [] : [selfContained(), thirdPartyLicenses()],
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
}));
