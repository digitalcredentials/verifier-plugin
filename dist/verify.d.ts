/**
 * Runs verifier-core and hands back its result unchanged.
 *
 * Kept deliberately thin. Everything that decides what a person reads lives in
 * outcomes.ts, so it can be tested without a browser or a network.
 *
 * Thin does not mean empty, though. Two of 2.x's defaults are wrong for this
 * component, and correcting them is this file's real job — see `recognizers`
 * and `additionalSuites` below. Left alone, 2.x reports a credential that
 * violates its own standard as verified, with nothing to show for it.
 */
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
export declare const DEFAULT_REGISTRIES: Registry[];
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
export declare const verify: (credential: Record<string, unknown>, options?: VerifyOptions) => Promise<VerificationResponse>;
