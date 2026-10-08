import { describe, it, expect } from 'vitest';
import { summarise, listChecks, stoppedEarly, hasStatusList } from '../src/outcomes.js';
import { CHECK, PROBLEM, STATUS_LIST_PROBLEM_PREFIX } from '../src/types.js';
import type { VerificationResponse, CheckResult } from '../src/types.js';

/**
 * How a verdict says the credential is unchanged, or not withdrawn — one list,
 * used by every check below, so a phrasing caught in one place is caught in
 * all of them.
 *
 * Broad on purpose: a reassurance reworded to echo the Tampering row ("no
 * tampering detected") is still a reassurance. The old "changed since it was
 * issued" phrasings stay, because a claim written the old way is still a
 * claim. "Genuine" counts unless it is asked about — "we can't tell if this is
 * genuine" is the opposite of a claim, and dropping the word instead would
 * stop this seeing "Genuine, but we can't confirm who issued it".
 */
const CLAIMS_UNCHANGED =
  /(?<!\b(?:if|whether) (?:this|it) is )\b(?:genuine|authentic)\b|n['’]t been (?:tampered|changed|altered|modified)|\bnot been (?:tampered|changed|altered|modified)|was(?:n['’]t| not) (?:tampered|changed|altered|modified)|\bun(?:tampered|altered|modified|changed)\b|\bintact\b|\bno tampering\b|\bnothing has changed/;
// The earner reads "deactivated" now (8 October 2026), so that counts too,
// however the object is put ("it", "this copy"). "Still active" counts
// unless it is asked about: "We couldn't check whether this copy is still
// active" is the opposite of a claim, as with "genuine" above.
const CLAIMS_NOT_WITHDRAWN =
  /n['’]t (?:been )?(?:withdrawn|revoked|cancelled|deactivated)\b|\bnot (?:been )?(?:withdrawn|revoked|cancelled|deactivated)\b|\bstill valid\b|(?<!whether (?:this|it|this copy) is )\bstill active\b/;

describe('the claim patterns themselves', () => {
  it.each([
    "It hasn't been tampered with, and the issuer hasn't withdrawn it.",
    "It hasn't been tampered with, and the issuer hasn't deactivated it.",
    'It has not been tampered with.',
    'No tampering detected.',
    'It was not tampered with.',
    'The credential is untampered.',
    "Genuine, but we can't confirm who issued it",
    'It looks genuine.',
    'Nothing has changed since it was issued.',
    "This credential hasn't been changed since it was issued.",
    "It hasn't been altered.",
    "It's unchanged.",
    'It is authentic.',
    'The credential is intact.',
    "It hasn't been modified since it was issued.",
  ])('reads "%s" as claiming it is unchanged', (text) => {
    expect(text.toLowerCase()).toMatch(CLAIMS_UNCHANGED);
  });

  // Every sentence the verdicts actually use that is *not* a reassurance.
  it.each([
    "We can't tell if this is genuine",
    "It's missing the issuer's digital signature — the part that proves it came from them and shows whether anyone has tampered with it.",
    'This credential has been tampered with',
    "Something in it was changed after it was issued. We can't tell what.",
    "We couldn't check it for tampering. That's a problem at our end, not with your credential.",
    'This is no longer a valid credential.',
    "This copy is no longer valid. That doesn't always mean the achievement was taken back; issuers sometimes deactivate a copy to replace it, for example to correct a detail.",
    "This copy can't be relied on while it's on hold. This may be temporary.",
    "We couldn't check whether this copy is still active",
  ])('does not read "%s" as a claim', (text) => {
    expect(text.toLowerCase()).not.toMatch(CLAIMS_UNCHANGED);
    expect(text.toLowerCase()).not.toMatch(CLAIMS_NOT_WITHDRAWN);
  });

  it.each([
    "the issuer hasn't withdrawn it",
    "the issuer hasn't deactivated it",
    "the issuer hasn't deactivated this copy",
    "It isn't deactivated.",
    'The issuer has not deactivated it.',
    'This copy is still active.',
    'It has not been withdrawn.',
    'It has not been deactivated.',
    "It hasn't been revoked.",
    "It's still valid.",
  ])(
    'reads "%s" as claiming it is not withdrawn',
    (text) => expect(text.toLowerCase()).toMatch(CLAIMS_NOT_WITHDRAWN),
  );
});

/**
 * The headline and the breakdown must never contradict each other.
 *
 * Both code reviews of this file found the same shape of bug: `summarise()`
 * saying one thing while `listChecks()` said another about the same
 * credential. Once it was a green "Verified" above rows reporting the issuer
 * was in no registry; once it was "Verified" above a signature row reading
 * "not checked". A person who opens the details and finds them disagreeing
 * with the verdict has no way to know which to believe.
 *
 * So rather than test the instances, this walks every combination of check
 * results and asserts the two can never disagree — including after both of us
 * have stopped looking at this code.
 *
 * Ported to verifier-core 2.x. The review of that migration found this file
 * switched off and the port not done, and four of its twelve findings were
 * contradictions this would have caught — most sharply a `warning` "Expired"
 * headline above an `error` row reading "withdrawn by the issuer".
 */

/**
 * The validity dates are judged inside the signature check, so the signature
 * dimension covers every way that one check can fail. Since verifier-core #58
 * and #59 each has its own problem type: tampering, expiry, a start date not
 * yet reached, and a key that isn't the issuer's. The end date stays a
 * dimension of its own, because the headline names it and must not invent an
 * expiry the library didn't report.
 */
type Sig = 'passed' | 'tampered' | 'expired' | 'not_yet_valid' | 'key_mismatch' | 'unattributable' | 'missing';
/**
 * `unreadable`: a status type the library does not recognise, so it skips.
 * `+other`: the list loaded and was read, but the issuer didn't sign it — the
 * status check's own result is untouched, and a second check reports it.
 * verifier-core's main reports that only for a list that passed; after a mark
 * the second check is "Not run". `revoked+other` and `suspended+other` are
 * here for when it does, so the rules are ready rather than merely untested.
 */
type Rev =
  | 'passed'
  | 'revoked'
  | 'suspended'
  | 'passed+other'
  | 'revoked+other'
  | 'suspended+other'
  | 'list_error'
  | 'none'
  | 'unreadable'
  | 'halted';
type End = 'in_date' | 'past';
/**
 * `errored` and `skipped` are the cases the 2.x migration got wrong: a lookup
 * that threw, or never ran, is not a confirmed "not in any registry".
 */
type Iss = 'matched' | 'unlisted' | 'unreachable' | 'matched+unreachable' | 'errored' | 'skipped' | 'halted';
type Sch = 'valid' | 'invalid' | 'no_schema' | 'unavailable' | 'missing' | 'halted';
/**
 * `halted`: skipped because an earlier check failed fatally. verifier-core
 * stops after a fatal failure, and the signature check is fatal for expiry
 * too, so after it none of these run.
 */
const NOT_RUN = 'Not run: proof.signature failed';

const SIGNATURES: Sig[] = ['passed', 'tampered', 'expired', 'not_yet_valid', 'key_mismatch', 'unattributable', 'missing'];
const REVOCATIONS: Rev[] = [
  'passed',
  'revoked',
  'suspended',
  'passed+other',
  'revoked+other',
  'suspended+other',
  'list_error',
  'none',
  'unreadable',
  'halted',
];
const ENDS: End[] = ['in_date', 'past'];
const ISSUERS: Iss[] = [
  'matched',
  'unlisted',
  'unreachable',
  'matched+unreachable',
  'errored',
  'skipped',
  'halted',
];
const SCHEMAS: Sch[] = ['valid', 'invalid', 'no_schema', 'unavailable', 'missing', 'halted'];

const check = (id: string, outcome: CheckResult['outcome'], fatal = false): CheckResult => ({
  id,
  // The deprecated pair, carried so the shape matches what the library emits.
  check: id.split('.').slice(-1)[0]!,
  suite: id.split('.').slice(1, 2)[0]!,
  outcome,
  fatal,
});

const PAST = '2026-01-09T10:00:00Z';
const FUTURE = '2099-01-09T10:00:00Z';

const signatureCheck = (sig: Sig): CheckResult | undefined => {
  switch (sig) {
    case 'missing':
      return undefined;
    case 'passed':
      return check(CHECK.signature, { status: 'success', message: 'Signature verified.' }, true);
    case 'tampered':
      return check(
        CHECK.signature,
        {
          status: 'failure',
          problems: [
            { type: PROBLEM.invalidSignature, title: 'Invalid Signature', detail: 'Invalid signature.' },
          ],
        },
        true,
      );
    case 'expired':
      return check(
        CHECK.signature,
        {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.credentialExpired,
              title: 'Credential Expired',
              detail: `The current date time (2026-09-23T00:00:00Z) is after "validUntil" (${PAST}).`,
            },
          ],
        },
        true,
      );
    case 'not_yet_valid':
      return check(
        CHECK.signature,
        {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.credentialNotYetValid,
              title: 'Credential Not Yet Valid',
              detail: `The current date time (2026-09-23T00:00:00Z) is before "validFrom" (${FUTURE}).`,
            },
          ],
        },
        true,
      );
    case 'key_mismatch':
      return check(
        CHECK.signature,
        {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.verificationMethod,
              title: 'Verification Method Error',
              detail: 'The credential issuer did:key:z6Mkn does not control the verification method.',
            },
          ],
        },
        true,
      );
    case 'unattributable':
      return check(
        CHECK.signature,
        {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.proofVerification,
              title: 'No Applicable Crypto Service',
              detail: 'No registered crypto service can verify this subject.',
            },
          ],
        },
        true,
      );
  }
};

const revocationCheck = (rev: Rev): CheckResult | undefined => {
  switch (rev) {
    case 'passed+other':
      return revocationCheck('passed');
    case 'revoked+other':
      return revocationCheck('revoked');
    case 'suspended+other':
      return revocationCheck('suspended');
    case 'halted':
      return check(CHECK.status, { status: 'skipped', reason: NOT_RUN });
    case 'suspended':
      return check(CHECK.status, {
        status: 'failure',
        problems: [
          { type: PROBLEM.suspended, title: 'Credential Suspended', detail: 'The credential has been suspended.' },
        ],
      });
    case 'none':
      return check(CHECK.status, {
        status: 'skipped',
        reason: 'Credential has no credentialStatus.',
      });
    case 'unreadable':
      return check(CHECK.status, {
        status: 'skipped',
        reason: 'Status type "StatusList2021Entry" is not BitstringStatusListEntry.',
      });
    case 'passed':
      return check(CHECK.status, {
        status: 'success',
        message: 'Credential status is valid (not revoked or suspended).',
      });
    case 'revoked':
      return check(CHECK.status, {
        status: 'failure',
        problems: [
          {
            type: PROBLEM.revoked,
            title: 'Credential Revoked',
            detail: 'The credential has been revoked.',
          },
        ],
      });
    case 'list_error':
      return check(CHECK.status, {
        status: 'failure',
        problems: [
          {
            type: `${STATUS_LIST_PROBLEM_PREFIX}NOT_FOUND`,
            title: 'Status List Not Found',
            detail: 'The status list could not be fetched.',
          },
        ],
      });
  }
};

const registryCheck = (iss: Iss): CheckResult | undefined => {
  const unchecked = '1 registries could not be checked: Second Registry';
  switch (iss) {
    case 'halted':
      return check(CHECK.registeredIssuer, { status: 'skipped', reason: NOT_RUN });
    case 'skipped':
      return check(CHECK.registeredIssuer, {
        status: 'skipped',
        reason: 'No registries configured in verification context.',
      });
    case 'matched':
      return check(CHECK.registeredIssuer, {
        status: 'success',
        message: 'Issuer found in registry: DCC Registry',
      });
    case 'matched+unreachable':
      return check(CHECK.registeredIssuer, {
        status: 'success',
        message: `Issuer found in registry: DCC Registry. ${unchecked}`,
      });
    case 'unlisted':
      return check(CHECK.registeredIssuer, {
        status: 'failure',
        problems: [
          {
            type: PROBLEM.issuerNotRegistered,
            title: 'Issuer Not Registered',
            detail: 'Issuer did:key:z6Mkn was not found in any known DID registry.',
          },
        ],
      });
    case 'unreachable':
      return check(CHECK.registeredIssuer, {
        status: 'failure',
        problems: [
          {
            type: PROBLEM.issuerNotRegistered,
            title: 'Issuer Not Registered',
            detail: 'Issuer did:key:z6Mkn was not found in any known DID registry.',
          },
          { type: PROBLEM.registryUnchecked, title: 'Registry Unchecked', detail: unchecked },
        ],
      });
    case 'errored':
      return check(CHECK.registeredIssuer, {
        status: 'failure',
        problems: [
          {
            type: 'https://www.w3.org/TR/vc-data-model#REGISTRY_ERROR',
            title: 'Registry Error',
            detail: 'Registry lookup failed.',
          },
        ],
      });
  }
};

const schemaCheck = (sch: Sch): CheckResult | undefined => {
  switch (sch) {
    case 'halted':
      return check(CHECK.schema, { status: 'skipped', reason: NOT_RUN });
    case 'missing':
      return undefined;
    case 'valid':
      return check(CHECK.schema, { status: 'success', message: 'Schema validation passed.' });
    case 'invalid':
      return check(CHECK.schema, {
        status: 'failure',
        problems: [
          {
            type: PROBLEM.schemaValidationFailed,
            title: 'Schema Validation Failed',
            detail:
              "Schema validation failed for https://purl.imsglobal.org/x.json: /credentialSubject/achievement: must have required property 'id'",
          },
        ],
      });
    case 'no_schema':
      return check(CHECK.schema, {
        status: 'skipped',
        reason:
          'Credential does not appear to be an OBv3 credential (OpenBadgeCredential or EndorsementCredential).',
      });
    case 'unavailable':
      return check(CHECK.schema, {
        status: 'skipped',
        reason: 'No verifiable credential found in subject.',
      });
  }
};

const build = (sig: Sig, rev: Rev, end: End, iss: Iss, sch: Sch): VerificationResponse => {
  const results = [
    // The four core checks pass throughout: a failure among them is
    // "it stopped", which has its own describe block below.
    check(CHECK.contextExists, { status: 'success', message: 'ok' }, true),
    check(CHECK.vcContext, { status: 'success', message: 'ok' }, true),
    check(CHECK.credentialId, { status: 'success', message: 'ok' }, true),
    check(CHECK.proofExists, { status: 'success', message: 'ok' }, true),
    signatureCheck(sig),
    revocationCheck(rev),
    rev.endsWith('+other')
      ? check(CHECK.statusListIssuer, {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.statusListIssuerMismatch,
              title: 'Status List Issuer Mismatch',
              detail: 'The status list was issued by did:key:z6Mkother, not the credential issuer did:key:z6Mkn.',
            },
          ],
        })
      : undefined,
    registryCheck(iss),
    schemaCheck(sch),
  ].filter((c): c is CheckResult => c !== undefined);

  return {
    verified: results.every((c) => c.outcome.status !== 'failure'),
    verifiableCredential: {
      issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' },
      validUntil: end === 'past' ? PAST : FUTURE,
      validFrom: sig === 'not_yet_valid' ? FUTURE : '2025-01-09T10:00:00Z',
      // "none" means the issuer never set up a way to withdraw it at all.
      ...(rev === 'none' ? {} : { credentialStatus: { type: 'BitstringStatusListEntry' } }),
    },
    results,
  };
};

/**
 * Whether the host said it couldn't get its list of registries. Every
 * combination runs both ways: the flag only matters to a lookup that never
 * answered, and must not open a contradiction anywhere else either.
 */
const HOST_LIST: ('loaded' | 'unavailable')[] = ['loaded', 'unavailable'];

/**
 * A check is only ever skipped as "not run" because one before it failed
 * fatally: the signature for everything after it, the withdrawal check for
 * the issuer lookup and the schema. A `halted` check with nothing failed
 * ahead of it is a contradiction in the input, not a combination the rules
 * owe an answer to, so it is left out — everything else, possible or not,
 * stays in.
 */
const SIG_FATAL: Sig[] = ['tampered', 'expired', 'not_yet_valid', 'key_mismatch', 'unattributable'];
const REV_FATAL: Rev[] = ['revoked', 'suspended', 'revoked+other', 'suspended+other', 'list_error'];
const coherent = (sig: Sig, rev: Rev, iss: Iss, sch: Sch): boolean => {
  const before = SIG_FATAL.includes(sig);
  if (rev === 'halted' && !before) return false;
  const beforeLater = before || REV_FATAL.includes(rev);
  return (iss !== 'halted' && sch !== 'halted') || beforeLater;
};

const cases = SIGNATURES.flatMap((sig) =>
  REVOCATIONS.flatMap((rev) =>
    ENDS.flatMap((end) =>
      ISSUERS.flatMap((iss) =>
        SCHEMAS.filter((sch) => coherent(sig, rev, iss, sch)).flatMap((sch) =>
          HOST_LIST.map((list) => ({ sig, rev, end, iss, sch, list, name: `${sig}/${rev}/${end}/${iss}/${sch}/${list}` })),
        ),
      ),
    ),
  ),
);

const DATES_ROW = `${CHECK.signature}#dates`;

describe(`the headline and the breakdown agree (${cases.length} combinations)`, () => {
  it.each(cases)('$name', ({ sig, rev, end, iss, sch, list }) => {
    const r = build(sig, rev, end, iss, sch);
    const options = { registriesUnavailable: list === 'unavailable' };
    const out = summarise(r, options);
    const rows = listChecks(r, options);
    const row = (id: string) => rows.find((c) => c.id === id);
    const where = `${sig}/${rev}/${end}/${iss}/${sch}/${list} → ${out.code}`;

    expect(rows.length, `${where}: verification ran, so there must be rows`).toBeGreaterThan(0);

    // A clean verdict cannot sit above a row reporting a problem.
    if (out.severity === 'success') {
      for (const c of rows) {
        // Two agreed exceptions, and they are the same exception twice:
        // nothing failed and there was nothing to try, so the row carries no
        // information while the verdict is still a pass. Both stay visible
        // for an issuer debugging their own badge, who otherwise cannot tell
        // "nothing to check against" apart from "checked and clean".
        const noWithdrawalList = c.id === CHECK.status && !hasStatusList(r);
        // Unlike the signature, the schema check never establishes that the
        // credential is authentic — it only reports how it was assembled. Not
        // having one therefore does not undermine a pass the way an unchecked
        // signature would, and must not drag the headline down to "we
        // couldn't finish checking this".
        const noSchemaToCheck = c.id === CHECK.schema && sch !== 'valid';
        if (noWithdrawalList || noSchemaToCheck) {
          expect(c.severity, `${where}: "${c.label}" under a pass`).toBe('unchecked');
          continue;
        }
        expect(c.severity, `${where}: "${c.label}" is ${c.severity} under a pass`).toBe('success');
      }
    }

    // ...and a row reporting a problem cannot sit under a clean verdict.
    const worst = rows.map((c) => c.severity);
    if (worst.includes('error')) {
      expect(out.severity, `${where}: a row is an error`).toBe('error');
    }
    if (out.severity === 'error') {
      expect(worst, `${where}: an error verdict needs an error row`).toContain('error');
    }
    if (out.severity === 'warning') {
      expect(worst, `${where}: a warning verdict needs a warning row`).toContain('warning');
    }
    // A row must never report something more serious than the headline.
    // "We couldn't check whether this was withdrawn" sitting above a row
    // that says the credential was built wrong buries a definite finding
    // under an unknown — the same bug as a pass above a problem, one tier
    // down, and the tier the schema row newly made reachable.
    if (out.severity === 'unchecked') {
      expect(worst, `${where}: a warning row under an unchecked verdict`).not.toContain('warning');
    }

    // A verdict must not claim in prose what the breakdown says was never
    // checked. This is the one contradiction severities cannot see: both
    // sides read "unchecked" and agree perfectly, while the sentence above
    // them asserts the credential is genuine. Three separate bugs have now
    // been this same sentence, so the rule is written once, for the claim,
    // rather than a third time for the instance.
    const claims = `${out.headline} ${out.detail}`.toLowerCase();

    // The earner never reads a registry's name, or the word: to them it is
    // "our list of known issuers" (James, 1 October 2026). Every verdict and
    // every row, in every combination.
    const earnerProse = [out.headline, out.detail, out.action ?? '', ...rows.map((c) => c.value)].join(' ');
    expect(earnerProse, `${where}: names a registry to the earner`).not.toMatch(/registry|registries/i);

    // When the verdict blames the list, the Issuer row has to be about the
    // list too — not the seal. Both read "unchecked", so severities can't see
    // the two giving different reasons.
    if (out.code === 'registry_unreachable') {
      expect(row(CHECK.registeredIssuer)?.value, `${where}: the verdict blames the list, the row doesn't`).toContain(
        'list of known issuers',
      );
      // ...and for the same reason. "Didn't load" above "couldn't finish
      // checking" gives two accounts of one failure, and a host that says its
      // list was unavailable made that pairing reachable from a second route.
      const loaded = /didn't load/.test(out.detail);
      expect(row(CHECK.registeredIssuer)?.value, `${where}: the verdict and the row give different reasons`).toContain(
        loaded ? "couldn't load our list" : "couldn't finish checking",
      );
    }

    if (CLAIMS_UNCHANGED.test(claims)) {
      expect(
        row(CHECK.signature)?.severity,
        `${where}: claims the credential is unchanged, but the signature row says "${row(CHECK.signature)?.value}"`,
      ).toBe('success');
    }

    if (CLAIMS_NOT_WITHDRAWN.test(claims)) {
      const revRow = row(CHECK.status)!;
      expect(
        revRow.severity === 'success',
        `${where}: claims it was not deactivated, but the row says "${revRow.value}"`,
      ).toBe(true);
    }

    // A check that never ran says so, and gives no other reason: not "the
    // list didn't load", not "couldn't load the standard". Severities can't
    // see this — both read "unchecked". The one exception is the Issuer row
    // when the seal failed, which talks about the seal instead (James, 1
    // October 2026): that is the reason, and it outranks the lookup.
    const haltedRows = [
      rev === 'halted' && CHECK.status,
      iss === 'halted' && CHECK.registeredIssuer,
      sch === 'halted' && CHECK.schema,
    ].filter((id): id is string => typeof id === 'string');
    for (const id of haltedRows) {
      const value = row(id)?.value ?? '';
      const aboutTheSeal = id === CHECK.registeredIssuer && value.startsWith("can't confirm — ");
      expect(aboutTheSeal || /(^|— )not checked$/.test(value), `${where}: "${row(id)?.label}" never ran, but reads "${value}"`).toBe(true);
    }

    // Each verdict must be borne out by the row it is about.
    const expectations: Record<string, [string, string] | undefined> = {
      verified: [CHECK.signature, 'success'],
      invalid_signature: [CHECK.signature, 'error'],
      signature_unchecked: [CHECK.signature, 'unchecked'],
      did_web_unresolved: [CHECK.signature, 'unchecked'],
      http_error_with_signature_check: [CHECK.signature, 'unchecked'],
      withdrawn: [CHECK.status, 'error'],
      suspended: [CHECK.status, 'error'],
      withdrawal_unknown: [CHECK.status, 'unchecked'],
      expired: [DATES_ROW, 'warning'],
      not_yet_valid: [DATES_ROW, 'warning'],
      key_mismatch: [CHECK.registeredIssuer, 'error'],
      malformed: [CHECK.schema, 'warning'],
    };
    const expected = expectations[out.code];
    if (expected) {
      const [id, severity] = expected;
      expect(row(id)?.severity, `${where}: "${row(id)?.label}" must agree`).toBe(severity);
    }

    // The issuer verdicts must never sit above a row claiming a registry match.
    if (out.code === 'issuer_unconfirmed' || out.code === 'registry_unreachable') {
      expect(row(CHECK.registeredIssuer)?.severity, `${where}: issuer row`).not.toBe('success');
    }

    // Every verdict that is not a pass names one thing to do, except the
    // unconfirmed-issuer case, where §5 deliberately gives no instruction
    // because nothing is wrong and there is nothing to fix.
    if (out.severity !== 'success' && out.code !== 'issuer_unconfirmed') {
      expect(out.action, `${where}: no action offered`).toBeTruthy();
    }
  });
});

describe('a credential that is both withdrawn and expired', () => {
  // The contradiction the 2.x migration introduced and this file exists to
  // catch: expiry moved ahead of withdrawal, so the headline was a warning
  // about renewal while the breakdown reported an error.
  it('reports the withdrawal, because the issuer has already decided', () => {
    const r = build('expired', 'revoked', 'past', 'matched', 'valid');
    const out = summarise(r);
    expect(out.code).toBe('withdrawn');
    expect(out.severity).toBe('error');
    expect(out.action).toContain('current copy');
  });
});

describe('verification that stopped early', () => {
  // 2.x has no "it stopped" shape of its own — every suite runs and reports —
  // so the equivalent is a failure among the four core checks.
  const FATAL: Array<[string, string, string]> = [
    [CHECK.contextExists, 'Invalid JSON-LD', 'unreadable_vocabulary'],
    [CHECK.contextExists, 'Missing Context', 'invalid_jsonld'],
    [CHECK.vcContext, 'Not a Verifiable Credential', 'no_vc_context'],
    [CHECK.vcStructure, 'Invalid Credential Structure', 'invalid_structure'],
    [CHECK.credentialId, 'Invalid Credential Id', 'invalid_credential_id'],
    [CHECK.proofExists, 'No Proof', 'no_proof'],
  ];

  it.each(FATAL)('%s / %s reports no rows, and says so consistently', (id, title, code) => {
    const r: VerificationResponse = {
      verified: false,
      verifiableCredential: { issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' } },
      results: [
        check(
          id,
          {
            status: 'failure',
            problems: [
              { type: PROBLEM.proofVerification, title, detail: `${title} in this credential.` },
            ],
          },
          true,
        ),
      ],
    };
    expect(stoppedEarly(r)).toBe(true);
    // Nothing else ran, so there is no breakdown to show. A display that
    // assumes a list always comes back breaks here.
    expect(listChecks(r)).toEqual([]);

    const out = summarise(r);
    expect(out.code, 'the core check that failed names the outcome').toBe(code);
    expect(out.headline).toBeTruthy();
    expect(out.detail).toBeTruthy();
    expect(out.action, `${code} offers no action`).toBeTruthy();
    expect(['error', 'unchecked']).toContain(out.severity);
    // With no breakdown, the claim check above has no rows to hold the prose
    // to, so hold it to nothing: a verdict that stopped here cannot reassure.
    const claims = `${out.headline} ${out.detail}`.toLowerCase();
    expect(claims, `${code} reassures with nothing behind it`).not.toMatch(CLAIMS_UNCHANGED);
    expect(claims, `${code} reassures with nothing behind it`).not.toMatch(CLAIMS_NOT_WITHDRAWN);
  });
});
