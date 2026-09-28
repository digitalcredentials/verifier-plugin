/**
 * Runs verifier-core and hands back its result unchanged.
 *
 * Kept deliberately thin. Everything that decides what a person reads lives in
 * outcomes.ts, so it can be tested without a browser or a network.
 *
 * Thin does not mean empty, though. Three of 2.x's defaults are wrong for this
 * component, and correcting them is this file's real job — see `verbose`,
 * `recognizers` and `additionalSuites` below. Left alone, 2.x reports a
 * credential that violates its own standard as verified, and reports a check
 * that passed identically to one that never ran.
 */

import { verifyCredential } from '@digitalcredentials/verifier-core';
import {
  obv3p0Recognizer,
  openBadgesSchemaSuite,
} from '@digitalcredentials/verifier-core/openbadges';
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
 * The status-list gap is closed, and it closed upstream rather than here.
 *
 * 1.x built its document loader at module scope and `verifyCredential` took no
 * loader argument, so an issuer's status list could not be fetched in a
 * browser: the request went out with headers, which triggered a CORS
 * preflight, and GitHub Pages answers OPTIONS with a 405. There was no way to
 * supply veri-good's workaround from outside the library.
 *
 * 2.x routes every remote fetch — JSON-LD contexts, did:web documents and
 * status lists — through an `httpGetService` whose built-in implementation is
 * a bare `fetch(url)`. No headers means no preflight, which is the same reason
 * registry lookups have always worked. `httpGetService` and `documentLoader`
 * are also both injectable now, so if a future default reintroduces headers we
 * can supply our own rather than wait.
 *
 * Verified in Node against an injected service; **not yet confirmed in a
 * browser against a real cross-origin status list.** The remaining unknown is
 * whether vc-bitstring-status-list fetches through the loader it is handed.
 * Until a browser test covers it, treat this as very likely rather than done.
 */
export const verify = async (
  credential: Record<string, unknown>,
  options: VerifyOptions = {},
): Promise<VerificationResponse> => {
  const registries = options.registries ?? DEFAULT_REGISTRIES;
  return (await verifyCredential({
    credential,
    registries: registries as never,

    // 2.x defaults this to false, which drops every check that passed and
    // keeps only failures and skips. A passed check and a check that never ran
    // would then both be simply absent, and telling those two apart is the
    // single thing this component must not get wrong — six of the ten defects
    // found in review were a verdict claiming something the breakdown said was
    // never checked. The per-suite rollup cannot stand in for it either: its
    // counts are per suite, not per check.
    verbose: true,

    // Without a recognizer, 2.x skips recognition entirely and hands back no
    // normalized form. Supplying it is also what makes `recognizedProfile`
    // meaningful for the developer view later.
    recognizers: [obv3p0Recognizer],

    // The Open Badges schema check is not in the default suites, so a
    // credential that breaks its own standard comes back verified with nothing
    // to show. In 1.x the same check ran unasked and was filed under
    // `additionalInformation`. Adding it back keeps the "How it was built" row
    // honest.
    //
    // Only the schema suite. The semantic suite's extra checks (result
    // references, achievement levels) are real but we display none of them,
    // and running checks we throw away would slow every verification for
    // nothing.
    additionalSuites: [openBadgesSchemaSuite],
  })) as VerificationResponse;
};
