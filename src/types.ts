/**
 * The shapes verifier-core actually returns at runtime.
 *
 * Deliberately not imported from the package's own type declarations. Those
 * declarations disagree with the running code about the registry results —
 * they name them `foundInRegistries` / `registriesNotLoaded` and type the
 * first as a list of strings, while the code attaches `matchingIssuers` /
 * `uncheckedRegistries` and makes the first a list of objects. Anything typed
 * against the declarations reads `undefined`.
 *
 * Open question 4 for Nate. Until it is settled, these describe what the
 * library does, which is what we have to render.
 */

/** The four severities. This set does not grow; the message list does. */
export type Severity = 'success' | 'warning' | 'error' | 'unchecked';

export interface VerificationError {
  name?: string;
  message: string;
  details?: object;
  stackTrace?: unknown;
}

/** An issuer as a registry describes it. */
export interface RegistryIssuer {
  federation_entity?: {
    organization_name?: string;
    homepage_uri?: string;
    location?: string;
  };
}

export interface MatchingIssuer {
  issuer?: RegistryIssuer;
  registry?: {
    type?: string;
    federation_entity?: { organization_name?: string };
    institution_additional_information?: { legacy_list?: string };
  };
}

export interface UncheckedRegistry {
  name: string;
  url?: string;
  type?: string;
}

/**
 * One check. Note `valid` is optional: when a check could not be completed it
 * carries an `error` and no `valid` at all. Treating a missing `valid` as
 * false turns "we couldn't check" into "this failed".
 */
export interface VerificationStep {
  id: string;
  valid?: boolean;
  error?: VerificationError;
  matchingIssuers?: MatchingIssuer[];
  uncheckedRegistries?: UncheckedRegistry[];
}

export interface SchemaCheck {
  schema: string;
  result: { valid: boolean; errors?: object[] };
  source: string;
}

export interface AdditionalInformationEntry {
  id: string;
  results: SchemaCheck[];
}

/**
 * Two shapes in one type, and the difference drives the whole display:
 *
 * - it stopped: `errors` is present and `log` is not. There is no per-check
 *   list, because nothing else ran.
 * - it ran: `log` holds the checks.
 */
export interface VerificationResponse {
  credential?: Record<string, unknown>;
  errors?: VerificationError[];
  log?: VerificationStep[];
  additionalInformation?: AdditionalInformationEntry[];
}

/** Step ids, from verifier-core's own constants. */
export const STEP = {
  signature: 'valid_signature',
  revocation: 'revocation_status',
  expiration: 'expiration',
  registeredIssuer: 'registered_issuer',
} as const;
