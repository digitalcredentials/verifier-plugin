import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyCredential } from '@digitalcredentials/verifier-core';
import { summarise, listChecks } from '../src/outcomes.js';
import { CHECK, PROBLEM, EXPIRED_MARKERS, TAMPERED_MARKERS } from '../src/types.js';
import type { VerificationResponse } from '../src/types.js';

/**
 * The tripwire under the one place this codebase reads a library's prose.
 *
 * verifier-core 2.x has no expiration check. An expired credential fails the
 * *signature* check carrying the same problem type and the same title as a
 * credential that was altered after issue, so the only thing separating "your
 * qualification ran out in January" from "someone changed this" is the
 * sentence in `detail`.
 *
 * `summarise()` confirms expiry against the credential's own end date rather
 * than trusting that sentence, and the markers in types.ts are a second route.
 * This file runs the real library over the real fixtures so that if either
 * wording moves, CI says so rather than a person quietly being told the wrong
 * thing about their credential.
 *
 * Delete all of it when verifier-core carries a distinct problem type for
 * expiry. Raised on verifier-core#32.
 *
 * No network: `registries: []` skips the registry lookup, the Open Badges
 * schema suite is left out, and did:key resolves locally.
 */

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../dev/fixtures/${name}.json`, import.meta.url), 'utf8'));

const verify = async (name: string): Promise<VerificationResponse> =>
  (await verifyCredential({
    credential: fixture(name),
    registries: [],
    verbose: true,
  })) as VerificationResponse;

const signatureOf = (r: VerificationResponse) =>
  (r.results ?? []).find((c) => c.id === CHECK.signature);

describe('what verifier-core reports for an expired credential', () => {
  it('fails the signature check, because there is no expiration check', async () => {
    const signature = signatureOf(await verify('expired'));
    expect(signature?.outcome.status).toBe('failure');
  });

  it('is indistinguishable from tampering by type or title', async () => {
    const expired = signatureOf(await verify('expired'))!.outcome;
    const tampered = signatureOf(await verify('tampered'))!.outcome;
    // If this assertion ever fails, upstream has started telling the two
    // apart — which is what we asked for. Read the new shape and delete the
    // prose matching rather than "fixing" this test.
    expect(expired.status === 'failure' && expired.problems[0]?.type).toBe(
      tampered.status === 'failure' && tampered.problems[0]?.type,
    );
    expect(expired.status === 'failure' && expired.problems[0]?.title).toBe(
      tampered.status === 'failure' && tampered.problems[0]?.title,
    );
    expect(expired.status === 'failure' && expired.problems[0]?.type).toBe(
      PROBLEM.invalidSignature,
    );
  });

  it('still carries a marker we recognise as expiry', async () => {
    const outcome = signatureOf(await verify('expired'))!.outcome;
    const detail = outcome.status === 'failure' ? (outcome.problems[0]?.detail ?? '') : '';
    expect(
      EXPIRED_MARKERS.some((m) => detail.includes(m)),
      `no EXPIRED_MARKERS matched "${detail}" — update types.ts`,
    ).toBe(true);
  });

  it('carries a different marker for a credential that was altered', async () => {
    const outcome = signatureOf(await verify('tampered'))!.outcome;
    const detail = outcome.status === 'failure' ? (outcome.problems[0]?.detail ?? '') : '';
    expect(
      TAMPERED_MARKERS.some((m) => detail.includes(m)),
      `no TAMPERED_MARKERS matched "${detail}" — update types.ts`,
    ).toBe(true);
    // The two must not both match the same sentence, or the distinction we
    // rest on collapses and every expired credential reads as altered.
    expect(EXPIRED_MARKERS.some((m) => detail.includes(m))).toBe(false);
  });
});

describe('what a person is told, end to end', () => {
  it('tells someone whose credential ran out that it expired, and names the date', async () => {
    const out = summarise(await verify('expired'));
    expect(out.code).toBe('expired');
    expect(out.severity).toBe('warning');
    expect(out.headline).toBe('Expired on 9 January 2026');
    expect(out.action).toContain('renewed');
    // The single worst answer available: telling someone whose qualification
    // merely ran out that it was altered after it was issued.
    expect(out.headline).not.toContain('changed');
  });

  it('tells someone whose credential was altered that it changed', async () => {
    const out = summarise(await verify('tampered'));
    expect(out.code).toBe('invalid_signature');
    expect(out.severity).toBe('error');
    expect(out.headline).toBe('This has been changed since it was issued');
  });

  it('agrees with the breakdown in both cases', async () => {
    const expired = await verify('expired');
    const rows = listChecks(expired);
    const dates = rows.find((c) => c.id === `${CHECK.signature}#dates`);
    expect(dates?.severity).toBe('warning');
    expect(dates?.value).toBe('expired on 9 January 2026');
    // The signature did not report a verdict of its own, so the row must not
    // claim one either way.
    expect(rows.find((c) => c.id === CHECK.signature)?.severity).toBe('unchecked');

    const tampered = listChecks(await verify('tampered'));
    expect(tampered.find((c) => c.id === CHECK.signature)?.severity).toBe('error');
  });
});
