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
 * PROVISIONAL, and the only place in this codebase that reads problem prose.
 *
 * verifier-core 2.x has no expiration check. An expired credential fails the
 * *signature* check, with the same problem type and title as a credential that
 * was altered after issue — `INVALID_SIGNATURE` / "Invalid Signature". The
 * only thing separating "your qualification ran out in January" from "someone
 * changed this" is the sentence in `detail`.
 *
 * Telling someone their credential was tampered with when it merely expired is
 * the worst wrong answer this component can give, so we match the sentence.
 *
 * Two things make that safe enough to ship:
 *
 * - the fallback is `unchecked`, not `invalid_signature`. If these strings
 *   stop matching, an expired credential degrades to "we couldn't finish
 *   checking this" — honest — rather than to an accusation. Tampering is
 *   matched on its own marker rather than inherited by default.
 * - `test/expiry-marker.test.ts` runs the real library over the real expired
 *   fixture and fails if the wording moves, so the breakage is loud.
 *
 * Remove all of this the moment verifier-core carries a distinct problem type.
 * Raised on verifier-core#32.
 */
export const EXPIRED_MARKERS = ['is after "validUntil"'] as const;
export const NOT_YET_VALID_MARKERS = ['is before "validFrom"'] as const;
/** What the library says when the signature itself did not verify. */
export const TAMPERED_MARKERS = ['Verification error'] as const;
