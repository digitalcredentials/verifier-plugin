/**
 * Tells a React host's JSX about <verifier-credential>, so a wallet doesn't
 * keep its own copy of these types (lcw-front-end docs/plugins.md, section 3).
 *
 * Type-only: it compiles to an empty module, and index.ts imports it so the
 * published index.d.ts pulls this augmentation in. `react` is resolved from
 * the host; here it comes from the @types/react devDependency.
 *
 * `credential`, `registries` and `registriesUnavailable` are properties, not
 * attributes: React 19 sets object-valued props on a custom element that
 * defines them as properties, so they arrive as objects.
 */
import type * as React from 'react';
import type { VerifierCredential } from './verifier-credential.js';
import type { Registry } from './verify.js';
declare module 'react' {
    namespace JSX {
        interface IntrinsicElements {
            'verifier-credential': React.DetailedHTMLProps<React.HTMLAttributes<VerifierCredential>, VerifierCredential> & {
                credential?: Record<string, unknown>;
                registries?: Registry[];
                registriesUnavailable?: boolean;
            };
        }
    }
}
