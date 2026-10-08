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
  /**
   * The host app couldn't get its list of registries. The issuer is then not
   * looked up at all, rather than in registries the host never chose, and
   * `registries` is ignored: verifier-core reports the lookup as skipped, and
   * outcomes.ts, told the same thing, says the list didn't load. Without
   * this, a wallet whose list failed fell back to DEFAULT_REGISTRIES and told
   * the earner a listed issuer was "not on our list of known issuers".
   */
  registriesUnavailable?: boolean;
}

/**
 * A plain fetcher for the dev server and the browser tests only.
 *
 * verifier-core's own fetcher refuses anything but `https:`, and never fetches
 * localhost or a private address — every redirect included — so a credential
 * cannot point a verifier at someone's intranet. Hosts keep that: this is not
 * reachable from the library or the published demo site, whose builds replace
 * `import.meta.env.DEV` with `false` and drop this along with it.
 *
 * But the dev page and the browser tests serve their registry, withdrawal list
 * and schema from localhost, so under the dev server they need a fetcher that
 * will go there. It is a bare `fetch(url)`, like the built-in one: no headers,
 * so no CORS preflight, which is what lets a withdrawal list on another site
 * load at all (see below). It returns parsed JSON when the body is JSON and the
 * text otherwise, as the built-in service does; it has none of its timeout,
 * size cap or address checks, which is exactly why it stays out of builds.
 */
const devHttpGetService = {
  get: async (url: string) => {
    const response = await fetch(url);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the text, as verifier-core's own fetcher hands it back.
    }
    return { body, headers: response.headers, status: response.status };
  },
};

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
 * Confirmed in a browser on 1 October 2026, against the real GitHub Pages: a
 * page on localhost found the published Withdrawn credential withdrawn and Not
 * withdrawn clear. The browser tests covered it against a server that
 * refuses preflights the same way (test/browser/pages-like-server.js) until
 * they moved to the dev-only fetcher below, which is also a bare GET. And
 * the status list does go through the built-in service: patched to send a
 * custom header, it makes the withdrawal check fail with
 * STATUS_LIST_NOT_FOUND (tried by hand on 1 October, not a standing test).
 */
export const verify = async (
  credential: Record<string, unknown>,
  options: VerifyOptions = {},
): Promise<VerificationResponse> => {
  const registries = options.registries ?? DEFAULT_REGISTRIES;
  return (await verifyCredential({
    credential,
    // Left out when the host's list failed. On verifier-core's main (read off
    // the library, 7 October 2026) an empty list and no list both skip the
    // lookup ("No registries configured"), so
    // this no longer changes what the library reports — it states the intent,
    // and outcomes.ts reads the same flag to say the list didn't load.
    ...(options.registriesUnavailable ? {} : { registries: registries as never }),

    // Dev server and browser tests only; see devHttpGetService. Note what that
    // costs: the cross-site tests (pages-like-server.js, which refuses CORS
    // preflights as GitHub Pages does) now exercise this fetcher, not the
    // built-in one. Both send a bare GET with no custom headers, so neither
    // triggers a preflight (read off the library, 7 October 2026) — but only a
    // run against a published copy exercises the built-in one for real.
    ...(import.meta.env.DEV ? { httpGetService: devHttpGetService } : {}),

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
