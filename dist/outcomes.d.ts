/**
 * Turns a verification result into what a person reads.
 *
 * Two functions, deliberately pure and free of any rendering, so the whole
 * design can be tested without a browser:
 *
 *   summarise()  — the single line the main view shows
 *   listChecks() — the per-check breakdown in the Details view
 *
 * The rules come from requirements.md §4 and §5 and inventory.md. Four
 * severities that never grow; a message list that does.
 */
import type { Severity, VerificationResponse } from './types.js';
/** One thing we tell the person. `code` is ours, and stable. */
export interface Outcome {
    severity: Severity;
    code: string;
    headline: string;
    /**
     * What the headline means, or what else reported. Can be empty — nothing is
     * written just to fill the space, so "Expired on 9 January 2026" stands alone
     * when no reassurance reported. Draw it only when it has text.
     */
    detail: string;
    /** Every problem names one thing to do. requirements.md §4. */
    action?: string;
}
export interface Check {
    id: string;
    label: string;
    severity: Severity;
    value: string;
}
/**
 * What the host knows that the library's result can't say.
 *
 * `registriesUnavailable`: the host couldn't get its list of registries, so
 * the issuer was never looked up (see `VerifyOptions`). A lookup that then
 * never answered reads as "our list of known issuers didn't load", which is
 * exactly what happened, rather than the vaguer "we couldn't finish checking".
 */
export interface OutcomeOptions {
    registriesUnavailable?: boolean;
}
/**
 * Where an issuer's name came from. requirements.md §5.
 *
 * `unverifiable` is the case the requirements don't cover: verification
 * stopped before anything could be established, so the name is just text in a
 * file nobody has vouched for.
 */
export type IssuerNameSource = 'registry' | 'credential' | 'none' | 'unknown' | 'unverifiable';
export interface IssuerIdentity {
    name: string;
    source: IssuerNameSource;
    /** Named registries that recognised them. */
    registries: string[];
    /**
     * Named registries we could not reach. May be empty while
     * `registriesUnreachable` is true: 2.x reports the names only in prose, so
     * they can be lost when the fact is not. Always empty when the host said
     * its list was unavailable, since nothing was looked up.
     */
    unreachable: string[];
    /**
     * Whether any registry went unchecked, or, with `registriesUnavailable`,
     * none could be looked up at all. Branch on this, not on
     * `unreachable.length` — this is what separates "we don't know" from "they
     * aren't listed", and it survives a change of wording upstream.
     */
    registriesUnreachable: boolean;
    /**
     * Whether the issuer's seal held, so the credential is theirs. A registry
     * match without it names a known issuer, not this credential's.
     */
    sealHeld: boolean;
    id?: string;
}
/**
 * Whether the credential offers a way to be withdrawn at all.
 *
 * If it doesn't, verifier-core produces no revocation step — not a failed one.
 * The absence means "the issuer provided no way to withdraw this", which is
 * not the same as "we tried and couldn't find out", and must not be shown as
 * though it were.
 */
export declare const hasStatusList: (r: VerificationResponse) => boolean;
/**
 * Nothing could be read, so there is no breakdown worth showing.
 * inventory.md Tier A.
 *
 * 1.x expressed this by returning errors and no log at all. 2.x has no such
 * shape — every suite runs and reports — so the equivalent is a failure among
 * the four core checks: no readable context, not a verifiable credential, an
 * unusable identifier, or no proof at all. Any one of them means the rest of
 * the card is describing a file we cannot stand behind.
 */
export declare const stoppedEarly: (r: VerificationResponse) => boolean;
/**
 * Four answers, and the difference between the last two matters.
 *
 * - `invalid`   — it was built wrong. A finding, and the issuer's to fix.
 * - `valid`     — it matches the standard it claims.
 * - `no_schema` — nothing declared a standard to check it against. Nothing
 *                 failed and there was nothing to try.
 * - `unavailable` — there was a standard and we could not load it.
 *
 * `missingOnly` separates "the issuer left fields out" from "a field is the
 * wrong shape", because only the first can be described to a person in words
 * they will recognise.
 */
export type SchemaFinding = {
    state: 'valid';
} | {
    state: 'invalid';
    missingOnly: boolean;
} | {
    state: 'no_schema';
} | {
    state: 'unavailable';
} | {
    state: 'not_run';
};
/**
 * The schema check is a real check in 2.x, but it is neither fatal nor in the
 * default suites — verify.ts adds it back. So a credential can still be
 * reported as `verified` while failing its own schema, exactly as in 1.x
 * where the result was filed outside the log entirely. Either way, reading
 * only what bears on authenticity throws this away silently.
 */
export declare const schemaFinding: (r: VerificationResponse) => SchemaFinding;
/**
 * requirements.md §5. The answer to "who issued it" is not yes or no. It is a
 * name and its provenance — and "not listed" and "couldn't reach the registry"
 * are different answers that look identical if you only read `valid`.
 */
export declare const issuerIdentity: (r: VerificationResponse, options?: OutcomeOptions) => IssuerIdentity;
/**
 * The short marker shown beside the issuer's name in the main view.
 *
 * requirements.md §5 asks for this, and for it to repeat what the verdict
 * says, because people scan and read the first thing they meet. Nothing is
 * shown on the happy path: a recognised issuer needs no caveat, and putting
 * registry vocabulary there would be machinery talk on the screen most people
 * see most often.
 */
export declare const issuerMarker: (source: IssuerNameSource, sealHeld: boolean) => string | undefined;
/**
 * Whether the finding should come before the credential.
 *
 * requirements.md §4 says the credential leads, and that is right when the
 * credential is the point. When verification could not start, the credential
 * is exactly what is in question, so the finding is the point. A deliberate
 * exception, and only for this case.
 *
 * This briefly also covered a failed signature, which swept in expiry —
 * 2.x has no expiration check, so an expired credential fails the signature
 * check and was having its title pushed below the verdict. An expired
 * credential is not in question; it has simply run out.
 */
export declare const verdictLeads: (r: VerificationResponse) => boolean;
/**
 * Deliberately nothing, and this is a decision rather than an omission.
 *
 * There used to be a line here — "These details are what the file says. We
 * can't confirm any of them." — shown whenever the signature did not verify.
 * Reviewed with the team on 29 September 2026 and removed: it contradicted
 * the breakdown directly underneath it, where the issuer row read "found in
 * Local Dev Registry" in green while the sentence above said nothing could be
 * confirmed.
 *
 * The contradiction was really in that row. A registry lookup establishes that
 * a DID is a known issuer; it does not establish that this credential came
 * from them, and only the signature does that. So the doubt now sits on the
 * row that overstated, where a reader meets it beside the claim it qualifies,
 * rather than as a blanket disclaimer over fields that are mostly fine.
 *
 * Kept as a function because the component calls it and because the decision
 * is worth finding when someone wonders where the sentence went.
 */
export declare const contentCaveat: (_r: VerificationResponse) => string | undefined;
/**
 * Picks the single most important thing to say.
 *
 * Order matters. A credential that was withdrawn *and* has an unreachable
 * registry is withdrawn; saying "we couldn't check" would bury the fact that
 * the issuer has already decided.
 */
export declare const summarise: (r: VerificationResponse, options?: OutcomeOptions) => Outcome;
export declare const listChecks: (r: VerificationResponse, options?: OutcomeOptions) => Check[];
