/**
 * Turns a verification result into what a person reads.
 *
 * Two functions, deliberately pure and free of any rendering, so the whole
 * design can be tested without a browser:
 *
 *   summarise()  — the single line the main view shows
 *   listChecks() — the per-check breakdown behind "show details"
 *
 * The rules come from requirements.md §4 and §5 and inventory.md. Four
 * severities that never grow; a message list that does.
 */

import { STEP } from './types.js';
import type {
  Severity,
  VerificationResponse,
  VerificationStep,
  UncheckedRegistry,
} from './types.js';

/** One thing we tell the person. `code` is ours, and stable. */
export interface Outcome {
  severity: Severity;
  code: string;
  headline: string;
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
  /** Named registries we could not reach. */
  unreachable: string[];
  id?: string;
}

// ---------------------------------------------------------------------------
// Reading the result safely
// ---------------------------------------------------------------------------

const stepsById = (r: VerificationResponse): Map<string, VerificationStep> => {
  const map = new Map<string, VerificationStep>();
  for (const step of r.log ?? []) {
    // The revocation step can appear twice: once as a pass/fail and once
    // carrying an error. The error-bearing one is the one that matters.
    const existing = map.get(step.id);
    if (existing?.error && !step.error) continue;
    map.set(step.id, step);
  }
  return map;
};

/**
 * Whether the credential offers a way to be withdrawn at all.
 *
 * If it doesn't, verifier-core produces no revocation step — not a failed one.
 * The absence means "the issuer provided no way to withdraw this", which is
 * not the same as "we tried and couldn't find out", and must not be shown as
 * though it were.
 */
export const hasStatusList = (r: VerificationResponse): boolean => {
  const status = r.credential?.['credentialStatus'];
  return Array.isArray(status) ? status.length > 0 : status != null;
};

/** It stopped: one error, and no per-check list to show. inventory.md Tier A. */
export const stoppedEarly = (r: VerificationResponse): boolean =>
  (r.errors?.length ?? 0) > 0 && (r.log?.length ?? 0) === 0;

/**
 * A check passed. Note the explicit `=== true`: a check that could not be
 * completed has no `valid` at all, and `!valid` would call that a failure.
 */
const passed = (step: VerificationStep | undefined): boolean => step?.valid === true;

/** A check actively failed, as opposed to not having run. */
const failed = (step: VerificationStep | undefined): boolean => step?.valid === false;

const registryNames = (step: VerificationStep | undefined): string[] =>
  (step?.matchingIssuers ?? [])
    .map((m) => m.registry?.federation_entity?.organization_name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);

const unreachableNames = (step: VerificationStep | undefined): string[] =>
  (step?.uncheckedRegistries ?? [])
    .map((u: UncheckedRegistry) => u.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);

// ---------------------------------------------------------------------------
// The issuer: a name, plus where the name came from
// ---------------------------------------------------------------------------

/**
 * requirements.md §5. The answer to "who issued it" is not yes or no. It is a
 * name and its provenance — and "not listed" and "couldn't reach the registry"
 * are different answers that look identical if you only read `valid`.
 */
export const issuerIdentity = (r: VerificationResponse): IssuerIdentity => {
  const step = stepsById(r).get(STEP.registeredIssuer);
  const nothingEstablished = stoppedEarly(r);
  const registries = registryNames(step);
  const unreachable = unreachableNames(step);

  const rawIssuer = (r.credential?.['issuer'] ?? undefined) as
    | string
    | { id?: string; name?: string }
    | undefined;
  const id = typeof rawIssuer === 'string' ? rawIssuer : rawIssuer?.id;
  const claimedName = typeof rawIssuer === 'string' ? undefined : rawIssuer?.name;

  const registryName = step?.matchingIssuers?.[0]?.issuer?.federation_entity?.organization_name;

  // If a registry recognised the issuer, say so even when it gave us no name
  // to show. Falling through to "not in any registry" here would put a green
  // verdict at the top of a card whose details deny it.
  if (passed(step)) {
    return {
      name: registryName ?? claimedName ?? id ?? 'Unknown issuer',
      source: 'registry',
      registries,
      unreachable,
      id,
    };
  }
  // A registry we could not reach means we do not know, rather than "no".
  const source: IssuerNameSource = nothingEstablished
    ? 'unverifiable'
    : unreachable.length > 0
      ? 'unknown'
      : 'credential';
  if (claimedName) return { name: claimedName, source, registries, unreachable, id };
  return {
    name: id ?? 'Unknown issuer',
    source: nothingEstablished ? 'unverifiable' : 'none',
    registries,
    unreachable,
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
export const issuerMarker = (source: IssuerNameSource): string | undefined => {
  switch (source) {
    case 'registry':
      return undefined;
    case 'unknown':
      return 'not checked';
    case 'unverifiable':
      // No per-field marker here, deliberately. When the signature is broken
      // or missing we know something is wrong and not where, so marking the
      // issuer while the title, recipient and date stand unmarked would imply
      // the rest is fine. The whole card carries one caveat instead — see
      // contentCaveat.
      return undefined;
    default:
      return 'unconfirmed';
  }
};

/**
 * Whether the finding should come before the credential.
 *
 * requirements.md §4 says the credential leads, and that is right when the
 * credential is the point. When verification stopped, the credential is
 * exactly what is in question, so the finding is the point. A deliberate
 * exception, and only for this case.
 */
export const verdictLeads = (r: VerificationResponse): boolean => stoppedEarly(r);

/**
 * One caveat for the whole of the displayed content.
 *
 * Verification stopped, so nothing shown was confirmed — and we cannot say
 * which field is wrong, only that we could not stand behind any of them. A
 * single line covering everything matches what we actually know; a marker per
 * field would claim knowledge we do not have.
 */
export const contentCaveat = (r: VerificationResponse): string | undefined =>
  stoppedEarly(r) ? "These details are what the file says. We can't confirm any of them." : undefined;

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
const isJsonLdError = (name: string): boolean => name.toLowerCase().includes('jsonld');

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
    headline: 'This credential has no signature',
    detail: "There's nothing to check. Anyone could have written it.",
    action: 'Ask the issuer for a properly signed copy.',
  },
  invalid_signature: {
    severity: 'error',
    headline: 'This has been changed since it was issued',
    detail: "We can't tell you what was changed, only that something was.",
    action: 'Ask the issuer for a fresh copy.',
  },
  // The two below mean we could not find out — not that anything is wrong.
  // Conflating them with invalid_signature is the worst mistake available.
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

/** Every way the withdrawal check fails is the issuer's setup, not a verdict. */
const REVOCATION_UNAVAILABLE = new Set([
  'status_list_not_found',
  'status_list_expired',
  'status_list_signature_error',
  'status_list_type_error',
  'status_list_not_yet_valid',
  'status_list_error',
]);

const expiryDate = (r: VerificationResponse): string | undefined => {
  const raw = r.credential?.['validUntil'] ?? r.credential?.['expirationDate'];
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
  if (stoppedEarly(r)) {
    const raw = r.errors?.[0]?.name ?? 'unknown_error';
    // Our codes are ours, and stable. An unrecognised name from the library
    // must not become one by leaking through.
    const code = Object.hasOwn(FATAL, raw)
      ? raw
      : isJsonLdError(raw)
        ? 'unreadable_vocabulary'
        : 'unknown_error';
    return { code, ...FATAL[code]! };
  }

  const steps = stepsById(r);
  const signature = steps.get(STEP.signature);
  const revocation = steps.get(STEP.revocation);
  const expiration = steps.get(STEP.expiration);
  const issuer = issuerIdentity(r);

  if (failed(signature)) {
    return { code: 'invalid_signature', ...FATAL['invalid_signature']! };
  }

  if (failed(revocation)) {
    return {
      severity: 'error',
      code: 'withdrawn',
      headline: 'The issuer has withdrawn this',
      detail: 'This is no longer a valid credential.',
      action: `A new copy must be obtained from ${issuer.name}.`,
    };
  }

  if (failed(expiration)) {
    // Name the date. How stale it is changes what someone does about it, and
    // "eight months ago" is vaguer than a date when a qualification is at
    // stake. §4's relative times are about when *we* checked, not this.
    const on = expiryDate(r);
    return {
      severity: 'warning',
      code: 'expired',
      headline: on ? `Expired on ${on}` : 'This has passed its end date',
      detail: "It's genuine and hasn't been withdrawn, but it has expired.",
      action: `Ask ${issuer.name} whether it can be renewed.`,
    };
  }

  // Everything below is "we couldn't check something", in order of how much
  // it costs the person to not know.
  const revocationError = revocation?.error?.name;
  if (revocationError && REVOCATION_UNAVAILABLE.has(revocationError)) {
    return {
      severity: 'unchecked',
      code: 'withdrawal_unknown',
      headline: "We couldn't check whether this was withdrawn",
      detail:
        "The issuer's withdrawal list didn't load. That's a problem with their setup, not with your credential.",
      action: 'Try again in a moment.',
    };
  }

  if (issuer.unreachable.length > 0) {
    const which =
      issuer.unreachable.length === 1
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

  if (!passed(steps.get(STEP.registeredIssuer))) {
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
      detail: `This credential hasn't been changed since it was issued, and the issuer hasn't withdrawn it. ${says}`,
    };
  }

  // Everything left is a pass — but only for the checks that actually
  // reported. A step missing from the log establishes nothing, and listChecks
  // shows it as "not checked"; the headline must not say otherwise.
  if (!passed(signature)) {
    return {
      severity: 'unchecked',
      code: 'signature_unchecked',
      headline: "We couldn't finish checking this",
      detail:
        "We couldn't confirm whether this has been changed since it was issued. That's a problem at our end, not with your credential.",
      action: 'Try again in a moment.',
    };
  }

  if (!passed(expiration)) {
    return {
      severity: 'unchecked',
      code: 'expiry_unchecked',
      headline: "We couldn't finish checking this",
      detail:
        "We couldn't confirm whether this is still within its dates. That's a problem at our end, not with your credential.",
      action: 'Try again in a moment.',
    };
  }

  return {
    severity: 'success',
    code: 'verified',
    headline: 'Verified',
    detail: "Nothing has changed since it was issued, and the issuer hasn't withdrawn it.",
  };
};

// ---------------------------------------------------------------------------
// The breakdown behind "show details"
// ---------------------------------------------------------------------------

export const listChecks = (r: VerificationResponse): Check[] => {
  if (stoppedEarly(r)) return [];

  const steps = stepsById(r);
  const issuer = issuerIdentity(r);
  const checks: Check[] = [];

  // Every label is the subject being checked, never a claim about it. A label
  // phrased as a statement ("Withdrawn by issuer") reads as a finding the
  // moment its value stops being a plain yes or no — and it also forces the
  // reader to flip between "yes is good" and "no is good" partway down the
  // list.
  const signature = steps.get(STEP.signature);
  checks.push({
    id: STEP.signature,
    label: 'Changes since issued',
    severity: passed(signature) ? 'success' : failed(signature) ? 'error' : 'unchecked',
    value: passed(signature)
      ? 'none'
      : failed(signature)
        ? "the signature doesn't match"
        : 'not checked',
  });

  checks.push({
    id: STEP.registeredIssuer,
    label: 'Issuer',
    severity: issuer.source === 'registry' ? 'success' : 'unchecked',
    value:
      issuer.source === 'registry'
        ? `${issuer.name}, found in ${issuer.registries[0] ?? 'a registry we check'}`
        : issuer.unreachable.length > 0
          ? `${issuer.name} — registry unreachable, so we don't know`
          : issuer.source === 'none'
            ? 'no name given, only an identifier'
            : `${issuer.name} — name comes from the credential; not in any registry we check`,
  });

  const revocation = steps.get(STEP.revocation);
  if (!hasStatusList(r)) {
    // No list at all. Nothing failed, and we cannot say it was not withdrawn
    // either — there was no way to withdraw it. Saying so is for the issuer
    // debugging their own setup, who otherwise cannot tell this apart from a
    // list that loaded and came back clean.
    checks.push({
      id: STEP.revocation,
      label: 'Withdrawal',
      severity: 'unchecked',
      value: 'the issuer set up no way to withdraw this',
    });
  } else {
    checks.push({
      id: STEP.revocation,
      label: 'Withdrawal',
      severity: failed(revocation) ? 'error' : passed(revocation) ? 'success' : 'unchecked',
      value: failed(revocation)
        ? 'withdrawn by the issuer'
        : passed(revocation)
          ? 'none by the issuer'
          : "couldn't check — the issuer's list didn't load",
    });
  }

  const expiration = steps.get(STEP.expiration);
  const expired = expiryDate(r);
  checks.push({
    id: STEP.expiration,
    label: 'Dates',
    severity: failed(expiration) ? 'warning' : passed(expiration) ? 'success' : 'unchecked',
    value: failed(expiration)
      ? expired
        ? `expired on ${expired}`
        : 'expired'
      : passed(expiration)
        ? 'in date'
        : 'not checked',
  });

  return checks;
};
