import { describe, it, expect } from 'vitest';
import { summarise, listChecks, stoppedEarly, hasStatusList } from '../src/outcomes.js';
import type { VerificationResponse, VerificationStep } from '../src/types.js';

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
 */

type Sig = 'passed' | 'failed' | 'missing';
type Rev = 'passed' | 'failed' | 'errored' | 'none';
type Exp = 'passed' | 'failed' | 'missing';
type Iss = 'matched' | 'unlisted' | 'unreachable';

const SIGNATURES: Sig[] = ['passed', 'failed', 'missing'];
const REVOCATIONS: Rev[] = ['passed', 'failed', 'errored', 'none'];
const EXPIRATIONS: Exp[] = ['passed', 'failed', 'missing'];
const ISSUERS: Iss[] = ['matched', 'unlisted', 'unreachable'];

const build = (sig: Sig, rev: Rev, exp: Exp, iss: Iss): VerificationResponse => {
  const log: VerificationStep[] = [];

  if (sig !== 'missing') log.push({ id: 'valid_signature', valid: sig === 'passed' });
  if (exp !== 'missing') log.push({ id: 'expiration', valid: exp === 'passed' });

  if (rev === 'passed' || rev === 'failed') {
    log.push({ id: 'revocation_status', valid: rev === 'passed' });
  } else if (rev === 'errored') {
    log.push({ id: 'revocation_status', error: { name: 'status_list_not_found', message: 'x' } });
  }

  log.push({
    id: 'registered_issuer',
    valid: iss === 'matched',
    matchingIssuers:
      iss === 'matched'
        ? [
            {
              issuer: { federation_entity: { organization_name: 'Springfield College' } },
              registry: { federation_entity: { organization_name: 'DCC Registry' } },
            },
          ]
        : [],
    uncheckedRegistries: iss === 'unreachable' ? [{ name: 'DCC Registry' }] : [],
  });

  return {
    credential: {
      issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' },
      // "none" means the issuer never set up a way to withdraw it at all.
      ...(rev === 'none' ? {} : { credentialStatus: { type: 'BitstringStatusListEntry' } }),
    },
    log,
  };
};

const cases = SIGNATURES.flatMap((sig) =>
  REVOCATIONS.flatMap((rev) =>
    EXPIRATIONS.flatMap((exp) =>
      ISSUERS.map((iss) => ({ sig, rev, exp, iss, name: `${sig}/${rev}/${exp}/${iss}` })),
    ),
  ),
);

describe(`the headline and the breakdown agree (${cases.length} combinations)`, () => {
  it.each(cases)('$name', ({ sig, rev, exp, iss }) => {
    const r = build(sig, rev, exp, iss);
    const out = summarise(r);
    const rows = listChecks(r);
    const row = (id: string) => rows.find((c) => c.id === id);
    const where = `${sig}/${rev}/${exp}/${iss} → ${out.code}`;

    expect(rows.length, `${where}: verification ran, so there must be rows`).toBeGreaterThan(0);

    // A clean verdict cannot sit above a row reporting a problem.
    if (out.severity === 'success') {
      for (const c of rows) {
        // The one agreed exception: a credential the issuer provided no way to
        // withdraw. Nothing failed and there was nothing to try, so the row
        // carries no information while the verdict is still a pass.
        const agreedException = c.id === 'revocation_status' && !hasStatusList(r);
        if (agreedException) {
          expect(c.severity, `${where}: the no-withdrawal-list row`).toBe('unchecked');
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

    // Each verdict must be borne out by the row it is about.
    const expectations: Record<string, [string, string] | undefined> = {
      verified: ['valid_signature', 'success'],
      invalid_signature: ['valid_signature', 'error'],
      signature_unchecked: ['valid_signature', 'unchecked'],
      expiry_unchecked: ['expiration', 'unchecked'],
      withdrawn: ['revocation_status', 'error'],
      withdrawal_unknown: ['revocation_status', 'unchecked'],
      expired: ['expiration', 'warning'],
    };
    const expected = expectations[out.code];
    if (expected) {
      const [id, severity] = expected;
      expect(row(id)?.severity, `${where}: "${row(id)?.label}" must agree`).toBe(severity);
    }

    // The issuer verdicts must never sit above a row claiming a registry match.
    if (out.code === 'issuer_unconfirmed' || out.code === 'registry_unreachable') {
      expect(row('registered_issuer')?.severity, `${where}: issuer row`).not.toBe('success');
    }

    // Every verdict that is not a pass names one thing to do, except the
    // unconfirmed-issuer case, where §5 deliberately gives no instruction
    // because nothing is wrong and there is nothing to fix.
    if (out.severity !== 'success' && out.code !== 'issuer_unconfirmed') {
      expect(out.action, `${where}: no action offered`).toBeTruthy();
    }
  });
});

describe('verification that stopped early', () => {
  const FATAL = [
    'invalid_jsonld',
    'no_vc_context',
    'invalid_credential_id',
    'no_proof',
    'invalid_signature',
    'http_error_with_signature_check',
    'did_web_unresolved',
    'unknown_error',
    'jsonld.ValidationError',
  ];

  it.each(FATAL)('%s reports no rows, and says so consistently', (name) => {
    const r: VerificationResponse = {
      credential: { issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' } },
      errors: [{ name, message: 'x' }],
    };
    expect(stoppedEarly(r)).toBe(true);
    // Nothing else ran, so there is no breakdown to show. A display that
    // assumes a list always comes back breaks here.
    expect(listChecks(r)).toEqual([]);

    const out = summarise(r);
    expect(out.headline).toBeTruthy();
    expect(out.detail).toBeTruthy();
    expect(out.action, `${name} offers no action`).toBeTruthy();
    expect(['error', 'unchecked']).toContain(out.severity);
  });
});
