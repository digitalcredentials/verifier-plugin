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
      external: ['@digitalcredentials/verifier-core'],
    },
  },
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
});
