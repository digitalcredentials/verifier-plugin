import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyCredential } from '@digitalcredentials/verifier-core';
import { obv3p0Recognizer } from '@digitalcredentials/verifier-core/openbadges';
import type { VerificationResponse } from '../src/types.js';

/**
 * The demo's credentials are well-formed Open Badges, apart from the one built
 * wrong on purpose. Each situation is meant to differ from Verified in one
 * way only; a credential that also broke the standard would show a failed
 * check in the developer view that has nothing to do with its situation.
 *
 * Runs the real library over dev/fixtures with no network: `registries: []`
 * skips the lookup, did:key resolves locally, and the built-in fetcher
 * refuses the localhost status lists without fetching them.
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

/** Every demo credential but the unsigned one, which recognition skips, and the one built wrong. */
const WELL_FORMED = [
  'verified',
  'not-withdrawn',
  'expired',
  'not-yet-valid',
  'withdrawn',
  'suspended',
  'tampered',
  'not-their-seal',
  'list-not-issuers',
];

const recognition = (r: VerificationResponse) => r.results.find((c) => c.id === 'recognition.profile');

describe('the demo credentials', () => {
  it.each(WELL_FORMED)('%s is recognised as an Open Badge', async (name) => {
    const r = await verify(name);
    expect(recognition(r)?.outcome.status).toBe('success');
    expect(recognition(r)?.outcome.problems ?? []).toEqual([]);
    expect(r.recognizedProfile).toBe('obv3p0.openbadge');
  });

  it('the one built wrong fails recognition for its missing achievement id', async () => {
    const problems = recognition(await verify('malformed'))?.outcome.problems ?? [];
    expect(problems.map((p) => p.instance)).toEqual(['/credentialSubject/achievement/id']);
  });

  // Read off the files, not the library: recognition reports one problem at a
  // time, so it can't show that the two above — built wrong, and unsigned,
  // which it skips — aren't also missing this.
  it('every one names its learner by id, as Open Badges 3.0 requires', () => {
    for (const name of [...WELL_FORMED, 'unsigned', 'malformed']) {
      const subject = fixture(name).credentialSubject as { id?: unknown };
      expect(subject.id, name).toBe('did:example:sam-salmon');
    }
  });
});
