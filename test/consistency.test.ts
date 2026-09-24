import { describe, it, expect } from 'vitest';
import { summarise, listChecks, stoppedEarly, hasStatusList } from '../src/outcomes.js';
import { CHECK, PROBLEM, STATUS_LIST_PROBLEM_PREFIX } from '../src/types.js';
import type { VerificationResponse, CheckResult } from '../src/types.js';

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
 * 2.x has no expiration check: expiry arrives as a *signature* failure
 * carrying the same problem type and title as tampering. So the signature
 * dimension now covers the ways that one check can fail, and the credential's
 * own end date is a dimension of its own — `summarise()` reads the date
 * rather than trusting the prose, and both have to agree with the rows.
 */
type Sig = 'passed' | 'tampered' | 'expired' | 'unattributable' | 'missing';
/** `unreadable`: a status type the library does not recognise, so it skips. */
type Rev = 'passed' | 'revoked' | 'list_error' | 'none' | 'unreadable';
type End = 'in_date' | 'past';
/**
 * `errored` and `skipped` are the cases the 2.x migration got wrong: a lookup
 * that threw, or never ran, is not a confirmed "not in any registry".
 */
type Iss = 'matched' | 'unlisted' | 'unreachable' | 'matched+unreachable' | 'errored' | 'skipped';
type Sch = 'valid' | 'invalid' | 'no_schema' | 'unavailable' | 'missing';

const SIGNATURES: Sig[] = ['passed', 'tampered', 'expired', 'unattributable', 'missing'];
const REVOCATIONS: Rev[] = ['passed', 'revoked', 'list_error', 'none', 'unreadable'];
const ENDS: End[] = ['in_date', 'past'];
const ISSUERS: Iss[] = [
  'matched',
  'unlisted',
  'unreachable',
  'matched+unreachable',
  'errored',
  'skipped',
];
const SCHEMAS: Sch[] = ['valid', 'invalid', 'no_schema', 'unavailable', 'missing'];

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
            {
              type: PROBLEM.invalidSignature,
              title: 'Invalid Signature',
              detail: 'Verification error(s).',
            },
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
              type: PROBLEM.invalidSignature,
              title: 'Invalid Signature',
              // Same type and title as tampering. Only this sentence differs.
              detail: `The current date time (2026-09-23T00:00:00Z) is after "validUntil" (${PAST}).`,
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
            title: 'Credential Revoked or Suspended',
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
    registryCheck(iss),
    schemaCheck(sch),
  ].filter((c): c is CheckResult => c !== undefined);

  return {
    verified: results.every((c) => c.outcome.status !== 'failure'),
    verifiableCredential: {
      issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' },
      validUntil: end === 'past' ? PAST : FUTURE,
      // "none" means the issuer never set up a way to withdraw it at all.
      ...(rev === 'none' ? {} : { credentialStatus: { type: 'BitstringStatusListEntry' } }),
    },
    results,
  };
};

const cases = SIGNATURES.flatMap((sig) =>
  REVOCATIONS.flatMap((rev) =>
    ENDS.flatMap((end) =>
      ISSUERS.flatMap((iss) =>
        SCHEMAS.map((sch) => ({ sig, rev, end, iss, sch, name: `${sig}/${rev}/${end}/${iss}/${sch}` })),
      ),
    ),
  ),
);

const DATES_ROW = `${CHECK.signature}#dates`;

describe(`the headline and the breakdown agree (${cases.length} combinations)`, () => {
  it.each(cases)('$name', ({ sig, rev, end, iss, sch }) => {
    const r = build(sig, rev, end, iss, sch);
    const out = summarise(r);
    const rows = listChecks(r);
    const row = (id: string) => rows.find((c) => c.id === id);
    const where = `${sig}/${rev}/${end}/${iss}/${sch} → ${out.code}`;

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

    if (/\bgenuine\b|hasn't been changed|has not been changed|nothing has changed/.test(claims)) {
      expect(
        row(CHECK.signature)?.severity,
        `${where}: claims the credential is unchanged, but the signature row says "${row(CHECK.signature)?.value}"`,
      ).toBe('success');
    }

    if (/hasn't been withdrawn|hasn't withdrawn it|not been withdrawn/.test(claims)) {
      const revRow = row(CHECK.status)!;
      expect(
        revRow.severity === 'success' || !hasStatusList(r),
        `${where}: claims it was not withdrawn, but the row says "${revRow.value}"`,
      ).toBe(true);
    }

    // Each verdict must be borne out by the row it is about.
    const expectations: Record<string, [string, string] | undefined> = {
      verified: [CHECK.signature, 'success'],
      invalid_signature: [CHECK.signature, 'error'],
      signature_unchecked: [CHECK.signature, 'unchecked'],
      withdrawn: [CHECK.status, 'error'],
      withdrawal_unknown: [CHECK.status, 'unchecked'],
      expired: [DATES_ROW, 'warning'],
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
    expect(out.action).toContain('new copy');
  });
});

describe('verification that stopped early', () => {
  // 2.x has no "it stopped" shape of its own — every suite runs and reports —
  // so the equivalent is a failure among the four core checks.
  const FATAL: Array<[string, string, string]> = [
    [CHECK.contextExists, 'Invalid JSON-LD', 'unreadable_vocabulary'],
    [CHECK.contextExists, 'Missing Context', 'invalid_jsonld'],
    [CHECK.vcContext, 'Not a Verifiable Credential', 'no_vc_context'],
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
  });
});
