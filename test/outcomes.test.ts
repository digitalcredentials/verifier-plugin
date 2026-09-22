import { describe, it, expect } from 'vitest';
import { summarise, listChecks, issuerIdentity, schemaFinding } from '../src/outcomes.js';
import type { VerificationResponse } from '../src/types.js';

/** A credential that can be withdrawn, so the revocation check applies. */
const credential = {
  issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' },
  credentialStatus: { type: 'BitstringStatusListEntry' },
};

/** The same, from an issuer who provided no way to withdraw it. */
const withoutStatusList = {
  issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' },
};

/** A result where everything passed, which individual tests then spoil. */
const ok = (): VerificationResponse => ({
  credential,
  log: [
    { id: 'valid_signature', valid: true },
    { id: 'expiration', valid: true },
    {
      id: 'revocation_status',
      valid: true,
    },
    {
      id: 'registered_issuer',
      valid: true,
      matchingIssuers: [
        {
          issuer: { federation_entity: { organization_name: 'Springfield College' } },
          registry: { federation_entity: { organization_name: 'DCC Registry' } },
        },
      ],
      uncheckedRegistries: [],
    },
  ],
});

describe('summarise', () => {
  it('reports success when every check passed', () => {
    const out = summarise(ok());
    expect(out.severity).toBe('success');
    expect(out.code).toBe('verified');
  });

  it('treats a bad signature as an error, not as unchecked', () => {
    const r = ok();
    r.log![0] = { id: 'valid_signature', valid: false };
    const out = summarise(r);
    expect(out.severity).toBe('error');
    expect(out.code).toBe('invalid_signature');
    expect(out.action).toBeDefined();
  });

  it('separates withdrawn from an unverifiable signature', () => {
    const r = ok();
    r.log![2] = { id: 'revocation_status', valid: false };
    const out = summarise(r);
    expect(out.severity).toBe('error');
    expect(out.code).toBe('withdrawn');
    // Different cause, so different advice. requirements.md §4.
    expect(out.action).toContain('new copy');
    expect(out.action).not.toContain('fresh copy');
  });

  it('treats expiry as a warning, not an error', () => {
    const r = ok();
    r.log![1] = { id: 'expiration', valid: false };
    expect(summarise(r).severity).toBe('warning');
  });
});

describe("the traps that make a good credential look bad", () => {
  it('does not report a network failure as an invalid signature', () => {
    const r: VerificationResponse = {
      credential,
      errors: [{ name: 'http_error_with_signature_check', message: 'boom' }],
    };
    const out = summarise(r);
    expect(out.severity).toBe('unchecked');
    expect(out.severity).not.toBe('error');
  });

  it('does not report a did:web that would not resolve as a failure', () => {
    const r: VerificationResponse = {
      credential,
      errors: [{ name: 'did_web_unresolved', message: 'boom' }],
    };
    expect(summarise(r).severity).toBe('unchecked');
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
    r.log!.push({ id: 'revocation_status', error: { name, message: 'x' } });
    const out = summarise(r);
    expect(out.severity).toBe('unchecked');
    expect(out.code).toBe('withdrawal_unknown');
  });

  it('does not treat a missing `valid` as a failed check', () => {
    // A check that could not run carries an error and no `valid` at all.
    // `!valid` would read that as "failed", which is the bug this guards.
    const r = ok();
    r.log!.push({ id: 'revocation_status', error: { name: 'status_list_not_found', message: 'x' } });
    const withdrawn = listChecks(r).find((c) => c.id === 'revocation_status');
    expect(withdrawn!.severity).toBe('unchecked');
    expect(withdrawn!.severity).not.toBe('error');
  });

  it('distinguishes an unreachable registry from an issuer that is not listed', () => {
    const notListed = ok();
    notListed.log![3] = {
      id: 'registered_issuer',
      valid: false,
      matchingIssuers: [],
      uncheckedRegistries: [],
    };

    const unreachable = ok();
    unreachable.log![3] = {
      id: 'registered_issuer',
      valid: false,
      matchingIssuers: [],
      uncheckedRegistries: [{ name: 'DCC Registry', url: 'https://example.test/r.json' }],
    };

    // Both report valid: false. Only the second list tells them apart.
    expect(summarise(notListed).code).toBe('issuer_unconfirmed');
    expect(summarise(unreachable).code).toBe('registry_unreachable');
    expect(summarise(unreachable).detail).toContain('DCC Registry');
  });

  it('never calls an unrecognised issuer fake', () => {
    const r = ok();
    r.log![3] = { id: 'registered_issuer', valid: false, matchingIssuers: [], uncheckedRegistries: [] };
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
    r.log![3] = { id: 'registered_issuer', valid: false, matchingIssuers: [], uncheckedRegistries: [] };
    expect(issuerIdentity(r).source).toBe('credential');
  });

  it("says when we don't know, because a registry was unreachable", () => {
    const r = ok();
    r.log![3] = {
      id: 'registered_issuer',
      valid: false,
      matchingIssuers: [],
      uncheckedRegistries: [{ name: 'DCC Registry' }],
    };
    expect(issuerIdentity(r).source).toBe('unknown');
  });

  it('falls back to the identifier when there is no name at all', () => {
    const r = ok();
    r.credential = { issuer: 'did:key:z6Mkn' };
    r.log![3] = { id: 'registered_issuer', valid: false, matchingIssuers: [], uncheckedRegistries: [] };
    const id = issuerIdentity(r);
    expect(id.source).toBe('none');
    expect(id.name).toBe('did:key:z6Mkn');
  });
});

describe('listChecks', () => {
  it('returns nothing when verification stopped early', () => {
    // Tier A has no per-check list. A display that assumes one will break.
    expect(listChecks({ credential, errors: [{ name: 'no_proof', message: 'x' }] })).toEqual([]);
  });

  it('returns one row per check when verification ran', () => {
    expect(listChecks(ok())).toHaveLength(5);
  });
});

describe('every problem says what to do', () => {
  const problems: VerificationResponse[] = [
    { credential, errors: [{ name: 'no_proof', message: 'x' }] },
    { credential, errors: [{ name: 'invalid_credential_id', message: 'x' }] },
    (() => { const r = ok(); r.log![0] = { id: 'valid_signature', valid: false }; return r; })(),
    (() => { const r = ok(); r.log![2] = { id: 'revocation_status', valid: false }; return r; })(),
    (() => { const r = ok(); r.log![1] = { id: 'expiration', valid: false }; return r; })(),
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
  const noStatus = (): VerificationResponse => ({
    credential: withoutStatusList,
    log: [
      { id: 'valid_signature', valid: true },
      { id: 'expiration', valid: true },
      {
        id: 'registered_issuer',
        valid: true,
        matchingIssuers: [
          {
            issuer: { federation_entity: { organization_name: 'Springfield College' } },
            registry: { federation_entity: { organization_name: 'DCC Registry' } },
          },
        ],
        uncheckedRegistries: [],
      },
    ],
  });

  it('says the issuer set up no way to withdraw it, rather than claiming a failure', () => {
    const rows = listChecks(noStatus());
    const withdrawal = rows.find((c) => c.id === 'revocation_status');
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
    r.credential = { ...withoutStatusList, credentialStatus: { type: 'BitstringStatusListEntry' } };
    r.log!.push({ id: 'revocation_status', error: { name: 'status_list_not_found', message: 'x' } });
    const withdrawal = listChecks(r).find((c) => c.id === 'revocation_status');
    expect(withdrawal?.severity).toBe('unchecked');
    expect(withdrawal?.value).toContain("didn't load");
  });
});

describe('findings from review', () => {
  it('does not contradict itself when a registry matches but gives no name', () => {
    // The registry recognised the issuer but supplied no organisation name.
    // The top line must not say "Verified" while the details deny the match.
    const r = ok();
    r.log![3] = {
      id: 'registered_issuer',
      valid: true,
      matchingIssuers: [{ registry: { federation_entity: { organization_name: 'DCC Registry' } } }],
      uncheckedRegistries: [],
    };
    expect(issuerIdentity(r).source).toBe('registry');
    expect(summarise(r).severity).toBe('success');
    const issuerRow = listChecks(r).find((c) => c.id === 'registered_issuer');
    expect(issuerRow!.severity).toBe('success');
    expect(issuerRow!.value).not.toContain('not in any registry');
  });

  it('falls back safely for an error named after an Object property', () => {
    const r: VerificationResponse = {
      credential,
      errors: [{ name: 'toString', message: 'x' }],
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
    r.log![3] = { id: 'registered_issuer', valid: false, matchingIssuers: [], uncheckedRegistries: [] };
    expect(issuerMarker(issuerIdentity(r).source)).toBe('unconfirmed');
  });

  it('marks a name we could not check, differently from one we could', async () => {
    const { issuerMarker } = await import('../src/outcomes.js');
    const r = ok();
    r.log![3] = {
      id: 'registered_issuer',
      valid: false,
      matchingIssuers: [],
      uncheckedRegistries: [{ name: 'DCC Registry' }],
    };
    expect(issuerMarker(issuerIdentity(r).source)).toBe('not checked');
  });

  it.each(['no_proof', 'invalid_signature'])(
    'marks no single field when verification stopped at %s',
    async (name) => {
      const { issuerMarker, contentCaveat, verdictLeads } = await import('../src/outcomes.js');
      const r: VerificationResponse = { credential, errors: [{ name, message: 'x' }] };
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
    r.log![2] = { id: 'revocation_status', valid: false };
    expect(summarise(r).severity).toBe('error');
    expect(verdictLeads(r)).toBe(false);
    expect(contentCaveat(r)).toBeUndefined();
  });

  it('leads with the finding only when verification stopped', async () => {
    const { verdictLeads } = await import('../src/outcomes.js');
    expect(verdictLeads({ credential, errors: [{ name: 'invalid_signature', message: 'x' }] })).toBe(true);
    expect(verdictLeads(ok())).toBe(false);
  });
});

describe('an expired credential names the date', () => {
  it('says when it expired', () => {
    const r = ok();
    r.credential = { ...credential, validUntil: '2026-01-09T10:00:00Z' };
    r.log![1] = { id: 'expiration', valid: false };
    expect(summarise(r).headline).toBe('Expired on 9 January 2026');
  });

  it('falls back when there is no readable date', () => {
    const r = ok();
    r.log![1] = { id: 'expiration', valid: false };
    expect(summarise(r).headline).toBe('This has passed its end date');
  });
});

describe('findings from the second review', () => {
  it('does not claim "Verified" when the signature check is absent from the log', () => {
    // A log with no signature step establishes nothing. listChecks renders it
    // as "not checked", so the headline must not say the opposite.
    const r = ok();
    r.log = r.log!.filter((step) => step.id !== 'valid_signature');
    const out = summarise(r);
    expect(out.severity).not.toBe('success');
    expect(out.code).toBe('signature_unchecked');

    const row = listChecks(r).find((c) => c.id === 'valid_signature');
    expect(row!.severity).toBe('unchecked');
  });

  it('gives a vocabulary failure its own advice, not "try again"', () => {
    const r: VerificationResponse = {
      credential,
      errors: [{ name: 'jsonld.ValidationError', message: 'x' }],
    };
    const out = summarise(r);
    expect(out.severity).toBe('error');
    expect(out.action).not.toContain('Try again');
    expect(out.action).toContain('replacement');
  });

  it('never leaks a library error name as one of our codes', () => {
    const r: VerificationResponse = {
      credential,
      errors: [{ name: 'SomeUpstreamError', message: 'x' }],
    };
    const out = summarise(r);
    expect(out.code).toBe('unknown_error');
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
        r.credential = { ...credential, validUntil: '2026-01-09' };
        r.log![1] = { id: 'expiration', valid: false };
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

/** verifier-core files this under `additionalInformation`, never in `log`. */
const withSchema = (results: unknown): VerificationResponse => {
  const r = ok();
  r.additionalInformation = [{ id: 'schema_check', results } as never];
  return r;
};

const missingProperty = [
  {
    schema: SCHEMA,
    result: {
      valid: false,
      errors: [{ keyword: 'required', message: "must have required property 'validFrom'" }],
    },
    source: 'Assumed based on vc.type',
  },
];

const wrongShape = [
  {
    schema: SCHEMA,
    result: {
      valid: false,
      errors: [{ keyword: 'type', message: 'must be string', instancePath: '/issuer/name' }],
    },
    source: 'Assumed based on vc.type',
  },
];

const passes = [{ schema: SCHEMA, result: { valid: true }, source: 'Assumed based on vc.type' }];

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

  // The declarations promise a list here. The runtime sends a bare string,
  // and reading it as a list silently loses both of these states.
  it('reads the bare strings the runtime actually returns', () => {
    expect(schemaFinding(withSchema('NO_SCHEMA'))).toEqual({ state: 'no_schema' });
    expect(schemaFinding(withSchema('INVALID_SCHEMA - possibly not a valid url'))).toEqual({
      state: 'unavailable',
    });
  });

  it('treats an absent entry as nothing to check against', () => {
    expect(schemaFinding(ok())).toEqual({ state: 'no_schema' });
  });

  it('will not count a schema that reported neither pass nor fail as a pass', () => {
    const r = withSchema([{ schema: SCHEMA, result: {}, source: 'x' }]);
    expect(schemaFinding(r)).toEqual({ state: 'unavailable' });
  });
});

describe('a credential the issuer built wrong', () => {
  // The whole reason this outcome exists: verifier-core keeps the schema
  // result out of `log`, so it never reaches `verified`. Everything the
  // library calls a pass still passed here.
  it('is surfaced even though verifier-core reports every check as passing', () => {
    const r = withSchema(missingProperty);
    expect(r.log!.every((s) => s.valid === true)).toBe(true);
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
    const row = listChecks(withSchema(missingProperty)).find((c) => c.id === 'schema_check');
    expect(row).toMatchObject({
      label: 'How it was built',
      severity: 'warning',
      value: 'missing details the standard requires',
    });
  });
});

describe('what a schema failure does not outrank', () => {
  const spoil = (results: unknown, id: string, step: object): VerificationResponse => {
    const r = withSchema(results);
    r.log = r.log!.map((s) => (s.id === id ? { id, ...step } : s));
    return r;
  };

  it('yields to a broken signature, which is the more serious finding', () => {
    expect(summarise(spoil(missingProperty, 'valid_signature', { valid: false })).code).toBe(
      'invalid_signature',
    );
  });

  it('yields to withdrawal', () => {
    expect(summarise(spoil(missingProperty, 'revocation_status', { valid: false })).code).toBe(
      'withdrawn',
    );
  });

  // Expiry is the one the holder can actually act on, so it leads.
  it('yields to expiry', () => {
    expect(summarise(spoil(missingProperty, 'expiration', { valid: false })).code).toBe('expired');
  });

  // ...but a definite finding leads over anything we merely could not check.
  it('leads over an issuer we could not confirm', () => {
    const r = spoil(missingProperty, 'registered_issuer', {
      valid: false,
      matchingIssuers: [],
      uncheckedRegistries: [],
    });
    expect(summarise(r).code).toBe('malformed');
  });
});

describe('having no schema to check against', () => {
  // A supplementary check that never ran must not drag down a verdict it
  // never contributed to. This is the opposite call from the signature.
  it.each(['NO_SCHEMA', 'INVALID_SCHEMA - possibly not a valid url'])(
    'leaves a pass standing (%s)',
    (results) => {
      expect(summarise(withSchema(results)).code).toBe('verified');
    },
  );

  it('still says so in the breakdown, for an issuer debugging their own badge', () => {
    const row = (results: unknown) =>
      listChecks(withSchema(results)).find((c) => c.id === 'schema_check');
    expect(row('NO_SCHEMA')).toMatchObject({
      severity: 'unchecked',
      value: 'no standard was declared to check it against',
    });
    expect(row('INVALID_SCHEMA - possibly not a valid url')).toMatchObject({
      severity: 'unchecked',
      value: "couldn't load the standard to check it against",
    });
  });

  it('reads as a pass when the schema did load and was clean', () => {
    expect(listChecks(withSchema(passes)).find((c) => c.id === 'schema_check')).toMatchObject({
      severity: 'success',
      value: 'as the standard expects',
    });
  });
});
