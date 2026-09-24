import { describe, it, expect } from 'vitest';
import {
  summarise,
  listChecks,
  issuerIdentity,
  issuerMarker,
  schemaFinding,
} from '../src/outcomes.js';
import { CHECK, PROBLEM, STATUS_LIST_PROBLEM_PREFIX } from '../src/types.js';
import type { VerificationResponse, CheckResult, ProblemDetail } from '../src/types.js';

/** A credential that can be withdrawn, so the revocation check applies. */
const credential = {
  issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' },
  credentialStatus: { type: 'BitstringStatusListEntry' },
};

/** The same, from an issuer who provided no way to withdraw it. */
const withoutStatusList = {
  issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' },
};

const pass = (id: string, message = 'ok', fatal = false): CheckResult => ({
  id,
  check: id.split('.').slice(-1)[0]!,
  suite: id.split('.').slice(1, 2)[0]!,
  outcome: { status: 'success', message },
  fatal,
});

const fail = (id: string, problems: ProblemDetail[], fatal = false): CheckResult => ({
  id,
  check: id.split('.').slice(-1)[0]!,
  suite: id.split('.').slice(1, 2)[0]!,
  outcome: { status: 'failure', problems },
  fatal,
});

const skip = (id: string, reason: string): CheckResult => ({
  id,
  check: id.split('.').slice(-1)[0]!,
  suite: id.split('.').slice(1, 2)[0]!,
  outcome: { status: 'skipped', reason },
});

/** Replace one check in place, leaving the rest of the result alone. */
const set = (r: VerificationResponse, replacement: CheckResult): void => {
  r.results = (r.results ?? []).map((c) => (c.id === replacement.id ? replacement : c));
};

/** Drop a check entirely — it never ran and left nothing behind. */
const remove = (r: VerificationResponse, id: string): void => {
  r.results = (r.results ?? []).filter((c) => c.id !== id);
};

const notRegistered = (): CheckResult =>
  fail(CHECK.registeredIssuer, [
    {
      type: PROBLEM.issuerNotRegistered,
      title: 'Issuer Not Registered',
      detail: 'Issuer did:key:z6Mkn was not found in any known DID registry.',
    },
  ]);

const tamperedSignature = (): CheckResult =>
  fail(
    CHECK.signature,
    [
      {
        type: PROBLEM.invalidSignature,
        title: 'Invalid Signature',
        detail: 'Verification error(s).',
      },
    ],
    true,
  );

/**
 * 2.x has no expiration check. An expired credential fails the *signature*
 * check, and `summarise()` confirms it against the credential's own end date,
 * so a test for expiry has to set both.
 */
const PAST = '2026-01-09T10:00:00Z';
const expire = (r: VerificationResponse): void => {
  r.verifiableCredential = { ...r.verifiableCredential, validUntil: PAST };
  set(
    r,
    fail(
      CHECK.signature,
      [
        {
          type: PROBLEM.invalidSignature,
          title: 'Invalid Signature',
          detail: `The current date time (2026-09-23T00:00:00Z) is after "validUntil" (${PAST}).`,
        },
      ],
      true,
    ),
  );
};

/** A result where everything passed, which individual tests then spoil. */
const ok = (): VerificationResponse => ({
  verified: true,
  verifiableCredential: { ...credential },
  results: [
    pass(CHECK.contextExists, 'ok', true),
    pass(CHECK.vcContext, 'ok', true),
    pass(CHECK.credentialId, 'ok', true),
    pass(CHECK.proofExists, 'ok', true),
    pass(CHECK.signature, 'Signature verified.', true),
    pass(CHECK.status, 'Credential status is valid (not revoked or suspended).'),
    pass(CHECK.registeredIssuer, 'Issuer found in registry: DCC Registry'),
    pass(CHECK.schema, 'Schema validation passed.'),
  ],
});


/**
 * 2.x has no "it stopped" shape. Every suite runs and reports, so the
 * equivalent is a failure among the four core checks — see `stoppedEarly()`.
 */
const stoppedAt = (id: string, title: string, detail = 'x'): VerificationResponse => ({
  verified: false,
  verifiableCredential: { ...credential },
  results: [
    fail(id, [{ type: PROBLEM.proofVerification, title, detail }], true),
  ],
});

const STOPPED = {
  no_proof: () => stoppedAt(CHECK.proofExists, 'No Proof'),
  invalid_credential_id: () => stoppedAt(CHECK.credentialId, 'Invalid Credential Id'),
  no_vc_context: () => stoppedAt(CHECK.vcContext, 'Not a Verifiable Credential'),
  invalid_jsonld: () => stoppedAt(CHECK.contextExists, 'Missing Context'),
  unreadable_vocabulary: () => stoppedAt(CHECK.contextExists, 'Invalid JSON-LD'),
};

describe('summarise', () => {
  it('reports success when every check passed', () => {
    const out = summarise(ok());
    expect(out.severity).toBe('success');
    expect(out.code).toBe('verified');
  });

  it('treats a bad signature as an error, not as unchecked', () => {
    const r = ok();
    set(r, tamperedSignature());
    const out = summarise(r);
    expect(out.severity).toBe('error');
    expect(out.code).toBe('invalid_signature');
    expect(out.action).toBeDefined();
  });

  it('separates withdrawn from an unverifiable signature', () => {
    const r = ok();
    set(
      r,
      fail(CHECK.status, [
        {
          type: PROBLEM.revoked,
          title: 'Credential Revoked or Suspended',
          detail: 'The credential has been revoked.',
        },
      ]),
    );
    const out = summarise(r);
    expect(out.severity).toBe('error');
    expect(out.code).toBe('withdrawn');
    // Different cause, so different advice. requirements.md §4.
    expect(out.action).toContain('new copy');
    expect(out.action).not.toContain('fresh copy');
  });

  it('treats expiry as a warning, not an error', () => {
    const r = ok();
    expire(r);
    expect(summarise(r).severity).toBe('warning');
  });
});

describe("the traps that make a good credential look bad", () => {
  // 2.x reports a transport failure and an unresolvable did:web as the same
  // PROOF_VERIFICATION_ERROR as anything else the proof suite cannot finish,
  // so both land on the one outcome. The principle is unchanged: a check we
  // could not complete is never a check that failed.
  const unattributable = (detail: string): VerificationResponse => {
    const r = ok();
    set(
      r,
      fail(
        CHECK.signature,
        [{ type: PROBLEM.proofVerification, title: 'Proof Verification Error', detail }],
        true,
      ),
    );
    return r;
  };

  it('does not report a network failure as an invalid signature', () => {
    const out = summarise(unattributable('fetch failed loading the issuer key'));
    expect(out.severity).toBe('unchecked');
    expect(out.severity).not.toBe('error');
  });

  it('does not report a did:web that would not resolve as a failure', () => {
    expect(summarise(unattributable('could not resolve did:web:example.edu')).severity).toBe(
      'unchecked',
    );
  });

  it.each([
    'status_list_not_found',
    'status_list_expired',
    'status_list_signature_error',
    'status_list_type_error',
    'status_list_not_yet_valid',
    'status_list_error',
  ])('treats %s as unchecked, since it is the issuer\'s setup and not a verdict', (name) => {
    const r = ok();
    set(
      r,
      fail(CHECK.status, [
        {
          type: `${STATUS_LIST_PROBLEM_PREFIX}${name.replace('status_list_', '').toUpperCase()}`,
          title: 'Status List Not Found',
          detail: 'The status list could not be fetched.',
        },
      ]),
    );
    const out = summarise(r);
    expect(out.severity).toBe('unchecked');
    expect(out.code).toBe('withdrawal_unknown');
  });

  it('does not treat a missing `valid` as a failed check', () => {
    // A check that could not run carries an error and no `valid` at all.
    // `!valid` would read that as "failed", which is the bug this guards.
    const r = ok();
    set(
      r,
      fail(CHECK.status, [
        {
          type: `${STATUS_LIST_PROBLEM_PREFIX}NOT_FOUND`,
          title: 'Status List Not Found',
          detail: 'The status list could not be fetched.',
        },
      ]),
    );
    const withdrawn = listChecks(r).find((c) => c.id === CHECK.status);
    expect(withdrawn!.severity).toBe('unchecked');
    expect(withdrawn!.severity).not.toBe('error');
  });

  it('distinguishes an unreachable registry from an issuer that is not listed', () => {
    const notListed = ok();
    set(notListed, notRegistered());

    const unreachable = ok();
    set(
      unreachable,
      fail(CHECK.registeredIssuer, [
        {
          type: PROBLEM.issuerNotRegistered,
          title: 'Issuer Not Registered',
          detail: 'Issuer did:key:z6Mkn was not found in any known DID registry.',
        },
        {
          type: PROBLEM.registryUnchecked,
          title: 'Registry Unchecked',
          detail: '1 registries could not be checked: DCC Registry',
        },
      ]),
    );

    // Both report valid: false. Only the second list tells them apart.
    expect(summarise(notListed).code).toBe('issuer_unconfirmed');
    expect(summarise(unreachable).code).toBe('registry_unreachable');
    expect(summarise(unreachable).detail).toContain('DCC Registry');
  });

  it('never calls an unrecognised issuer fake', () => {
    const r = ok();
    set(r, notRegistered());
    const out = summarise(r);
    expect(out.detail).toContain("doesn't mean the credential is fake");
    expect(out.headline).toContain('Genuine');
    expect(out.severity).not.toBe('error');
  });
});

describe('issuerIdentity', () => {
  it('says when a name came from a registry', () => {
    const id = issuerIdentity(ok());
    expect(id.source).toBe('registry');
    expect(id.registries).toContain('DCC Registry');
  });

  it('says when a name came only from the credential', () => {
    const r = ok();
    set(r, notRegistered());
    expect(issuerIdentity(r).source).toBe('credential');
  });

  it("says when we don't know, because a registry was unreachable", () => {
    const r = ok();
    set(
      r,
      fail(CHECK.registeredIssuer, [
        {
          type: PROBLEM.issuerNotRegistered,
          title: 'Issuer Not Registered',
          detail: 'Issuer did:key:z6Mkn was not found in any known DID registry.',
        },
        {
          type: PROBLEM.registryUnchecked,
          title: 'Registry Unchecked',
          detail: '1 registries could not be checked: DCC Registry',
        },
      ]),
    );
    expect(issuerIdentity(r).source).toBe('unknown');
  });

  it('falls back to the identifier when there is no name at all', () => {
    const r = ok();
    r.verifiableCredential = { issuer: 'did:key:z6Mkn' };
    set(r, notRegistered());
    const id = issuerIdentity(r);
    expect(id.source).toBe('none');
    expect(id.name).toBe('did:key:z6Mkn');
  });
});

describe('listChecks', () => {
  it('returns nothing when verification stopped early', () => {
    // Tier A has no per-check list. A display that assumes one will break.
    expect(listChecks(STOPPED.no_proof())).toEqual([]);
  });

  it('returns one row per check when verification ran', () => {
    expect(listChecks(ok())).toHaveLength(5);
  });
});

describe('every problem says what to do', () => {
  const problems: VerificationResponse[] = [
    STOPPED.no_proof(),
    STOPPED.invalid_credential_id(),
    (() => { const r = ok(); set(r, tamperedSignature()); return r; })(),
    (() => { const r = ok(); set(
      r,
      fail(CHECK.status, [
        {
          type: PROBLEM.revoked,
          title: 'Credential Revoked or Suspended',
          detail: 'The credential has been revoked.',
        },
      ]),
    ); return r; })(),
    (() => { const r = ok(); expire(r); return r; })(),
  ];

  it.each(problems)('names an action (%#)', (r) => {
    const out = summarise(r);
    expect(out.severity).not.toBe('success');
    expect(out.action, `${out.code} has no action`).toBeTruthy();
  });
});

describe('a credential with no way to be withdrawn', () => {
  // verifier-core produces no revocation step at all when the credential has
  // no status list. Nothing failed, so we must not say anything did.
  const noStatus = (): VerificationResponse => {
    const r = ok();
    r.verifiableCredential = { ...withoutStatusList };
    // 2.x skips the check and says why, where 1.x simply left no step behind.
    set(r, skip(CHECK.status, 'Credential has no credentialStatus.'));
    return r;
  };
  it('says the issuer set up no way to withdraw it, rather than claiming a failure', () => {
    const rows = listChecks(noStatus());
    const withdrawal = rows.find((c) => c.id === CHECK.status);
    expect(withdrawal!.value).toContain('no way to withdraw');
    // Nothing failed. There was nothing to try.
    expect(withdrawal!.value).not.toContain("didn't load");
    expect(withdrawal!.severity).not.toBe('error');
  });

  it('never labels a row with a claim that could be read as the finding', () => {
    // "Withdrawn by issuer" reads as a statement the moment its value stops
    // being a plain yes or no. Labels name the subject; values carry findings.
    for (const rows of [listChecks(noStatus()), listChecks(ok())]) {
      for (const row of rows) {
        expect(row.label.toLowerCase()).not.toContain('withdrawn');
        expect(row.label.toLowerCase()).not.toContain('not changed');
      }
    }
  });

  it('never makes the reader flip between yes-is-good and no-is-good', () => {
    // Every value on a fully passing credential reads as good news without
    // needing a negation.
    const values = listChecks(ok()).map((c) => c.value);
    expect(values).not.toContain('no');
    expect(values).not.toContain('yes');
  });

  it('still reports success overall', () => {
    expect(summarise(noStatus()).severity).toBe('success');
  });

  it('does show the row when there is a status list that failed', () => {
    const r = noStatus();
    r.verifiableCredential = { ...withoutStatusList, credentialStatus: { type: 'BitstringStatusListEntry' } };
    set(
      r,
      fail(CHECK.status, [
        {
          type: `${STATUS_LIST_PROBLEM_PREFIX}NOT_FOUND`,
          title: 'Status List Not Found',
          detail: 'The status list could not be fetched.',
        },
      ]),
    );
    const withdrawal = listChecks(r).find((c) => c.id === CHECK.status);
    expect(withdrawal?.severity).toBe('unchecked');
    expect(withdrawal?.value).toContain("didn't load");
  });
});

describe('findings from review', () => {
  it('does not contradict itself when a registry matches but gives no name', () => {
    // The registry recognised the issuer but supplied no organisation name.
    // The top line must not say "Verified" while the details deny the match.
    const r = ok();
    set(r, pass(CHECK.registeredIssuer, 'Issuer found in registry: DCC Registry'));
    expect(issuerIdentity(r).source).toBe('registry');
    expect(summarise(r).severity).toBe('success');
    const issuerRow = listChecks(r).find((c) => c.id === CHECK.registeredIssuer);
    expect(issuerRow!.severity).toBe('success');
    expect(issuerRow!.value).not.toContain('not in any registry');
  });

  it('falls back safely for an error named after an Object property', () => {
    const r: VerificationResponse = {
      credential,
      results: [fail(CHECK.contextExists, [{ type: PROBLEM.proofVerification, title: 'Missing Context', detail: 'x' }], true)],
    };
    const out = summarise(r);
    expect(out.severity).toBeDefined();
    expect(out.headline).toBeTruthy();
    expect(out.detail).toBeTruthy();
  });
});

describe('summariseCredential', () => {
  it('does not use the recipient name as the title', async () => {
    const { summariseCredential } = await import('../src/credential.js');
    const summary = summariseCredential({
      credentialSubject: { name: 'Sam Salmon' },
    });
    expect(summary.recipient).toBe('Sam Salmon');
    expect(summary.title).not.toBe('Sam Salmon');
  });
});

describe('the issuer name carries where it came from', () => {
  it('shows no marker when a registry recognised them', async () => {
    const { issuerMarker } = await import('../src/outcomes.js');
    expect(issuerMarker(issuerIdentity(ok()).source)).toBeUndefined();
  });

  it('marks a name that only the credential vouches for', async () => {
    const { issuerMarker } = await import('../src/outcomes.js');
    const r = ok();
    set(r, notRegistered());
    expect(issuerMarker(issuerIdentity(r).source)).toBe('unconfirmed');
  });

  it('marks a name we could not check, differently from one we could', async () => {
    const { issuerMarker } = await import('../src/outcomes.js');
    const r = ok();
    set(
      r,
      fail(CHECK.registeredIssuer, [
        {
          type: PROBLEM.issuerNotRegistered,
          title: 'Issuer Not Registered',
          detail: 'Issuer did:key:z6Mkn was not found in any known DID registry.',
        },
        {
          type: PROBLEM.registryUnchecked,
          title: 'Registry Unchecked',
          detail: '1 registries could not be checked: DCC Registry',
        },
      ]),
    );
    expect(issuerMarker(issuerIdentity(r).source)).toBe('not checked');
  });

  it.each(['no_proof', 'invalid_credential_id'])(
    'marks no single field when verification stopped at %s',
    async (name) => {
      const { issuerMarker, contentCaveat, verdictLeads } = await import('../src/outcomes.js');
      const r = STOPPED[name as keyof typeof STOPPED]();
      const identity = issuerIdentity(r);
      expect(identity.source).toBe('unverifiable');

      // We know something is wrong and not where, so marking the issuer alone
      // would imply the other fields are fine. One caveat covers the lot.
      expect(issuerMarker(identity.source)).toBeUndefined();
      expect(contentCaveat(r)).toContain("can't confirm");
      expect(verdictLeads(r)).toBe(true);
    },
  );
});

describe('when the finding comes before the credential', () => {
  it('leads with the credential whenever verification ran', async () => {
    const { verdictLeads, contentCaveat } = await import('../src/outcomes.js');
    // Even an error. A withdrawn credential is still a real credential, and
    // its contents were confirmed unaltered.
    const r = ok();
    set(
      r,
      fail(CHECK.status, [
        {
          type: PROBLEM.revoked,
          title: 'Credential Revoked or Suspended',
          detail: 'The credential has been revoked.',
        },
      ]),
    );
    expect(summarise(r).severity).toBe('error');
    expect(verdictLeads(r)).toBe(false);
    expect(contentCaveat(r)).toBeUndefined();
  });

  it('leads with the finding only when verification stopped', async () => {
    const { verdictLeads } = await import('../src/outcomes.js');
    expect(verdictLeads(STOPPED.no_proof())).toBe(true);
    expect(verdictLeads(ok())).toBe(false);
  });
});

describe('an expired credential names the date', () => {
  it('says when it expired', () => {
    const r = ok();
    r.verifiableCredential = { ...credential, validUntil: '2026-01-09T10:00:00Z' };
    expire(r);
    expect(summarise(r).headline).toBe('Expired on 9 January 2026');
  });

  it('falls back when there is no readable date', () => {
    const r = ok();
    expire(r);
    // The library says it ran out; the credential gives no date we can read,
    // so the headline must not invent one.
    r.verifiableCredential = { ...credential, validUntil: 'not-a-date' };
    expect(summarise(r).headline).toBe('This has passed its end date');
  });
});

describe('findings from the second review', () => {
  it('does not claim "Verified" when the signature check is absent from the log', () => {
    // A log with no signature step establishes nothing. listChecks renders it
    // as "not checked", so the headline must not say the opposite.
    const r = ok();
    remove(r, CHECK.signature);
    const out = summarise(r);
    expect(out.severity).not.toBe('success');
    expect(out.code).toBe('signature_unchecked');

    const row = listChecks(r).find((c) => c.id === CHECK.signature);
    expect(row!.severity).toBe('unchecked');
  });

  it('gives a vocabulary failure its own advice, not "try again"', () => {
    const r: VerificationResponse = {
      credential,
      results: [fail(CHECK.contextExists, [{ type: PROBLEM.proofVerification, title: 'Invalid JSON-LD', detail: 'x' }], true)],
    };
    const out = summarise(r);
    expect(out.severity).toBe('error');
    expect(out.action).not.toContain('Try again');
    expect(out.action).toContain('replacement');
  });

  it('never leaks a library error name as one of our codes', () => {
    const r: VerificationResponse = {
      credential,
      results: [fail(CHECK.contextExists, [{ type: PROBLEM.proofVerification, title: 'Missing Context', detail: 'x' }], true)],
    };
    const out = summarise(r);
    expect(out.code).toBe('invalid_jsonld');
    expect(out.code).not.toContain('Upstream');
  });

  it.each(['America/New_York', 'Pacific/Auckland', 'UTC'])(
    'reports the same expiry date in %s',
    (timeZone) => {
      // A credential's dates belong to the credential, not to where its
      // holder is standing. A date-only value is the case that breaks.
      const original = process.env.TZ;
      process.env.TZ = timeZone;
      try {
        const r = ok();
        r.verifiableCredential = { ...credential, validUntil: '2026-01-09' };
        expire(r);
        expect(summarise(r).headline).toBe('Expired on 9 January 2026');
      } finally {
        process.env.TZ = original;
      }
    },
  );
});

// ---------------------------------------------------------------------------
// How it was built
// ---------------------------------------------------------------------------

const SCHEMA = 'https://purl.imsglobal.org/spec/ob/v3p0/schema/json/x.json';

const withSchema = (schema: CheckResult): VerificationResponse => {
  const r = ok();
  set(r, schema);
  return r;
};

const schemaProblem = (detail: string): ProblemDetail => ({
  type: PROBLEM.schemaValidationFailed,
  title: 'Schema Validation Failed',
  detail: `Schema validation failed for ${SCHEMA}: ${detail}`,
});

const missingProperty = fail(CHECK.schema, [
  schemaProblem("/credentialSubject: must have required property 'validFrom'"),
]);
const wrongShape = fail(CHECK.schema, [schemaProblem('/issuer/name: must be string')]);
const passes = pass(CHECK.schema, 'Schema validation passed.');
/** Nothing declared a standard we know how to check against. */
const noSchema = skip(
  CHECK.schema,
  'Credential does not appear to be an OBv3 credential (OpenBadgeCredential or EndorsementCredential).',
);
/** There was a standard and the check could not be carried out. */
const unavailableSchema = skip(CHECK.schema, 'No verifiable credential found in subject.');

describe('schemaFinding', () => {
  it('reads a pass', () => {
    expect(schemaFinding(withSchema(passes))).toEqual({ state: 'valid' });
  });

  it('separates missing fields from wrongly shaped ones', () => {
    expect(schemaFinding(withSchema(missingProperty))).toEqual({
      state: 'invalid',
      missingOnly: true,
    });
    expect(schemaFinding(withSchema(wrongShape))).toEqual({ state: 'invalid', missingOnly: false });
  });

  // 2.x skips with a reason rather than returning a bare string, and the two
  // reasons mean different things: nothing to check against is not the same
  // as a check we could not carry out.
  it('separates the two reasons the check skips', () => {
    expect(schemaFinding(withSchema(noSchema))).toEqual({ state: 'no_schema' });
    expect(schemaFinding(withSchema(unavailableSchema))).toEqual({ state: 'unavailable' });
  });

  it('treats an absent check as nothing to check against', () => {
    const r = ok();
    remove(r, CHECK.schema);
    expect(schemaFinding(r)).toEqual({ state: 'no_schema' });
  });

  it('will not read a failure that is not a validation failure as built wrong', () => {
    const r = withSchema(
      fail(CHECK.schema, [
        { type: 'urn:something-else', title: 'Schema Unreachable', detail: 'could not load' },
      ]),
    );
    expect(schemaFinding(r)).toEqual({ state: 'unavailable' });
  });
});

describe('a credential the issuer built wrong', () => {
  // The whole reason this outcome exists. In 2.x the schema check is a real
  // check, but it is not fatal and not in the default suites — verify.ts adds
  // it — so everything that bears on authenticity still passed here.
  it('is surfaced even though every check bearing on authenticity passed', () => {
    const r = withSchema(missingProperty);
    const authenticity = [CHECK.signature, CHECK.status, CHECK.registeredIssuer];
    expect(
      (r.results ?? [])
        .filter((c) => authenticity.includes(c.id as (typeof authenticity)[number]))
        .every((c) => c.outcome.status === 'success'),
    ).toBe(true);
    expect(summarise(r).code).toBe('malformed');
  });

  it('is a warning, not an error — nothing here says it is fake', () => {
    const out = summarise(withSchema(missingProperty));
    expect(out.severity).toBe('warning');
    expect(out.headline).toBe('This credential is missing information it should have');
  });

  it('says so differently when a field is present but the wrong shape', () => {
    expect(summarise(withSchema(wrongShape)).headline).toBe(
      "This credential wasn't built the way it should have been",
    );
  });

  // Nate Otto, 22 September: "None of these are errors that the user who
  // holds the credential could resolve themselves."
  it('names whose job the fix is, and releases the holder from it', () => {
    const out = summarise(withSchema(missingProperty));
    expect(out.action).toContain('Springfield College');
    expect(out.action).toContain("nothing for you to do");
  });

  it('shows the finding in the breakdown', () => {
    const row = listChecks(withSchema(missingProperty)).find((c) => c.id === CHECK.schema);
    expect(row).toMatchObject({
      label: 'How it was built',
      severity: 'warning',
      value: 'missing details the standard requires',
    });
  });
});

describe('what a schema failure does not outrank', () => {
  const spoil = (schema: CheckResult, broken: CheckResult): VerificationResponse => {
    const r = withSchema(schema);
    set(r, broken);
    return r;
  };

  it('yields to a broken signature, which is the more serious finding', () => {
    expect(summarise(spoil(missingProperty, tamperedSignature())).code).toBe('invalid_signature');
  });

  it('yields to withdrawal', () => {
    const revoked = fail(CHECK.status, [
      {
        type: PROBLEM.revoked,
        title: 'Credential Revoked or Suspended',
        detail: 'The credential has been revoked.',
      },
    ]);
    expect(summarise(spoil(missingProperty, revoked)).code).toBe('withdrawn');
  });

  // Expiry is the one the holder can actually act on, so it leads.
  it('yields to expiry', () => {
    const r = withSchema(missingProperty);
    expire(r);
    expect(summarise(r).code).toBe('expired');
  });

  // ...but a definite finding leads over anything we merely could not check.
  it('leads over an issuer we could not confirm', () => {
    expect(summarise(spoil(missingProperty, notRegistered())).code).toBe('malformed');
  });
});

describe('having no schema to check against', () => {
  // A supplementary check that never ran must not drag down a verdict it
  // never contributed to. This is the opposite call from the signature.
  it.each([noSchema, unavailableSchema])(
    'leaves a pass standing (%s)',
    (results) => {
      expect(summarise(withSchema(results)).code).toBe('verified');
    },
  );

  it('still says so in the breakdown, for an issuer debugging their own badge', () => {
    const row = (schema: CheckResult) =>
      listChecks(withSchema(schema)).find((c) => c.id === CHECK.schema);
    expect(row(noSchema)).toMatchObject({
      severity: 'unchecked',
      value: 'no standard was declared to check it against',
    });
    expect(row(unavailableSchema)).toMatchObject({
      severity: 'unchecked',
      value: "couldn't load the standard to check it against",
    });
  });

  it('reads as a pass when the schema did load and was clean', () => {
    expect(listChecks(withSchema(passes)).find((c) => c.id === CHECK.schema)).toMatchObject({
      severity: 'success',
      value: 'as the standard expects',
    });
  });
});

describe('the reassurance beside a finding never outruns the checks', () => {
  // Found in review. "It's genuine and hasn't been withdrawn" was fixed text,
  // so it appeared above a breakdown that said the signature was never
  // checked, or the withdrawal list never loaded. Since status lists do not
  // load in a browser today, the second was the common path.
  const withBad = (mutate: (r: VerificationResponse) => void): VerificationResponse => {
    const r = withSchema(missingProperty);
    mutate(r);
    return r;
  };

  it('claims both only when both actually reported', () => {
    const detail = summarise(withSchema(missingProperty)).detail;
    expect(detail).toContain('Nothing has changed since it was issued');
    expect(detail).toContain("issuer hasn't withdrawn it");
  });

  it("does not claim it was not withdrawn when the list didn't load", () => {
    const r = withBad((x) => {
      set(
        x,
        fail(CHECK.status, [
          {
            type: `${STATUS_LIST_PROBLEM_PREFIX}NOT_FOUND`,
            title: 'Status List Not Found',
            detail: 'The status list could not be fetched.',
          },
        ]),
      );
    });
    expect(summarise(r).detail).not.toContain('withdrawn');
    // ...but the part that did report is still said.
    expect(summarise(r).detail).toContain('Nothing has changed since it was issued');
  });

  it('claims nothing about the signature when the signature never reported', () => {
    const r = withBad((x) => {
      remove(x, CHECK.signature);
    });
    const detail = summarise(r).detail;
    expect(detail).not.toContain('Nothing has changed');
    expect(detail).not.toContain('withdrawn');
    expect(detail).toContain('leaves out details');
  });
});

describe('an unreachable registry when another one answered', () => {
  // Found in review, and present since the first slice. A match and an
  // unreachable registry are not mutually exclusive — with two registries
  // both are true at once, and the headline said "we couldn't confirm who
  // issued this" above a row reading "found in DCC Registry".
  const matchedAndUnreachable = (): VerificationResponse => {
    const r = ok();
    // Both facts arrive in one sentence on the success message.
    set(
      r,
      pass(
        CHECK.registeredIssuer,
        'Issuer found in registry: DCC Registry. 1 registries could not be checked: Second Registry',
      ),
    );
    return r;
  };

  it('does not claim the issuer is unconfirmed when a registry confirmed them', () => {
    expect(summarise(matchedAndUnreachable()).code).toBe('verified');
  });

  it('agrees with the row, which says the issuer was found', () => {
    const row = listChecks(matchedAndUnreachable()).find((c) => c.id === CHECK.registeredIssuer);
    expect(row!.severity).toBe('success');
    expect(row!.value).toContain('found in');
  });
});

describe('a withdrawal check that never ran', () => {
  // Found in the second review. verifier-core leaves no revocation step at
  // all when it never gets that far — a `credentialStatus` type it does not
  // know, or an earlier failure that stopped verification — which is not the
  // same as the issuer providing no way to withdraw. The verdict fell
  // through to a green "Verified" whose detail said the issuer had not
  // withdrawn it, above a row saying we could not check.
  const unrecognised = (): VerificationResponse => {
    const r = ok();
    r.verifiableCredential = {
      issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' },
      credentialStatus: { type: 'SomeFutureStatusMethod' },
    };
    remove(r, CHECK.status);
    return r;
  };

  it('does not claim the issuer has not withdrawn it', () => {
    const out = summarise(unrecognised());
    expect(out.code).toBe('withdrawal_unknown');
    expect(out.severity).toBe('unchecked');
    expect(out.detail).not.toContain("hasn't withdrawn");
  });

  it('does not invent a cause it cannot establish', () => {
    // Two rounds of getting this wrong in opposite directions. "The list
    // didn't load" blames a fetch that never happened; "not a method we
    // recognise" blames the issuer for what is often just verification
    // stopping earlier. The log cannot tell them apart, so neither do we.
    const out = summarise(unrecognised());
    expect(out.detail).toContain('never ran');
    expect(out.detail).not.toContain("didn't load");
    expect(out.detail).not.toContain('recognise');
  });

  it('reads the same way in the breakdown', () => {
    const row = listChecks(unrecognised()).find((c) => c.id === CHECK.status);
    expect(row).toMatchObject({ severity: 'unchecked', value: 'not checked' });
  });

  it('is still told apart from an issuer who set up no way to withdraw', () => {
    const r = ok();
    r.verifiableCredential = { issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' } };
    remove(r, CHECK.status);
    expect(summarise(r).code).toBe('verified');
    expect(listChecks(r).find((c) => c.id === CHECK.status)!.value).toBe(
      'the issuer set up no way to withdraw this',
    );
  });
});

describe('the marker beside the issuer name agrees with the verdict', () => {
  // Found in the second review. With no name in the credential, the "no name
  // at all" return path overwrote the source, so the marker said
  // "unconfirmed" while the verdict said we simply don't know.
  it("says 'not checked', not 'unconfirmed', when a registry was unreachable", () => {
    const r = ok();
    r.verifiableCredential = { issuer: 'did:key:z6Mkn' };
    set(
      r,
      fail(CHECK.registeredIssuer, [
        {
          type: PROBLEM.issuerNotRegistered,
          title: 'Issuer Not Registered',
          detail: 'Issuer did:key:z6Mkn was not found in any known DID registry.',
        },
        {
          type: PROBLEM.registryUnchecked,
          title: 'Registry Unchecked',
          detail: '1 registries could not be checked: DCC Registry',
        },
      ]),
    );
    const id = issuerIdentity(r);
    expect(id.source).toBe('unknown');
    expect(issuerMarker(id.source)).toBe('not checked');
    expect(summarise(r).code).toBe('registry_unreachable');
  });

  it("still says 'unconfirmed' when the registries answered and none listed them", () => {
    const r = ok();
    r.verifiableCredential = { issuer: 'did:key:z6Mkn' };
    set(r, notRegistered());
    const id = issuerIdentity(r);
    expect(id.source).toBe('none');
    expect(issuerMarker(id.source)).toBe('unconfirmed');
  });
});

describe('a json-ld failure among several problems', () => {
  // Found in the third review. verifier-core reaches its json-ld branch by
  // finding such an error anywhere in the list; we read only the first, so a
  // credential whose vocabulary cannot be parsed was told to try again in a
  // moment — advice that can never work for a failure retrying won't change.
  //
  // In 2.x the list is the failing check's `problems` rather than a top-level
  // `errors` array, and the name we match on is the problem's title.
  const withProblems = (...titles: string[]): VerificationResponse => ({
    verified: false,
    verifiableCredential: { ...credential },
    results: [
      fail(
        CHECK.contextExists,
        titles.map((title) => ({ type: PROBLEM.proofVerification, title, detail: 'x' })),
        true,
      ),
    ],
  });

  it('is recognised wherever it sits in the list', () => {
    expect(summarise(withProblems('Invalid JSON-LD')).code).toBe('unreadable_vocabulary');
    expect(summarise(withProblems('Something Else', 'Invalid JSON-LD')).code).toBe(
      'unreadable_vocabulary',
    );
  });

  it('offers advice that can actually help', () => {
    const out = summarise(withProblems('Something Else', 'Invalid JSON-LD'));
    expect(out.action).toContain('replacement');
    expect(out.action).not.toContain('Try again');
  });

  it('still falls back when no problem is a json-ld one', () => {
    expect(summarise(withProblems('Something Else', 'And Another')).code).toBe('invalid_jsonld');
  });
});


describe('a response that does not echo the credential back', () => {
  // Found in the third review. A result can come back without the parsed
  // credential echoed on it, and `issuerIdentity` reads the name from there.
  // Every fixture we have is well-formed enough that 2.x returns the parsed
  // credential, which is why this never showed up in the browser.
  it('has no name to offer, which is why the component supplies one', () => {
    const noCredential: VerificationResponse = {
      verified: false,
      results: [fail(CHECK.proofExists, [{ type: PROBLEM.proofVerification, title: 'No Proof' }], true)],
    };
    expect(issuerIdentity(noCredential).name).toBe('Unknown issuer');
    // The component was handed the credential, so it passes it in. Without
    // that, a card whose credential plainly names its issuer says "Unknown
    // issuer" — and `?? summary.issuerName` never fires, because a name is
    // always returned.
    expect(issuerIdentity({ ...noCredential, verifiableCredential: credential }).name).toBe(
      'Springfield College',
    );
  });
});
