import { defineConfig } from 'vite';

export default defineConfig({
  root: 'dev',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    lib: { entry: '../src/index.ts', formats: ['es'], fileName: 'index' },
    rollupOptions: {
      // verifier-core is a declared dependency, so it should be resolved by
      // whoever installs this — not baked into our bundle, where it would be
      // a second copy alongside the host app's.
      //
      // A regex, not a string: `external` matches exactly, so a bare string
      // leaves subpath imports like `verifier-core/openbadges` to be inlined,
      // which quietly pulled Zod and Ajv into the bundle.
      external: [/^@digitalcredentials\/verifier-core(\/.*)?$/],
    },
  },
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
});
