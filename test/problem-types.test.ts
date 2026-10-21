import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyCredential } from '@digitalcredentials/verifier-core';
import { summarise, listChecks } from '../src/outcomes.js';
import { CHECK, PROBLEM } from '../src/types.js';
import type { VerificationResponse } from '../src/types.js';

/**
 * The tripwire under the problem types outcomes.ts branches on.
 *
 * Everything that decides what a person is told about the seal and the dates
 * now rests on the library's problem *type*: tampering, expiry, a start date
 * not yet reached, and a key that isn't the issuer's each have their own since
 * verifier-core #58 and #59, and since 2.0.0-beta.1 the dates come from a
 * check of their own, which runs once the seal has held. Before that, expiry and tampering arrived as the
 * same INVALID_SIGNATURE, and this file pinned the sentences we told them
 * apart by. Those are gone; this pins the types instead, against the real
 * library and the real fixtures, so a change upstream fails here rather than
 * quietly telling someone the wrong thing about their credential.
 *
 * No network: `registries: []` skips the registry lookup, the Open Badges
 * schema suite is left out, and did:key resolves locally. The withdrawal
 * fixtures need their lists served, so they are covered in the browser tests.
 */

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../dev/fixtures/${name}.json`, import.meta.url), 'utf8'));

const verify = async (credential: Record<string, unknown>): Promise<VerificationResponse> =>
  (await verifyCredential({ credential, registries: [] })) as VerificationResponse;

const problemTypes = (r: VerificationResponse, id: string): string[] => {
  const outcome = (r.results ?? []).find((c) => c.id === id)?.outcome;
  return outcome?.status === 'failure' ? outcome.problems.map((p) => p.type) : [];
};

const status = (r: VerificationResponse, id: string) => (r.results ?? []).find((c) => c.id === id)?.outcome.status;

describe('what verifier-core reports, by type', () => {
  it.each([
    ['tampered', PROBLEM.invalidSignature],
    ['not-their-seal', PROBLEM.verificationMethod],
  ])('fails the signature check on %s with its own type', async (name, type) => {
    expect(problemTypes(await verify(fixture(name)), CHECK.signature)).toEqual([type]);
  });

  it.each([
    ['expired', PROBLEM.credentialExpired],
    ['not-yet-valid', PROBLEM.credentialNotYetValid],
  ])('passes the signature on %s, and fails the dates with their own type', async (name, type) => {
    const r = await verify(fixture(name));
    expect(status(r, CHECK.signature)).toBe('success');
    expect(problemTypes(r, CHECK.validityPeriod)).toEqual([type]);
  });

  it('passes the signature and the dates on a credential with nothing wrong', async () => {
    const r = await verify(fixture('verified'));
    expect(status(r, CHECK.signature)).toBe('success');
    expect(status(r, CHECK.validityPeriod)).toBe('success');
  });
});

describe('what a person is told, end to end', () => {
  it('tells someone whose credential ran out that it expired, names the date, and says the seal held', async () => {
    const r = await verify(fixture('expired'));
    const out = summarise(r);
    expect(out).toMatchObject({ code: 'expired', severity: 'warning', headline: 'Expired on 9 January 2026' });
    expect(out.action).toContain('renewed');
    const rows = listChecks(r);
    expect(rows.find((c) => c.id === CHECK.validityPeriod)).toMatchObject({ severity: 'warning', value: 'expired on 9 January 2026' });
    expect(rows.find((c) => c.id === CHECK.signature)).toMatchObject({ severity: 'success', value: 'none detected' });
  });

  it('tells someone whose credential has not started yet when it does', async () => {
    const r = await verify(fixture('not-yet-valid'));
    expect(summarise(r)).toMatchObject({ code: 'not_yet_valid', severity: 'warning', headline: 'Not valid until 1 January 2099' });
  });

  it('tells someone whose credential was altered that it was tampered with', async () => {
    expect(summarise(await verify(fixture('tampered')))).toMatchObject({
      code: 'invalid_signature',
      severity: 'error',
      headline: 'This credential has been tampered with',
    });
  });

  it('does not call a seal made with someone else’s key tampering', async () => {
    const out = summarise(await verify(fixture('not-their-seal')));
    expect(out).toMatchObject({ code: 'key_mismatch', severity: 'error' });
    expect(out.headline).not.toMatch(/tamper/i);
  });

  /**
   * The assumption `sealHeld` rests on, pinned against the real library: the
   * seal is checked before the dates. If that order ever flipped, an expired
   * credential that had also been altered would fail on its date and read
   * "none detected" — so this alters one and checks it fails on the seal.
   */
  it('checks the seal before the dates, so an altered expired credential reads as tampered', async () => {
    const altered = fixture('expired');
    (altered['credentialSubject'] as Record<string, unknown>)['name'] = 'Someone Else';
    const r = await verify(altered);
    expect(problemTypes(r, CHECK.signature)).toEqual([PROBLEM.invalidSignature]);
    // The dates are never reached: a failed seal stops everything after it.
    expect(status(r, CHECK.validityPeriod)).toBe('skipped');
    expect(summarise(r).code).toBe('invalid_signature');
    expect(listChecks(r).find((c) => c.id === CHECK.signature)?.value).toBe('detected');
  });
});

describe('a credential the library rejects for its shape', () => {
  it('stops at the structure check, and says so rather than blaming us', async () => {
    const c = fixture('withdrawn');
    c['validFrom'] = 'last Tuesday';
    const r = await verify(c);
    expect((r.results ?? []).find((x) => x.id === CHECK.vcStructure)?.outcome.status).toBe('failure');
    expect(summarise(r).code).toBe('invalid_structure');
  });
});
