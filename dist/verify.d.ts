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
 * that passed identically to one that never ran. A fourth correction is a
 * stopgap for a library bug: see `namingDidWebOutages`.
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
 * verifier-core's HttpGetService, restated. Named from the library, it would
 * put an import of verifier-core in the published types, and hosts never
 * install verifier-core: it is bundled.
 */
interface HttpGetService {
    get: (url: string) => Promise<{
        body: unknown;
        headers: Headers;
        status: number;
    }>;
}
/**
 * Stopgap for verifier-core#65: an issuer website that is down reads as down,
 * not as tampering.
 *
 * A did:web issuer publishes its signing key in a did.json on its own site.
 * When that file won't load — the site doesn't answer, or answers 404 —
 * verifier-core's did:web resolver throws a plain Error, and its signature
 * check, which only knows a fetch failed if the error is named `HTTPError`,
 * reports INVALID_SIGNATURE: what a tampered credential gets. outcomes.ts
 * then tells an earner their honest credential was tampered with.
 *
 * This wraps the fetcher so a did.json that won't load fails with an
 * `HTTPError` naming its address. The signature check then reports
 * DID_WEB_UNRESOLVED, which outcomes.ts already words as "we couldn't reach"
 * the issuer's website (verified against the library and vc-test-fixtures'
 * badDidWeb.json, 8 October 2026). Delete this when verifier-core#65 is fixed.
 *
 * - "Won't load" includes the built-in fetcher refusing it: an issuer on a
 *   private address, too many redirects, a body over 5 MB. We didn't reach
 *   their key, which is true; telling refusals apart would mean reading the
 *   fetcher's sentences, which outcomes.ts doesn't do. It used to say tampered.
 * - The signature check only says DID_WEB_UNRESOLVED when the address
 *   contains the issuer's did:web, so a key on another host, or an issuer
 *   whose did:web has a port, reads as HTTP_ERROR instead: "something we
 *   needed didn't load". Not tampered either.
 * - Only addresses ending in /did.json, which is where did:web keeps a key;
 *   status lists and registries don't, and get their statuses back as
 *   before, to branch on themselves. A did.json that loads but is wrong is
 *   left alone: that is not an outage.
 */
export declare const namingDidWebOutages: (inner: HttpGetService) => HttpGetService;
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
export {};
