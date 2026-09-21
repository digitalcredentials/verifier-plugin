import { describe, it, expect } from 'vitest';
import { summarise, listChecks, issuerIdentity } from '../src/outcomes.js';
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
    expect(listChecks(ok())).toHaveLength(4);
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

  it('does not claim the withdrawal list failed to load', () => {
    const rows = listChecks(noStatus());
    const withdrawal = rows.find((c) => c.id === 'revocation_status');
    expect(withdrawal).toBeUndefined();
    expect(rows.map((r) => r.value).join(' ')).not.toContain("didn't load");
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
