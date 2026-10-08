/**
 * The one Vite variable this library reads: `import.meta.env.DEV`, which Vite
 * replaces with a literal at build time (`false` in the library and site
 * builds). Declared here rather than by referencing `vite/client`, which would
 * be copied into the published `.d.ts` files and ask every host for Vite's
 * types. This file emits nothing.
 */
interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}
