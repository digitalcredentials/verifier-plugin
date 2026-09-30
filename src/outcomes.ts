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

import {
  CHECK,
  PROBLEM,
  STATUS_LIST_PROBLEM_PREFIX,
  EXPIRED_MARKERS,
  TAMPERED_MARKERS,
  REGISTRY_FOUND,
  REGISTRY_UNCHECKED,
  STRUCTURAL_CONTEXT_DETAILS,
} from './types.js';
import type { Severity, VerificationResponse, CheckResult, ProblemDetail } from './types.js';

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
 * Where an issuer's name came from. requirements.md §5.
 *
 * `unverifiable` is the case the requirements don't cover: verification
 * stopped before anything could be established, so the name is just text in a
 * file nobody has vouched for.
 */
export type IssuerNameSource =
  | 'registry'
  | 'credential'
  | 'none'
  | 'unknown'
  | 'unverifiable';

export interface IssuerIdentity {
  name: string;
  source: IssuerNameSource;
  /** Named registries that recognised them. */
  registries: string[];
  /**
   * Named registries we could not reach. May be empty while
   * `registriesUnreachable` is true: 2.x reports the names only in prose, so
   * they can be lost when the fact is not.
   */
  unreachable: string[];
  /**
   * Whether any registry went unchecked. Branch on this, not on
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

// ---------------------------------------------------------------------------
// Reading the result safely
// ---------------------------------------------------------------------------

const checksById = (r: VerificationResponse): Map<string, CheckResult> => {
  const map = new Map<string, CheckResult>();
  for (const check of r.results ?? []) {
    // The library always computes `id` after running the suites, so the
    // fallback only keeps a hand-built literal from vanishing. It cannot match
    // a CHECK constant: those carry the phase, which `suite` and `check` do
    // not, so there is nothing to reconstruct it from.
    map.set(check.id ?? check.check, check);
  }
  return map;
};

/** The problems a failed check reported, or nothing if it did not fail. */
const problemsOf = (check: CheckResult | undefined): ProblemDetail[] =>
  check?.outcome.status === 'failure' ? check.outcome.problems : [];

const hasProblem = (check: CheckResult | undefined, type: string): boolean =>
  problemsOf(check).some((p) => p.type === type);

/**
 * Whether any problem's prose contains one of a set of markers.
 *
 * Reading prose is a last resort and the call sites say why each one is
 * unavoidable. Kept to one helper so they are easy to find and delete.
 */
const detailMatches = (
  check: CheckResult | undefined,
  markers: readonly string[],
): boolean =>
  problemsOf(check).some((p) =>
    markers.some((m) => (p.detail ?? '').includes(m)),
  );

/**
 * Whether the credential offers a way to be withdrawn at all.
 *
 * If it doesn't, verifier-core produces no revocation step — not a failed one.
 * The absence means "the issuer provided no way to withdraw this", which is
 * not the same as "we tried and couldn't find out", and must not be shown as
 * though it were.
 */
export const hasStatusList = (r: VerificationResponse): boolean => {
  const status = r.verifiableCredential?.['credentialStatus'];
  return Array.isArray(status) ? status.length > 0 : status != null;
};

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
export const stoppedEarly = (r: VerificationResponse): boolean => {
  const checks = checksById(r);
  return [
    // Parsing runs before the core suite and is what a document that is not a
    // credential at all fails. Leaving it out rendered `{"hello":"world"}` as
    // a card with five breakdown rows and no caveat.
    CHECK.envelope,
    CHECK.contextExists,
    CHECK.vcContext,
    CHECK.credentialId,
    CHECK.proofExists,
  ].some((id) => checks.get(id)?.outcome.status === 'failure');
};

/**
 * A check passed.
 *
 * The 1.x version of this carried a warning about spelling `=== true`, because
 * a check that could not be completed had no `valid` field and `!valid` would
 * have called it a failure. 2.x makes the three cases distinct, so the warning
 * is obsolete — but the distinction it protected is not, and every call site
 * below still asks "did this pass" rather than "did this not fail".
 */
const passed = (check: CheckResult | undefined): boolean =>
  check?.outcome.status === 'success';

/** A check actively failed, as opposed to not having run. */
const failed = (check: CheckResult | undefined): boolean =>
  check?.outcome.status === 'failure';

/**
 * Pull the "A, B" list out of one of the registry sentences.
 *
 * The library joins names with ", ", so a registry whose own name contains a
 * comma cannot be recovered faithfully — another reason this wants to be data
 * rather than prose. Splitting is deliberately on ", " rather than "," so at
 * least "Acme Registry, Inc." degrades to two plausible names instead of a
 * name and a fragment, and nothing but a sentence depends on the result.
 */
const namesIn = (text: string, marker: RegExp): string[] => {
  const captured = marker.exec(text)?.[1];
  return (captured ?? '')
    .split(', ')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
};

/**
 * Which registries recognised the issuer.
 *
 * 2.x carries no payload on a successful registry check, but the names are in
 * the message — `Issuer found in registry: A`, or `Issuer found in 2
 * registries: A, B`. Parsing prose is not how this should arrive and it is
 * raised on verifier-core#32, but the information is real and §5 is built on
 * it, so we read it rather than pretend it is gone.
 *
 * Failing to parse costs a name in a sentence: the callers fall back to "a
 * registry we check", which is still true. Nothing about the verdict rests on
 * it — that rests on the check having passed.
 */
const registryNames = (check: CheckResult | undefined): string[] =>
  check?.outcome.status === 'success'
    ? namesIn(check.outcome.message, REGISTRY_FOUND)
    : [];

/**
 * Which registries we could not reach.
 *
 * The fact is reported as a problem type, which is reliable. The names are
 * only in that problem's prose — "2 registries could not be checked: A, B" —
 * so they are taken from after the first colon, best effort. Failing to
 * extract them costs a name in a sentence; the distinction that matters
 * (unreachable is not the same as "not listed") rests on the type, not the
 * prose, and so survives a wording change.
 */
const unreachableNames = (check: CheckResult | undefined): string[] => {
  if (check?.outcome.status === 'success') {
    // Appended to the success message after the matched registries.
    return namesIn(check.outcome.message, REGISTRY_UNCHECKED);
  }
  const problem = problemsOf(check).find((p) => p.type === PROBLEM.registryUnchecked);
  return problem ? namesIn(problem.detail ?? '', REGISTRY_UNCHECKED) : [];
};

/**
 * Whether any registry went unchecked, independently of whether we could read
 * its name. This is the load-bearing half: it decides whether we say "we don't
 * know" or "they aren't listed", and it rests on the problem type alone.
 */
/**
 * The registry check reached a verdict on this issuer.
 *
 * A lookup that threw (REGISTRY_ERROR) or never ran — no registries
 * configured, no lookup available — establishes nothing. Reading either as
 * "not in any registry we check" states a negative we never tested, which is
 * the §5 mistake this file exists to avoid.
 */
const registryAnswered = (check: CheckResult | undefined): boolean =>
  check?.outcome.status === 'success' || hasProblem(check, PROBLEM.issuerNotRegistered);

const anyUnreachable = (check: CheckResult | undefined): boolean =>
  hasProblem(check, PROBLEM.registryUnchecked) ||
  (check?.outcome.status === 'success' &&
    REGISTRY_UNCHECKED.test(check.outcome.message));

/**
 * The issuer has actually withdrawn this.
 *
 * Deliberately narrower than "the withdrawal check failed". The check also
 * fails when the list would not load, had expired, or did not verify, and none
 * of those establish anything about the credential. Reporting one of them as a
 * withdrawal would be the gravest false claim this component could make, and
 * in 1.x only the absence of any distinction kept us from it.
 */
const isWithdrawn = (check: CheckResult | undefined): boolean =>
  hasProblem(check, PROBLEM.revoked);

/** The withdrawal check ran, failed, and established nothing either way. */
const withdrawalUnavailable = (check: CheckResult | undefined): boolean =>
  problemsOf(check).some((p) => p.type.startsWith(STATUS_LIST_PROBLEM_PREFIX));

// ---------------------------------------------------------------------------
// Whether the credential was built the way its own standard requires
// ---------------------------------------------------------------------------

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
export type SchemaFinding =
  | { state: 'valid' }
  | { state: 'invalid'; missingOnly: boolean }
  | { state: 'no_schema' }
  | { state: 'unavailable' };

/**
 * The schema check is a real check in 2.x, but it is neither fatal nor in the
 * default suites — verify.ts adds it back. So a credential can still be
 * reported as `verified` while failing its own schema, exactly as in 1.x
 * where the result was filed outside the log entirely. Either way, reading
 * only what bears on authenticity throws this away silently.
 */
export const schemaFinding = (r: VerificationResponse): SchemaFinding => {
  const check = checksById(r).get(CHECK.schema);
  // Absent means the suite was never added. 1.x ran this check unasked; 2.x
  // leaves it out of the defaults, so verify.ts adds it back — see the note
  // there. If that ever regresses, "no standard was declared" is the honest
  // thing to say, and it is what the reader sees.
  if (!check) return { state: 'no_schema' };

  if (check.outcome.status === 'skipped') {
    // The two reasons the check actually emits. "Does not appear to be an OBv3
    // credential" means nothing declared a standard we know how to check
    // against — nothing failed and there was nothing to try. Anything else
    // means the check could not be carried out, which establishes nothing.
    return /does not appear to be an OBv3/i.test(check.outcome.reason)
      ? { state: 'no_schema' }
      : { state: 'unavailable' };
  }

  if (check.outcome.status === 'success') return { state: 'valid' };

  const problems = problemsOf(check);
  // A failure that is not a validation failure means we could not carry the
  // check out — an unreachable schema, say — which establishes nothing and
  // must not be reported as "built wrong".
  if (!problems.some((p) => p.type === PROBLEM.schemaValidationFailed)) {
    return { state: 'unavailable' };
  }

  // Ajv's own phrasing, not verifier-core's, and it reaches us only inside the
  // problem's prose. Reading it is safe in a way the expiry marker is not:
  // getting this wrong picks the more general of two wordings, and cannot
  // produce a claim about the credential that is untrue.
  // The check joins every Ajv complaint into one `detail` with "; ", after a
  // preamble naming the schema. So "are they all missing fields" is a question
  // about the clauses, not about the problems — reading the whole string at
  // once answered "yes" for any failure that included one missing field.
  const clauses = problems
    .filter((p) => p.type === PROBLEM.schemaValidationFailed)
    .flatMap((p) => (p.detail ?? '').split(': ').slice(1).join(': ').split('; '))
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return {
    state: 'invalid',
    missingOnly:
      clauses.length > 0 && clauses.every((c) => c.includes('must have required property')),
  };
};

/**
 * Whether the issuer's seal held: nothing in the credential changed since they
 * signed it. The one answer every row, reassurance and marker uses.
 *
 * More than `passed(signature)`, because 2.x has no expiration check: an
 * expired credential *fails* the signature check. But @digitalcredentials/vc
 * checks dates only after the proof has verified (`_verifyCredential` runs
 * `jsigs.verify` and returns on failure, then `_checkCredential`), so a failure
 * whose reason is the end date means the seal itself was fine. Read off the
 * library, 30 September 2026. Tampering is excluded by its own marker, so a
 * credential that was both altered and past its date is never called intact.
 */
const sealHeld = (checks: Map<string, CheckResult>): boolean => {
  const signature = checks.get(CHECK.signature);
  if (passed(signature)) return true;
  return (
    failed(signature) &&
    detailMatches(signature, EXPIRED_MARKERS) &&
    !detailMatches(signature, TAMPERED_MARKERS)
  );
};

// ---------------------------------------------------------------------------
// The issuer: a name, plus where the name came from
// ---------------------------------------------------------------------------

/**
 * requirements.md §5. The answer to "who issued it" is not yes or no. It is a
 * name and its provenance — and "not listed" and "couldn't reach the registry"
 * are different answers that look identical if you only read `valid`.
 */
export const issuerIdentity = (r: VerificationResponse): IssuerIdentity => {
  const checks = checksById(r);
  const step = checks.get(CHECK.registeredIssuer);
  const nothingEstablished = stoppedEarly(r);
  const held = !nothingEstablished && sealHeld(checks);
  const registries = registryNames(step);
  const registriesUnreachable = anyUnreachable(step);
  const unreachable = registriesUnreachable ? unreachableNames(step) : [];

  const rawIssuer = (r.verifiableCredential?.['issuer'] ?? undefined) as
    | string
    | { id?: string; name?: string }
    | undefined;
  const id = typeof rawIssuer === 'string' ? rawIssuer : rawIssuer?.id;
  const claimedName = typeof rawIssuer === 'string' ? undefined : rawIssuer?.name;

  // 2.x carries no registry payload, so there is no registry-sourced name to
  // prefer over the credential's own. See registryNames().
  const registryName: string | undefined = undefined;

  // If a registry recognised the issuer, say so even when it gave us no name
  // to show. Falling through to "not in any registry" here would put a green
  // verdict at the top of a card whose details deny it.
  if (passed(step)) {
    return {
      name: registryName ?? claimedName ?? id ?? 'Unknown issuer',
      source: 'registry',
      registries,
      unreachable,
      registriesUnreachable,
      sealHeld: held,
      id,
    };
  }
  // A registry we could not reach means we do not know, rather than "no".
  const source: IssuerNameSource = nothingEstablished
    ? 'unverifiable'
    : registriesUnreachable || !registryAnswered(step)
      ? 'unknown'
      : 'credential';
  if (claimedName)
    return { name: claimedName, source, registries, unreachable, registriesUnreachable, sealHeld: held, id };
  // No name anywhere. `none` says so — but it must not swallow the fact that
  // a registry was unreachable, or the marker beside the name reads
  // "unconfirmed" while the verdict says we simply don't know.
  return {
    name: id ?? 'Unknown issuer',
    source: nothingEstablished
      ? 'unverifiable'
      : registriesUnreachable || !registryAnswered(step)
        ? 'unknown'
        : 'none',
    registries,
    unreachable,
    registriesUnreachable,
    sealHeld: held,
    id,
  };
};

/**
 * The short marker shown beside the issuer's name in the main view.
 *
 * requirements.md §5 asks for this, and for it to repeat what the verdict
 * says, because people scan and read the first thing they meet. Nothing is
 * shown on the happy path: a recognised issuer needs no caveat, and putting
 * registry vocabulary there would be machinery talk on the screen most people
 * see most often.
 */
// `sealHeld` is required on purpose: left out, the safe answer is "unconfirmed",
// and a default would pick the unsafe one silently.
export const issuerMarker = (source: IssuerNameSource, sealHeld: boolean): string | undefined => {
  switch (source) {
    case 'registry':
      // A recognised issuer needs no marker — but only while the seal holds.
      // Without it the registry names a known issuer, not this credential's,
      // and the Issuer row says exactly that. The name above it has to agree.
      return sealHeld ? undefined : 'unconfirmed';
    case 'unknown':
      return 'not checked';
    case 'unverifiable':
      // This used to be unmarked, on the grounds that the whole card carried
      // one caveat instead. That caveat was removed on 29 September 2026,
      // which left a name nobody can vouch for looking exactly like a genuine
      // one. Agreed with Sunny, 30 September: mark it, as an unlisted issuer
      // already is.
      return 'unconfirmed';
    default:
      return 'unconfirmed';
  }
};

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
export const verdictLeads = (r: VerificationResponse): boolean => stoppedEarly(r);

/**
 * Whether we can stand behind the credential's contents.
 *
 * False when the signature did not pass: the registry can tell us a DID is a
 * known issuer, but only the signature ties *this* credential to them.
 */
const contentConfirmed = (r: VerificationResponse): boolean =>
  !stoppedEarly(r) && sealHeld(checksById(r));

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
export const contentCaveat = (_r: VerificationResponse): string | undefined => undefined;

// ---------------------------------------------------------------------------
// Tier A — it stopped
// ---------------------------------------------------------------------------

/**
 * The library returns json-ld processing failures raw and unclassified, under
 * whatever name the underlying library used. They are a real case with real
 * advice — the credential's vocabulary cannot be read, and retrying will not
 * change that — so they get their own outcome rather than falling through to
 * "something went wrong, try again".
 */
const isJsonLdError = (text: string): boolean =>
  /json-?ld/i.test(text);

/**
 * verifier-core reaches its json-ld branch by finding such an error anywhere
 * in the list, so reading only the first one sends a credential whose
 * vocabulary cannot be parsed to "try again in a moment" — advice that can
 * never work, for a failure retrying will never change.
 */
const anyJsonLdError = (check: CheckResult | undefined): boolean =>
  problemsOf(check).some(
    (p) =>
      isJsonLdError(`${p.title} ${p.detail ?? ''}`) &&
      // `context-check` titles all three of its structural failures "Invalid
      // JSON-LD", so the title alone cannot tell a missing `@context` apart
      // from vocabulary the processor could not read. Only the latter is
      // unreadable_vocabulary, and only it gets "ask for a replacement" —
      // advice that would be useless for the others and wrong for a file
      // that simply is not a credential.
      !STRUCTURAL_CONTEXT_DETAILS.some((d) => (p.detail ?? '').includes(d)),
  );

const FATAL: Record<string, Omit<Outcome, 'code'>> = {
  unreadable_vocabulary: {
    severity: 'error',
    headline: "We can't read this credential",
    detail:
      "It uses vocabulary we couldn't process, so none of it could be checked. This is usually a problem with how it was built.",
    action: 'Ask the issuer for a replacement.',
  },
  invalid_jsonld: {
    severity: 'error',
    headline: "This file isn't a credential",
    detail: "It isn't structured in a way we can read, so there's nothing to check.",
    action: 'Ask whoever sent it for the original file.',
  },
  no_vc_context: {
    severity: 'error',
    headline: "This file isn't a credential",
    detail: "It's structured, but it doesn't say it's a verifiable credential.",
    action: 'Ask whoever sent it for the original file.',
  },
  invalid_credential_id: {
    severity: 'error',
    headline: "We can't check this credential",
    detail:
      "Its identifier isn't in a form we can use. This often means it came from an early pilot.",
    action: 'Ask the issuer for a replacement.',
  },
  no_proof: {
    severity: 'error',
    // Reviewed with Sunny, 30 September 2026: an average learner doesn't know
    // what a signature is for, so "no signature" told them nothing. The seal
    // is the plain-language stand-in, on trial pending feedback. The action
    // says "the issuer" rather than naming them: with no seal, the name
    // inside is exactly the thing we can't vouch for.
    headline: "We can't tell if this is genuine",
    detail:
      "It's missing the issuer's digital seal — the part that proves it came from them and shows whether anyone has tampered with it.",
    action: 'Ask the issuer for an official copy.',
  },
  invalid_signature: {
    severity: 'error',
    // "Tampered", to match the Tampering row beneath it. The team found it
    // clearer than "changed since it was issued", 30 September 2026.
    headline: 'This credential has been tampered with',
    detail: "Something in it was changed after it was issued. We can't tell what.",
    action: 'Ask the issuer for a fresh copy.',
  },
  // The two below mean we could not find out — not that anything is wrong.
  // Conflating them with invalid_signature is the worst mistake available.
  //
  // Both are currently UNREACHABLE against verifier-core 2.x, which reports a
  // transport failure and an unresolvable did:web as the same
  // PROOF_VERIFICATION_ERROR as everything else the proof suite cannot
  // complete. They fall to `signature_unchecked`, whose wording is the more
  // general version of the same thing, so nothing false is shown — only
  // something less specific. Kept, with their wording, for when upstream
  // distinguishes them; we have no did:web fixture to exercise either path
  // regardless.
  http_error_with_signature_check: {
    severity: 'unchecked',
    headline: "We couldn't finish checking this",
    detail: "Something we needed didn't load. That's a problem at our end, not with your credential.",
    action: 'Try again in a moment.',
  },
  did_web_unresolved: {
    severity: 'unchecked',
    headline: "We couldn't finish checking this",
    detail:
      "The issuer publishes their details on their own website, and we couldn't reach it.",
    action: 'Try again in a moment.',
  },
  unknown_error: {
    severity: 'unchecked',
    headline: "We couldn't finish checking this",
    detail: 'Something went wrong that we cannot describe more precisely.',
    action: 'Try again in a moment.',
  },
};

/**
 * Said in two places — when the signature check fails in a way we cannot
 * attribute, and when it never reported at all. Both mean the same thing to
 * the reader, so they say the same words.
 */
const UNCHECKED_SIGNATURE: Omit<Outcome, 'code'> = {
  severity: 'unchecked',
  headline: "We couldn't finish checking this",
  detail:
    "We couldn't check it for tampering. That's a problem at our end, not with your credential.",
  action: 'Try again in a moment.',
};

/**
 * What a finding may add about the rest of the credential.
 *
 * A verdict that leads with one problem usually wants to say the other
 * checks were fine — it is the difference between "this expired" and "this
 * is suspect". But that reassurance has been wrong three times now, always
 * the same way: stated as fixed text, so it appeared above a breakdown
 * reporting that the very thing it asserted had never been checked.
 *
 * So it is assembled from what reported, and returns nothing at all rather
 * than anything unearned. `test/consistency.test.ts` asserts the claim
 * against the rows, in prose, because severities cannot see this: both
 * sides read "unchecked" and agree perfectly while the sentence lies.
 */
const reassurance = (
  r: VerificationResponse,
  checks: Map<string, CheckResult>,
): string => {
  if (!sealHeld(checks)) return '';
  const notWithdrawn = !hasStatusList(r) || passed(checks.get(CHECK.status));
  return notWithdrawn
    ? " It hasn't been tampered with, and the issuer hasn't withdrawn it."
    : " It hasn't been tampered with.";
};

/**
 * The credential's own end date, as a Date. Ours to read, and the reason we do
 * not have to take the library's prose on trust when deciding expiry.
 */
const expiryOf = (r: VerificationResponse): Date | undefined => {
  const raw = r.verifiableCredential?.['validUntil'] ?? r.verifiableCredential?.['expirationDate'];
  if (typeof raw !== 'string') return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/** Past its end date, established from the credential rather than from prose. */
const isPastEndDate = (r: VerificationResponse): boolean => {
  const end = expiryOf(r);
  return end !== undefined && end.getTime() < Date.now();
};

/**
 * Whether this credential has run out.
 *
 * Defined once and read by both `summarise()` and `listChecks()`. Two copies
 * of this rule is exactly how a headline and a breakdown drift apart, and the
 * consistency suite caught them doing so the first time it ran against 2.x.
 *
 * The credential's own end date leads, because it is ours to check. The
 * library's prose is a second route for a date we could not parse.
 */
const isExpired = (r: VerificationResponse, checks: Map<string, CheckResult>): boolean => {
  const signature = checks.get(CHECK.signature);
  // The library said the date is why it stopped. That is an expiry we can
  // report whatever else is true.
  if (failed(signature) && detailMatches(signature, EXPIRED_MARKERS)) return true;
  // Otherwise the end date is only worth asserting when the signature
  // verified — an unverified `validUntil` is a number in a file nobody has
  // vouched for, and "Expired on 9 January 2026" states it as fact. When the
  // signature failed for some other reason we say we could not check instead.
  return passed(signature) && isPastEndDate(r);
};

const expiryDate = (r: VerificationResponse): string | undefined => {
  const raw = r.verifiableCredential?.['validUntil'] ?? r.verifiableCredential?.['expirationDate'];
  if (typeof raw !== 'string') return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  // Pinned to UTC. A credential's dates are properties of the credential, not
  // of where its holder happens to be standing, and a date-only value such as
  // "2026-01-09" parses as midnight UTC — which in New York would otherwise
  // render as the 8th.
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

// ---------------------------------------------------------------------------
// The one line the main view shows
// ---------------------------------------------------------------------------

/**
 * Picks the single most important thing to say.
 *
 * Order matters. A credential that was withdrawn *and* has an unreachable
 * registry is withdrawn; saying "we couldn't check" would bury the fact that
 * the issuer has already decided.
 */
export const summarise = (r: VerificationResponse): Outcome => {
  const checks = checksById(r);

  if (stoppedEarly(r)) {
    // Our codes are ours, and stable. Which of the four core checks failed is
    // what names the case now; 1.x named it with an error class, and an
    // unrecognised name leaking through into our catalogue was the risk then.
    const code = failed(checks.get(CHECK.vcContext))
      ? 'no_vc_context'
      : failed(checks.get(CHECK.credentialId))
        ? 'invalid_credential_id'
        : failed(checks.get(CHECK.proofExists))
          ? 'no_proof'
          : anyJsonLdError(checks.get(CHECK.contextExists))
            ? 'unreadable_vocabulary'
            : 'invalid_jsonld';
    return { code, ...FATAL[code]! };
  }

  const signature = checks.get(CHECK.signature);
  const revocation = checks.get(CHECK.status);
  const issuer = issuerIdentity(r);

  // 2.x has no expiration check: an expired credential and one altered after
  // issue both fail the *signature* check with the same problem type and the
  // same title. Prose is the only thing the library offers to tell them apart,
  // so expiry is established from the credential's own end date — which we
  // hold — with the marker as a second route for a date we could not parse.
  // An action names the issuer only when the seal held. Otherwise the name is
  // the credential's own claim, which the Issuer row says we can't confirm,
  // and telling someone to go to that name would contradict it.
  const named = sealHeld(checks) ? issuer.name : undefined;

  const signatureFailed = failed(signature);
  const tampered = signatureFailed && detailMatches(signature, TAMPERED_MARKERS);
  const expired = isExpired(r, checks);

  // Nothing below describes a credential that was altered, so this leads.
  if (tampered) {
    return { code: 'invalid_signature', ...FATAL['invalid_signature']! };
  }


  if (isWithdrawn(revocation)) {
    return {
      severity: 'error',
      code: 'withdrawn',
      headline: 'The issuer has withdrawn this',
      detail: 'This is no longer a valid credential.',
      action: `A new copy must be obtained from ${named ?? 'the issuer'}.`,
    };
  }

  // Expiry sits below withdrawal deliberately. A credential that was withdrawn
  // *and* has since run out is withdrawn: the issuer has already decided, and
  // "ask whether it can be renewed" would bury that behind a lesser finding.
  if (expired) {
    // Name the date. How stale it is changes what someone does about it, and
    // "eight months ago" is vaguer than a date when a qualification is at
    // stake. §4's relative times are about when *we* checked, not this.
    const on = expiryDate(r);
    return {
      severity: 'warning',
      code: 'expired',
      headline: on ? `Expired on ${on}` : 'This has passed its end date',
      // Only what reported: the seal held (the library checks dates after it),
      // so this normally says it hasn't been tampered with. It is assembled
      // rather than written out so that it appears when the checks behind it
      // did pass, and stays absent when they did not. Nothing fills the gap
      // otherwise: "Its dates have run out" only restated the headline.
      detail: reassurance(r, checks).trim(),
      action: `Ask ${named ?? 'the issuer'} whether it can be renewed.`,
    };
  }


  // A credential can be genuine, current, and not withdrawn, and still have
  // been built wrong. That is a finding rather than an unknown, so it leads
  // over everything below — but it is a warning and not an error: nothing
  // here says the credential is fake, and a red verdict would say exactly
  // that. It sits below `expired` because expiry is the one the holder can
  // actually do something about.
  const schema = schemaFinding(r);
  if (schema.state === 'invalid') {
    // The finding leads, but the reassurance beside it must not outrun the
    // checks that actually reported. "It's genuine and hasn't been withdrawn"
    // above a breakdown saying the signature was never checked, or the
    // withdrawal list never loaded, is precisely the contradiction this file
    // exists to prevent — and since status lists do not load in a browser
    // today, that second case is the common path and not an edge.
    return {
      severity: 'warning',
      code: 'malformed',
      headline: schema.missingOnly
        ? 'This credential is missing information it should have'
        : "This credential wasn't built the way it should have been",
      detail:
        (schema.missingOnly
          ? 'It leaves out details that credentials of this kind are required to carry.'
          : "Parts of it don't match the standard for this kind of credential.") +
        reassurance(r, checks),
      // Nate Otto, 22 September: "None of these are errors that the user who
      // holds the credential could resolve themselves." Naming a task the
      // reader cannot perform is worse than naming none, so the action says
      // whose it is and releases them from it.
      action: `${named ?? 'The issuer'} needs to fix how this was issued. There's nothing for you to do.`,
    };
  }

  // Everything below is "we couldn't check something", in order of how much
  // it costs the person to not know.
  // A credential that says it can be withdrawn, where the check did not come
  // back a pass. `failed` already returned above, so this covers every way of
  // not knowing: a named status-list error, an error we have no name for,
  // and — the case this missed until review — no revocation step in the log
  // at all, which is what verifier-core leaves behind for a
  // `credentialStatus` type it does not recognise. Falling through put a
  // green "Verified" whose detail said the issuer had not withdrawn it above
  // a row saying we could not check.
  const revocationError = withdrawalUnavailable(revocation);
  if (hasStatusList(r) && !passed(revocation)) {
    return {
      severity: 'unchecked',
      code: 'withdrawal_unknown',
      headline: "We couldn't check whether this was withdrawn",
      detail: revocationError
        ? "The issuer's withdrawal list didn't load. That's a problem with their setup, not with your credential."
        : "This credential says it can be withdrawn, but that check never ran, so we can't tell you either way. That's a problem at our end, not with your credential.",
      action: 'Try again in a moment.',
    };
  }

  // An unreachable registry only leaves us in doubt if nothing else answered.
  // A match and an unreachable registry are not mutually exclusive: with more
  // than one registry the check passes and still reports the one it could not
  // reach, both in the same sentence. Then we do know who issued this, and
  // saying we could not confirm it would contradict the issuer row, which
  // reads "found in ...".
  // `unknown` covers a lookup that threw or never ran. Letting it fall
  // through to `issuer_unconfirmed` stated a negative we never tested —
  // "they aren't in any registry we check" — which is the §5 mistake.
  if (
    (issuer.registriesUnreachable || issuer.source === 'unknown') &&
    !passed(checks.get(CHECK.registeredIssuer))
  ) {
    const which = !issuer.registriesUnreachable
      ? "The registry check didn't complete."
      : issuer.unreachable.length === 0
        ? "A registry we check didn't load."
        : issuer.unreachable.length === 1
        ? `The ${issuer.unreachable[0]} didn't load.`
        : `${issuer.unreachable.length} of the registries we check didn't load.`;
    return {
      severity: 'unchecked',
      code: 'registry_unreachable',
      headline: "We couldn't confirm who issued this",
      detail: `${which} That's a problem at our end, not with your credential. This is different from the issuer not being listed — we simply don't know.`,
      action: 'Try again in a moment.',
    };
  }

  // `passed(signature)` is a condition of this outcome, not an afterthought:
  // its first word is "Genuine", and the sentence under it says nothing has
  // changed since issue. Neither is ours to say until the signature check has
  // reported. Without it we fall through to `signature_unchecked` below,
  // which is the more serious unknown and should lead anyway — §5 is explicit
  // that an unlisted issuer is common and means nothing is wrong.
  if (!passed(checks.get(CHECK.registeredIssuer)) && passed(signature)) {
    // requirements.md §5: one sentence, not two verdicts, and ⓘ rather than ⚠.
    // Nothing is wrong here. Something is unknown.
    const says =
      issuer.source === 'none'
        ? "It doesn't give a name for its issuer, only an identifier."
        : `It says it was issued by ${issuer.name}. We couldn't confirm that independently — they aren't in any registry we check, which is common. It doesn't mean the credential is fake.`;
    return {
      severity: 'unchecked',
      code: 'issuer_unconfirmed',
      headline: "Genuine, but we can't confirm who issued it",
      detail: `It hasn't been tampered with, and the issuer hasn't withdrawn it. ${says}`,
    };
  }

  // Everything left is a pass — but only for the checks that actually
  // reported. A step missing from the log establishes nothing, and listChecks
  // shows it as "not checked"; the headline must not say otherwise.
  if (!passed(signature)) {
    return { code: 'signature_unchecked', ...UNCHECKED_SIGNATURE };
  }

  // There is no separate `expiry_unchecked` any more. 2.x folds the validity
  // period into the signature check, so dates cannot be unknown while the
  // signature is known — and if the signature did not report, the branch above
  // has already said so.

  return {
    severity: 'success',
    code: 'verified',
    headline: 'Verified',
    detail: "It hasn't been tampered with, and the issuer hasn't withdrawn it.",
  };
};

// ---------------------------------------------------------------------------
// The breakdown in the Details view
// ---------------------------------------------------------------------------

export const listChecks = (r: VerificationResponse): Check[] => {
  if (stoppedEarly(r)) return [];

  const checks = checksById(r);
  const issuer = issuerIdentity(r);
  const rows: Check[] = [];

  // Every label is the subject being checked, never a claim about it. A label
  // phrased as a statement ("Withdrawn by issuer") reads as a finding the
  // moment its value stops being a plain yes or no — and it also forces the
  // reader to flip between "yes is good" and "no is good" partway down the
  // list.
  const signature = checks.get(CHECK.signature);
  const tampered = failed(signature) && detailMatches(signature, TAMPERED_MARKERS);
  const confirmed = contentConfirmed(r);
  rows.push({
    id: CHECK.signature,
    // "Changes since issued" was written to avoid jargon and ended up not
    // saying what it checks. Reviewed with the team on 29 September 2026:
    // name tampering specifically, but plainly enough to put in front of
    // someone who earned the credential. The label stays a subject rather
    // than a claim, as every other row does.
    label: 'Tampering',
    // Only a signature failure we could attribute to tampering says so. An
    // expired credential also fails this check — but only after its seal
    // verified (see sealHeld), so it reads "none detected", not "not checked":
    // we did check, and nothing had changed.
    severity: sealHeld(checks) ? 'success' : tampered ? 'error' : 'unchecked',
    value: sealHeld(checks)
      ? 'none detected'
      : tampered
        ? 'detected'
        : 'not checked',
  });

  rows.push({
    id: CHECK.registeredIssuer,
    label: 'Issuer',
    // A registry match only counts as a pass while the signature holds. The
    // registry establishes that a DID is a known issuer; the signature is what
    // ties this credential to them, and without it "found in ..." claims more
    // than we know. This row used to read green under a banner saying nothing
    // could be confirmed — the team called that out on 29 September 2026, and
    // the banner was the wrong half to keep.
    severity: issuer.source === 'registry' && confirmed ? 'success' : 'unchecked',
    value:
      issuer.source === 'registry' && confirmed
        ? `${issuer.name}, found in ${issuer.registries[0] ?? 'a registry we check'}`
        : issuer.source === 'registry'
          ? `${issuer.name} is listed in ${issuer.registries[0] ?? 'a registry we check'}, but we can't confirm this credential came from them`
        : issuer.registriesUnreachable
          ? `${issuer.name} — registry unreachable, so we don't know`
          : issuer.source === 'unknown'
            ? `${issuer.name} — the registry check didn't complete, so we don't know`
          : issuer.source === 'none'
            ? 'no name given, only an identifier'
            : `${issuer.name} — name comes from the credential; not in any registry we check`,
  });

  const revocation = checks.get(CHECK.status);
  if (!hasStatusList(r)) {
    // No list at all. Nothing failed, and we cannot say it was not withdrawn
    // either — there was no way to withdraw it. Saying so is for the issuer
    // debugging their own setup, who otherwise cannot tell this apart from a
    // list that loaded and came back clean.
    rows.push({
      id: CHECK.status,
      label: 'Withdrawal',
      severity: 'unchecked',
      value: 'the issuer set up no way to withdraw this',
    });
  } else {
    rows.push({
      id: CHECK.status,
      label: 'Withdrawal',
      severity: isWithdrawn(revocation) ? 'error' : passed(revocation) ? 'success' : 'unchecked',
      value: isWithdrawn(revocation)
        ? 'withdrawn by the issuer'
        : passed(revocation)
          ? 'none by the issuer'
          : withdrawalUnavailable(revocation)
            ? "couldn't check — the issuer's list didn't load"
            : 'not checked',
    });
  }

  // 2.x has no expiration check. The validity period is enforced inside the
  // signature check, so a passing signature means the dates held, and an
  // expired credential shows up as that check failing with expiry in its
  // prose. Reading the row off the same check as the verdict is also what
  // keeps the two from disagreeing.
  const expiredNow = isExpired(r, checks);
  const expired = expiryDate(r);
  rows.push({
    id: CHECK.signature + '#dates',
    label: 'Dates',
    severity: expiredNow ? 'warning' : passed(signature) ? 'success' : 'unchecked',
    value: expiredNow
      ? expired
        ? `expired on ${expired}`
        : 'expired'
      : passed(signature)
        ? 'in date'
        : 'not checked',
  });

  // Last, because it is the least about the credential's standing and the
  // most about the issuer's setup. `no_schema` and `unavailable` are shown
  // rather than hidden for the same reason the missing withdrawal list is:
  // an issuer debugging their own badge cannot otherwise tell "nothing to
  // check against" apart from "checked and clean".
  const schema = schemaFinding(r);
  rows.push({
    id: CHECK.schema,
    label: 'How it was built',
    severity:
      schema.state === 'valid' ? 'success' : schema.state === 'invalid' ? 'warning' : 'unchecked',
    value:
      schema.state === 'valid'
        ? 'as the standard expects'
        : schema.state === 'invalid'
          ? schema.missingOnly
            ? 'missing details the standard requires'
            : "doesn't match the standard for this kind of credential"
          : schema.state === 'no_schema'
            ? 'no standard was declared to check it against'
            : "couldn't load the standard to check it against",
  });

  return rows;
};
