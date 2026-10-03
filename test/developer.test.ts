import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyCredential } from '@digitalcredentials/verifier-core';
import { obv3p0Recognizer } from '@digitalcredentials/verifier-core/openbadges';
import { groupChecks, checkName, belongsTo } from '../src/developer.js';
import { CHECK } from '../src/types.js';
import type { CheckResult, SuiteSummary, VerificationResponse } from '../src/types.js';

/**
 * The developer view promises every check the library returned, in the
 * library's own groups. These run the real library over the real fixtures, so
 * a change in how it names or groups its checks fails here rather than
 * quietly dropping a row.
 *
 * No network: `registries: []` skips the lookup, and did:key resolves locally.
 * The Open Badges schema suite is left out because it fetches the schema from
 * purl.imsglobal.org; its doubled-"schema" id is covered by hand below.
 */

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../dev/fixtures/${name}.json`, import.meta.url), 'utf8'));

const verify = async (name: string): Promise<VerificationResponse> =>
  (await verifyCredential({
    credential: fixture(name),
    registries: [],
    verbose: true,
    recognizers: [obv3p0Recognizer],
  })) as VerificationResponse;

const ids = (r: VerificationResponse) => (r.results ?? []).map((c) => c.id);

describe('groupChecks, against the real library', () => {
  it('shows every check exactly once, and nothing it did not return', async () => {
    for (const name of ['verified', 'expired', 'tampered', 'unsigned', 'malformed']) {
      const r = await verify(name);
      const shown = groupChecks(r).flatMap((g) => g.checks.map((c) => c.id));
      expect(shown.sort(), name).toEqual(ids(r).sort());
    }
  });

  it('keeps the library’s groups, in the library’s order, with its sentences', async () => {
    const r = await verify('verified');
    const groups = groupChecks(r);
    expect(groups.map((g) => g.suite?.id)).toEqual(r.summary!.map((s) => s.id));
    expect(groups.map((g) => g.suite?.message)).toEqual(r.summary!.map((s) => s.message));
    // Every check the real library returns belongs to one of its suites.
    expect(groups.every((g) => g.suite)).toBe(true);
  });

  it('files each check under the suite whose id it starts with', async () => {
    const r = await verify('verified');
    for (const g of groupChecks(r)) {
      for (const c of g.checks) expect(belongsTo(c.id!, g.suite!.id), c.id).toBe(true);
    }
  });

  it('keeps passed and skipped checks, not only failures', async () => {
    const r = await verify('verified');
    const statuses = new Set(groupChecks(r).flatMap((g) => g.checks.map((c) => c.outcome.status)));
    expect(statuses).toContain('success');
    expect(statuses).toContain('skipped');
  });

  it('still has checks to show when verification stopped early', async () => {
    const r = await verify('unsigned');
    const checks = groupChecks(r).flatMap((g) => g.checks);
    expect(checks.length).toBeGreaterThan(0);
    const proof = checks.find((c) => c.id === CHECK.proofExists)!;
    expect(proof.outcome.status).toBe('failure');
  });
});

const suite = (id: string, message = 'm'): SuiteSummary => ({
  id,
  phase: id.split('.')[0]!,
  suite: id.split('.').slice(1).join('.'),
  status: 'success',
  verified: true,
  message,
  counts: { passed: 1, failed: 0, skipped: 0 },
});

const check = (id: string | undefined, extra: Partial<CheckResult> = {}): CheckResult => ({
  id,
  check: 'c',
  suite: 's',
  outcome: { status: 'success', message: 'ok' },
  ...extra,
});

describe('groupChecks, at the edges', () => {
  it('does not claim a check for a suite that only shares the start of its name', () => {
    const r: VerificationResponse = {
      verified: true,
      summary: [suite('cryptographic.proof')],
      results: [check('cryptographic.proofs.other'), check('cryptographic.proof.signature')],
    };
    const [proof, rest] = groupChecks(r);
    expect(proof!.checks.map((c) => c.id)).toEqual(['cryptographic.proof.signature']);
    expect(rest!.suite).toBeUndefined();
    expect(rest!.checks.map((c) => c.id)).toEqual(['cryptographic.proofs.other']);
  });

  it('files a check under the nearer suite when one suite id contains another', () => {
    const r: VerificationResponse = {
      verified: true,
      summary: [suite('semantic.openbadges'), suite('semantic.openbadges.schema')],
      results: [check('semantic.openbadges.schema.x'), check('semantic.openbadges.y')],
    };
    const [outer, inner] = groupChecks(r);
    expect(outer!.checks.map((c) => c.id)).toEqual(['semantic.openbadges.y']);
    expect(inner!.checks.map((c) => c.id)).toEqual(['semantic.openbadges.schema.x']);
  });

  it('shows checks with no id, or no summary at all, rather than dropping them', () => {
    const r: VerificationResponse = { verified: false, results: [check(undefined), check('a.b')] };
    const groups = groupChecks(r);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.suite).toBeUndefined();
    expect(groups[0]!.checks).toHaveLength(2);
  });

  it('keeps a suite that reported no checks, with its sentence', () => {
    const r: VerificationResponse = { verified: true, summary: [suite('trust.registry', '0 of 0')], results: [] };
    expect(groupChecks(r)).toEqual([{ suite: r.summary![0], checks: [] }]);
  });

  it('puts the doubled-"schema" check under the schema suite, not beside it', () => {
    const r: VerificationResponse = {
      verified: true,
      summary: [suite('semantic.openbadges.schema')],
      results: [check(CHECK.schema)],
    };
    const [schema] = groupChecks(r);
    expect(schema!.checks.map((c) => c.id)).toEqual([CHECK.schema]);
    expect(checkName(schema!.checks[0]!, schema!.suite!.id)).toBe('schema.obv3.json');
  });

  it('adds no catch-all group when every check has a home', () => {
    const r: VerificationResponse = { verified: true, summary: [suite('a')], results: [check('a.b')] };
    expect(groupChecks(r)).toHaveLength(1);
  });
});

describe('checkName', () => {
  it('drops the suite prefix inside its own group', () => {
    expect(checkName(check('cryptographic.core.proof-exists'), 'cryptographic.core')).toBe('proof-exists');
  });

  it('keeps the whole id when the check is the suite, or has no group', () => {
    expect(checkName(check('recognition'), 'recognition')).toBe('recognition');
    expect(checkName(check('a.b'))).toBe('a.b');
    expect(checkName(check('a.b'), 'c')).toBe('a.b');
  });

  it('falls back to suite and check for a result with no id', () => {
    expect(checkName(check(undefined, { suite: 'core', check: 'proof' }))).toBe('core.proof');
  });
});
