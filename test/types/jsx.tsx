/**
 * Type test, not run: `npm run typecheck` compiles it. A React host must be
 * able to write <verifier-credential> with its properties after importing the
 * package, and a wrong type must fail to compile.
 */
import '../../src/index.js';
import type { Registry } from '../../src/index.js';

const registries: Registry[] = [{ name: 'DCC Sandbox Registry', type: 'dcc-legacy', url: 'https://example.org/registry.json' }];

export const props = (
  <verifier-credential credential={{ type: ['VerifiableCredential'] }} registries={registries} registriesUnavailable />
);

// @ts-expect-error registries is a list, not a string
export const wrongType = <verifier-credential registries="https://example.org/registry.json" />;
