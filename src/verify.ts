/**
 * Runs verifier-core and hands back its result unchanged.
 *
 * Kept deliberately thin. Everything that decides what a person reads lives in
 * outcomes.ts, so it can be tested without a browser or a network.
 */

import { verifyCredential } from '@digitalcredentials/verifier-core';
import type { VerificationResponse } from './types.js';

export interface Registry {
  name: string;
  type: 'dcc-legacy' | 'oidf';
  url?: string;
  trustAnchorEC?: string;
}

/**
 * The registries a wallet checks by default.
 *
 * Confirmed working in a browser on 21 September 2026: the lookup is a plain
 * GET with no custom headers, so it does not trigger a CORS preflight and
 * GitHub Pages serves it happily.
 */
export const DEFAULT_REGISTRIES: Registry[] = [
  {
    name: 'DCC Sandbox Registry',
    type: 'dcc-legacy',
    url: 'https://digitalcredentials.github.io/sandbox-registry/registry.json',
  },
];

export interface VerifyOptions {
  registries?: Registry[];
}

/**
 * Known limitation, and it is upstream rather than ours.
 *
 * Fetching an issuer's status list fails in a browser: the request triggers a
 * CORS preflight and GitHub Pages answers OPTIONS with a 405. veri-good works
 * around this with its own document loader, but verifier-core builds its
 * loader at module scope and `verifyCredential` accepts no loader argument, so
 * we cannot supply one from here.
 *
 * Until that is fixed upstream, expect the withdrawal check not to complete
 * for credentials that carry a status list. The display handles this honestly
 * — see the `withdrawal_unknown` outcome — but it is a real gap, not a
 * cosmetic one.
 */
export const verify = async (
  credential: Record<string, unknown>,
  options: VerifyOptions = {},
): Promise<VerificationResponse> => {
  const knownDIDRegistries = options.registries ?? DEFAULT_REGISTRIES;
  return (await verifyCredential({
    credential: credential as never,
    knownDIDRegistries,
  })) as VerificationResponse;
};
