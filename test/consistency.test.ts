import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { summarise, listChecks, stoppedEarly } from '../src/outcomes.js';
import { CHECK, PROBLEM } from '../src/types.js';
import type { VerificationResponse } from '../src/types.js';
import {
  CLAIMS_UNCHANGED,
  CLAIMS_NOT_WITHDRAWN,
  LEANS_POSITIVE,
  PARTS,
  build,
  check,
} from './consistency-combinations.js';

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
    // Every "couldn't check": neutral, so never read as saying the credential
    // is unchanged or still active.
    "We couldn't check this right now",
    "Something went wrong while we were checking, so we can't tell you yet whether it's valid.",
    "We couldn't reach the issuer's website, so we can't tell you yet whether it's valid.",
    "This copy says its status can be checked, but we couldn't finish that check, so we can't tell you either way.",
    "We couldn't get reliable status information from the issuer, so we can't tell you either way.",
    'Try again in a little while.',
    "Try again in a little while. If it still doesn't work, let the issuer know.",
    'This is no longer a valid credential.',
    "This copy is no longer valid. That doesn't always mean the achievement was taken back; issuers sometimes deactivate a copy to replace it, for example to correct a detail.",
    "This copy can't be relied on while it's on hold. This may be temporary.",
    "We couldn't check whether this copy is still active",
  ])('does not read "%s" as a claim', (text) => {
    expect(text.toLowerCase()).not.toMatch(CLAIMS_UNCHANGED);
    expect(text.toLowerCase()).not.toMatch(CLAIMS_NOT_WITHDRAWN);
  });

  it.each([
    'It might be valid.',
    'It may still be valid.',
    "It's probably fine.",
    "That doesn't mean anything is wrong with your credential.",
    "That's a problem at our end, not with your credential.",
    "It doesn't mean the credential is fake.",
    "Don't worry, nothing is wrong.",
    "Nothing's wrong with it.",
    "It should be fine.",
    "There's no problem with your credential.",
    "That doesn't necessarily mean it's invalid.",
  ])('reads "%s" as leaning positive', (text) => {
    expect(text.toLowerCase()).toMatch(LEANS_POSITIVE);
  });

  it.each([
    "Something went wrong while we were checking, so we can't tell you yet whether it's valid.",
    "It hasn't been tampered with, but some of our lists of known issuers didn't respond, so we can't say yet who issued it.",
    "It says it was issued by Springfield College. They aren't on our list of known issuers, which is common.",
    "This copy can't be relied on while it's on hold. This may be temporary.",
  ])('does not read "%s" as leaning positive', (text) => {
    expect(text.toLowerCase()).not.toMatch(LEANS_POSITIVE);
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
 * The headline and the breakdown are held to each other across every
 * combination in consistency-combinations.ts, a part per file. A part whose
 * file went missing would drop its share of them without a sound. (A file
 * can't run the wrong part: each takes its number from its own name.)
 */
describe('the consistency suite', () => {
  it(`runs all ${PARTS} parts of the combinations`, () => {
    const files = readdirSync(new URL('.', import.meta.url)).filter((f) => /^consistency-\d+\.test\.ts$/.test(f));
    expect(files.sort()).toEqual(Array.from({ length: PARTS }, (_, i) => `consistency-${i + 1}.test.ts`).sort());
  });
});

describe('a credential that is both withdrawn and expired', () => {
  // The contradiction the 2.x migration introduced and this suite exists to
  // catch: expiry moved ahead of withdrawal, so the headline was a warning
  // about renewal while the breakdown reported an error.
  it('reports the withdrawal, because the issuer has already decided', () => {
    const r = build('passed', 'expired', 'revoked', 'past', 'matched', 'valid');
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
    // With no breakdown, the claim check in consistency-combinations.ts has
    // no rows to hold the prose to, so hold it to nothing: a verdict that
    // stopped here cannot reassure.
    const claims = `${out.headline} ${out.detail}`.toLowerCase();
    expect(claims, `${code} reassures with nothing behind it`).not.toMatch(CLAIMS_UNCHANGED);
    expect(claims, `${code} reassures with nothing behind it`).not.toMatch(CLAIMS_NOT_WITHDRAWN);
  });
});
