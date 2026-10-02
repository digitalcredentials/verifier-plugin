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
        ? [...file.imports, ...file.dynamicImports].filter((id) => !Object.hasOwn(bundle, id)).map((id) => `${file.fileName} → ${id}`)
        : [],
    );
    if (outside.length) this.error(`dist must not import anything outside itself:\n  ${outside.join('\n  ')}`);
  },
});

/**
 * Both builds bundle code from other packages (verifier-core and its tree), so
 * both ship their licences beside it. Vite's own collector: it takes the first
 * LICENSE/LICENCE/COPYING file of each package in node_modules, which covers
 * every bundled package today (checked 2 October 2026).
 */
const LICENSES = { fileName: 'THIRD_PARTY_LICENSES.md' };

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
      ? { outDir: '../site', emptyOutDir: true, license: LICENSES }
      : {
          outDir: '../dist',
          emptyOutDir: true,
          license: LICENSES,
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
          // `dependencies` and drop the self-contained check.
          lib: { entry: '../src/index.ts', formats: ['es'], fileName: 'index' },
        },
  plugins: mode === 'site' ? [] : [selfContained()],
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
}));
