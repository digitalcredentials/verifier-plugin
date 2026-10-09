import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BuiltinHttpGetService, verifyCredential } from '@digitalcredentials/verifier-core';
import { namingDidWebOutages } from '../src/verify.js';
import { summarise } from '../src/outcomes.js';
import { CHECK, PROBLEM } from '../src/types.js';
import type { VerificationResponse } from '../src/types.js';

/**
 * The stopgap for verifier-core#65: an issuer's website that won't serve its
 * did.json reads as unreachable, not as tampering.
 *
 * The end-to-end half runs the real library over two credentials from
 * vc-test-fixtures (main b3a0c3e, verifiableCredentials/v2/ed25519/didWeb):
 * did-web.json is oidf-noStatus-notExpired.json, and
 * did-web-unreachable.json is badDidWeb.json, whose issuer's did.json is
 * missing (404). did-web.did.json is the good one's did.json, downloaded
 * 8 October 2026. No network: every fetch is answered here.
 */

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const answer = (status: number, body: unknown = {}) => ({ body, headers: new Headers(), status });

const DID_JSON = 'https://issuer.example/dids/a/did.json';

describe('the wrapper', () => {
  it('passes every other address through, whatever its status', async () => {
    const wrapped = namingDidWebOutages({ get: async () => answer(404) });
    await expect(wrapped.get('https://issuer.example/status/1')).resolves.toMatchObject({ status: 404 });
  });

  it("leaves another address's failure as it was", async () => {
    const failure = new Error('down');
    const wrapped = namingDidWebOutages({
      get: async () => {
        throw failure;
      },
    });
    await expect(wrapped.get('https://issuer.example/status/1')).rejects.toBe(failure);
  });

  it('passes a did.json that loads through unchanged', async () => {
    const loaded = answer(200, { id: 'did:web:issuer.example:dids:a' });
    const wrapped = namingDidWebOutages({ get: async () => loaded });
    await expect(wrapped.get(DID_JSON)).resolves.toBe(loaded);
  });

  it('turns a did.json that answers an error into an HTTPError naming it', async () => {
    const wrapped = namingDidWebOutages({ get: async () => answer(404) });
    await expect(wrapped.get(DID_JSON)).rejects.toMatchObject({ name: 'HTTPError', requestUrl: DID_JSON });
  });

  it("turns a did.json that doesn't answer into an HTTPError, keeping the original", async () => {
    const failure = new Error(`Request to ${DID_JSON} failed`);
    const wrapped = namingDidWebOutages({
      get: async () => {
        throw failure;
      },
    });
    await expect(wrapped.get(DID_JSON)).rejects.toMatchObject({
      name: 'HTTPError',
      requestUrl: DID_JSON,
      cause: failure,
    });
  });
  // Decided, not overlooked: we didn't reach the key, and the fetcher's reasons
  // are only sentences. See namingDidWebOutages.
  it('turns a did.json the built-in fetcher refuses into an HTTPError too', async () => {
    const local = 'https://localhost/.well-known/did.json';
    const wrapped = namingDidWebOutages(BuiltinHttpGetService());
    await expect(wrapped.get(local)).rejects.toMatchObject({ name: 'HTTPError', requestUrl: local });
  });
});

describe('through the real library', () => {
  /** Answers the issuer's did.json as `did` says; any other request fails the test. */
  const verify = async (
    credential: Record<string, unknown>,
    did: (url: string) => Promise<ReturnType<typeof answer>>,
  ) =>
    (await verifyCredential({
      credential,
      registries: [],
      verbose: true,
      httpGetService: namingDidWebOutages({
        get: async (url) => {
          if (url.endsWith('/did.json')) return did(url);
          throw new Error(`unexpected fetch in a test: ${url}`);
        },
      }),
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
