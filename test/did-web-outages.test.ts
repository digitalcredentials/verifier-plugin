import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyCredential } from '@digitalcredentials/verifier-core';
import { summarise } from '../src/outcomes.js';
import { CHECK, PROBLEM } from '../src/types.js';
import type { VerificationResponse } from '../src/types.js';

/**
 * An issuer's website that won't serve its did.json reads as unreachable, not
 * as tampering. verify.ts carried a stopgap for this until verifier-core
 * fixed it (#65, in 2.0.0-beta.1); these now run the library unaided.
 *
 * They run the real library over two credentials from
 * vc-test-fixtures (main b3a0c3e, verifiableCredentials/v2/ed25519/didWeb):
 * did-web.json is oidf-noStatus-notExpired.json, and
 * did-web-unreachable.json is badDidWeb.json, whose issuer's did.json is
 * missing (404). did-web.did.json is the good one's did.json, downloaded
 * 8 October 2026. No network: every fetch is answered here.
 */

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const answer = (status: number, body: unknown = {}) => ({ body, headers: new Headers(), status });

describe('through the real library', () => {
  /** Answers the issuer's did.json as `did` says; any other request fails the test. */
  const verify = async (
    credential: Record<string, unknown>,
    did: (url: string) => Promise<ReturnType<typeof answer>>,
  ) =>
    (await verifyCredential({
      credential,
      registries: [],
      httpGetService: {
        get: async (url) => {
          if (url.endsWith('/did.json')) return did(url);
          throw new Error(`unexpected fetch in a test: ${url}`);
        },
      },
    })) as VerificationResponse;

  const signature = (response: VerificationResponse) =>
    response.results.find((r) => r.id === CHECK.signature)?.outcome;

  const missing = async () => answer(404, 'Not Found');
  const down = async (url: string): Promise<never> => {
    throw new Error(`Request to ${url} failed`);
  };
  const served = async () => answer(200, fixture('did-web.did'));

  it('an issuer whose did.json is missing reads as unreachable, not tampered', async () => {
    const response = await verify(fixture('did-web-unreachable'), missing);
    expect(signature(response)?.problems?.map((p) => p.type)).toEqual([PROBLEM.didWebUnresolved]);
    const outcome = summarise(response, {});
    expect(outcome.code).toBe('did_web_unresolved');
    expect(outcome.severity).toBe('unchecked');
    expect(outcome.headline).not.toContain('tampered');
  });

  it("an issuer whose site doesn't answer reads as unreachable too", async () => {
    const response = await verify(fixture('did-web'), down);
    expect(signature(response)?.problems?.map((p) => p.type)).toEqual([PROBLEM.didWebUnresolved]);
    expect(summarise(response, {}).code).toBe('did_web_unresolved');
  });

  it('a did:web credential whose issuer answers still verifies', async () => {
    const response = await verify(fixture('did-web'), served);
    expect(signature(response)?.status).toBe('success');
  });

  it('a tampered did:web credential still reads as tampered', async () => {
    const tampered = { ...fixture('did-web'), name: 'Changed after issuing' };
    const response = await verify(tampered, served);
    expect(signature(response)?.problems?.map((p) => p.type)).toEqual([PROBLEM.invalidSignature]);
    expect(summarise(response, {}).code).toBe('invalid_signature');
  });
});
