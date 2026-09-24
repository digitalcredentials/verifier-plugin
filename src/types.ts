/**
 * The shapes verifier-core 2.x actually returns at runtime.
 *
 * Still written from the running library rather than imported from its type
 * declarations, for the same reason as before 2.x: what we render has to match
 * what arrives. The 1.x mismatch these notes used to describe (declarations
 * naming `foundInRegistries` while the code attached `matchingIssuers`) is
 * gone, but the habit is worth keeping — every id and problem type below was
 * read off real output from our own fixtures, not off a `.d.ts`.
 *
 * What 2.x gives us that we used to build by hand:
 *
 * - `skipped` carries a reason, so "there was nothing to check" stops being an
 *   inference from an absent step.
 * - `fatal` is a flag on the check rather than a guess from position.
 * - check ids are namespaced, so two suites can own a check of the same name.
 */

/** The four severities. This set does not grow; the message list does. */
export type Severity = 'success' | 'warning' | 'error' | 'unchecked';

/**
 * One problem, in RFC 9457 shape.
 *
 * `type` is the stable part and the only part worth branching on. `detail` is
 * prose meant for a developer, and we read it in exactly one place — see
 * EXPIRED_MARKERS below, and the comment explaining why that is a deliberate
 * exception rather than a pattern.
 */
export interface ProblemDetail {
  type: string;
  title: string;
  detail?: string;
  instance?: string;
}

/**
 * The three ways a check can end.
 *
 * The tagged shape is the whole reason the reading layer got smaller: in 1.x a
 * check that could not be completed carried an error and simply had no `valid`
 * field, so every read had to spell `=== true` to avoid turning "we couldn't
 * check" into "this failed". Here the three cases cannot be confused.
 */
export type CheckOutcome =
  | { status: 'success'; message: string; payload?: unknown }
  | { status: 'failure'; problems: ProblemDetail[] }
  | { status: 'skipped'; reason: string };

export interface CheckResult {
  /**
   * `<phase>.<suite>.<localPart>`. Optional in the library's declarations for
   * backwards compatibility with hand-built literals, so the fallback below is
   * not defensive padding — `id` really can be absent.
   */
  id?: string;
  /** @deprecated by the library in favour of `id`; still the fallback. */
  check: string;
  /** @deprecated by the library in favour of `id`; still the fallback. */
  suite: string;
  outcome: CheckOutcome;
  /** Set when the check was marked fatal in its suite definition. */
  fatal?: boolean;
}

/**
 * Per-suite rollup. Always present, whatever `verbose` is set to.
 *
 * We do not read it for the verdict, and the reason is worth recording: its
 * `counts` are per suite, not per check, so in any suite with more than one
 * check it cannot tell you *which* check passed. That is precisely the
 * distinction this component exists to get right, so the verdict is built from
 * `results[]` with `verbose: true` instead. See verify.ts.
 */
export interface SuiteSummary {
  id: string;
  phase: string;
  suite: string;
  status: 'success' | 'failure' | 'skipped' | 'mixed';
  verified: boolean;
  message: string;
  counts: { passed: number; failed: number; skipped: number };
  fatalFailureAt?: string;
}

/** What `verifyCredential` hands back for a single credential. */
export interface VerificationResponse {
  verified: boolean;
  verifiableCredential?: Record<string, unknown>;
  normalizedVerifiableCredential?: unknown;
  recognizedProfile?: string;
  results?: CheckResult[];
  summary?: SuiteSummary[];
  partial?: boolean;
}

/**
 * Check ids, read from real output rather than from the library's constants —
 * the library does not export them, and the last segment is assembled by the
 * suite that owns it.
 *
 * `schema` looks wrong and is not: the suite is `openbadges.schema` and the
 * check inside it is `schema.obv3.json`, so the word repeats when the two are
 * joined. Reproduced here exactly as it arrives.
 */
export const CHECK = {
  /** A document that could not be parsed as a credential at all. */
  envelope: 'cryptographic.parsing.envelope',
  contextExists: 'cryptographic.core.context-exists',
  vcContext: 'cryptographic.core.vc-context',
  credentialId: 'cryptographic.core.credential-id',
  proofExists: 'cryptographic.core.proof-exists',
  signature: 'cryptographic.proof.signature',
  status: 'cryptographic.status.bitstring',
  registeredIssuer: 'trust.registry.issuer',
  recognition: 'recognition.profile',
  schema: 'semantic.openbadges.schema.schema.obv3.json',
} as const;

/** Problem types we branch on. Everything else falls through to a default. */
export const PROBLEM = {
  invalidSignature: 'https://www.w3.org/TR/vc-data-model#INVALID_SIGNATURE',
  proofVerification: 'https://www.w3.org/TR/vc-data-model#PROOF_VERIFICATION_ERROR',
  issuerNotRegistered: 'https://www.w3.org/TR/vc-data-model#ISSUER_NOT_REGISTERED',
  registryUnchecked: 'https://www.w3.org/TR/vc-data-model#REGISTRY_UNCHECKED',
  schemaValidationFailed: 'https://www.w3.org/TR/vc-data-model#SCHEMA_VALIDATION_FAILED',
  /** The status list said so. The only thing that means "withdrawn". */
  revoked: 'https://www.w3.org/TR/vc-data-model#CREDENTIAL_REVOKED_OR_SUSPENDED',
} as const;

/**
 * Every way the withdrawal check can fail *without* establishing a withdrawal:
 * the list would not load, had expired, was not yet valid, did not verify, was
 * the wrong type, or errored before reaching a verdict.
 *
 * 1.x reported all of this as one undifferentiated error, and we had to treat
 * any failure as unknown to stay honest. 2.x names them, so the prefix is
 * enough — and the default for an unrecognised `STATUS_LIST_*` type is still
 * "we could not check", which is the safe direction.
 */
export const STATUS_LIST_PROBLEM_PREFIX =
  'https://www.w3.org/TR/vc-data-model#STATUS_LIST_';

/**
 * Markers in problem prose. Corroborating signals only — never the sole basis
 * for what we tell someone.
 *
 * verifier-core 2.x has no expiration check. An expired credential fails the
 * *signature* check carrying the same problem type and title as one altered
 * after issue — `INVALID_SIGNATURE` / "Invalid Signature" — so the two are
 * separated only by the sentence in `detail`.
 *
 * Rather than trust that sentence, `summarise()` confirms expiry against the
 * credential's own `validUntil` / `expirationDate`, which we hold and can
 * check ourselves. The marker below is a second route to the same conclusion,
 * kept because it also covers a credential whose date we failed to parse.
 *
 * Tampering is matched on its own marker and never inherited by default, so a
 * wording change upstream sends an unattributable signature failure to "we
 * couldn't finish checking this" rather than to an accusation.
 *
 * `test/expiry.test.ts` pins both against the real library and the real
 * fixtures, so a change in wording fails loudly instead of silently.
 *
 * Remove when verifier-core carries a distinct problem type. Raised on
 * verifier-core#32.
 */
export const EXPIRED_MARKERS = ['is after "validUntil"', 'has expired'] as const;
/** What the library says when the signature itself did not verify. */
export const TAMPERED_MARKERS = ['Verification error'] as const;

/**
 * How the registry check reports what it found — in prose, on both paths.
 *
 * Success: `Issuer found in registry: A`, or `Issuer found in 2 registries:
 * A, B`, optionally followed by `. 1 registries could not be checked: C`.
 * Failure: an ISSUER_NOT_REGISTERED problem, plus a REGISTRY_UNCHECKED one
 * carrying the same "could not be checked" sentence.
 *
 * None of it arrives as data — the success outcome has no payload at all —
 * so rendering §5 means reading these sentences. Raised on verifier-core#32;
 * `RegistryLookupResult` on the payload would retire all of this.
 */
export const REGISTRY_FOUND =
  /Issuer found in (?:\d+ )?registr(?:y|ies): (.+?)(?=\. \d+ registries could not be checked:|$)/;
export const REGISTRY_UNCHECKED = /\d+ registries could not be checked: (.+)$/;

/**
 * The three structural failures `context-check` reports, all under the title
 * "Invalid JSON-LD" — so the title cannot tell a missing `@context` apart from
 * vocabulary the processor could not read. These say the credential is put
 * together wrong; anything else carrying json-ld in its prose is the
 * processing failure, which has different advice because retrying cannot fix
 * it. Raised on verifier-core#32.
 */
export const STRUCTURAL_CONTEXT_DETAILS = [
  'No verifiable credential found in subject.',
  'Credential is missing required @context property.',
  'Credential @context property is empty.',
] as const;
