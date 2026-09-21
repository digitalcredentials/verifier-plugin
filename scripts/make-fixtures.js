/**
 * Builds the test credentials the dev page and the browser tests use.
 *
 * These are really signed, by a key generated here from a fixed seed, so the
 * fixtures are reproducible and the signatures genuinely verify. That matters:
 * an expired credential has to have a *valid* signature, or it reads as
 * tampered instead of expired, and we'd be testing the wrong thing.
 *
 *   node scripts/make-fixtures.js
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as vc from '@digitalcredentials/vc';
import { Ed25519VerificationKey2020 } from '@digitalcredentials/ed25519-verification-key-2020';
import { Ed25519Signature2020 } from '@digitalcredentials/ed25519-signature-2020';
import { securityLoader } from '@digitalcredentials/security-document-loader';
import { createList, createCredential } from '@digitalcredentials/vc-bitstring-status-list';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'fixtures');

/**
 * Where the status list is served from while developing.
 *
 * Same origin as the dev page on purpose. Fetching a status list cross-origin
 * fails in a browser today (the CORS preflight problem that verifier-core
 * can't currently work around), so serving it from the dev server is the only
 * way to exercise the withdrawn and not-withdrawn states at all.
 */
const STATUS_LIST_URL = 'http://localhost:5180/fixtures/status-list.json';
const WITHDRAWN_INDEX = 42;
const LIST_LENGTH = 131072;

/** Fixed seed, so re-running produces the same issuer and the same fixtures. */
const SEED = new Uint8Array(32).fill(7);

const context = [
  'https://www.w3.org/ns/credentials/v2',
  'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.2.json',
];

const baseCredential = (issuerDid, overrides = {}) => ({
  '@context': context,
  id: `urn:uuid:${overrides.uuid ?? '9d1a7f2c-59b1-4f0a-9d5e-3a6c1b8e40f2'}`,
  type: ['VerifiableCredential', 'OpenBadgeCredential'],
  issuer: {
    id: issuerDid,
    type: ['Profile'],
    name: 'Springfield College',
    url: 'https://springfield.example.edu',
  },
  validFrom: '2026-03-12T10:00:00Z',
  credentialSubject: {
    type: ['AchievementSubject'],
    name: 'Sam Salmon',
    achievement: {
      id: 'urn:uuid:5c8b3d10-6f44-4e2a-8b6f-1d0c9a7e2b35',
      type: ['Achievement'],
      achievementType: 'Certificate',
      name: 'Requirements Analysis Certificate',
      description: 'Awarded for completing the requirements analysis programme.',
      criteria: { narrative: 'Completed all coursework and the final assessment.' },
    },
  },
  ...overrides.credential,
});

const main = async () => {
  await mkdir(OUT, { recursive: true });

  // A did:key is just the key's own fingerprint, so no resolver is needed to
  // build one — and the verifier resolves it the same way, with no lookup.
  const key = await Ed25519VerificationKey2020.generate({ seed: SEED });
  const fingerprint = key.fingerprint();
  const issuerDid = `did:key:${fingerprint}`;
  key.id = `${issuerDid}#${fingerprint}`;
  key.controller = issuerDid;

  const suite = new Ed25519Signature2020({ key });
  const documentLoader = securityLoader({ fetchRemoteContexts: true }).build();
  const sign = (credential) => vc.issue({ credential, suite, documentLoader });

  console.log(`issuer: ${issuerDid}\n`);

  const written = [];
  const write = async (name, doc, note) => {
    await writeFile(join(OUT, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
    written.push([name, note]);
  };

  // --- the status list itself, signed like any other credential -------------
  const list = await createList({ length: LIST_LENGTH });
  list.setStatus(WITHDRAWN_INDEX, true);
  const statusListCredential = await createCredential({
    id: STATUS_LIST_URL,
    list,
    statusPurpose: 'revocation',
  });
  statusListCredential.issuer = issuerDid;
  statusListCredential.validFrom = '2026-03-01T00:00:00Z';
  await write('status-list', await sign(statusListCredential), 'the signed withdrawal list');

  const statusEntry = (index) => ({
    credentialStatus: {
      id: `${STATUS_LIST_URL}#${index}`,
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListIndex: String(index),
      statusListCredential: STATUS_LIST_URL,
    },
  });

  // --- verified: everything passes, nothing to withdraw --------------------
  await write('verified', await sign(baseCredential(issuerDid)), 'signed, in date, no withdrawal list');

  // --- expired: a real signature over a date that has passed ---------------
  await write(
    'expired',
    await sign(
      baseCredential(issuerDid, {
        uuid: '1f4c7a20-8b31-4d6e-9a2f-5c8e3b7d1042',
        credential: { validFrom: '2024-01-09T10:00:00Z', validUntil: '2026-01-09T10:00:00Z' },
      }),
    ),
    'signed and valid, but past its end date',
  );

  // --- withdrawn: listed as revoked in the status list ---------------------
  await write(
    'withdrawn',
    await sign(
      baseCredential(issuerDid, {
        uuid: '3a9e1c44-7d52-4b8a-91c6-2f0d8e5a7b13',
        credential: statusEntry(WITHDRAWN_INDEX),
      }),
    ),
    `signed, and marked withdrawn at index ${WITHDRAWN_INDEX}`,
  );

  // --- not withdrawn: same list, an index that isn't set -------------------
  await write(
    'not-withdrawn',
    await sign(
      baseCredential(issuerDid, {
        uuid: '6c2b8f19-4e73-42d1-8a5f-9b3e1d07c264',
        credential: statusEntry(7),
      }),
    ),
    'signed, checked against the list, and not withdrawn',
  );

  // --- tampered: signed honestly, then altered -----------------------------
  const tampered = await sign(
    baseCredential(issuerDid, { uuid: '8e5d2a63-1c97-4f05-b3d8-7a49e6c2f018' }),
  );
  tampered.credentialSubject.name = 'Someone Else';
  await write('tampered', tampered, 'signed, then the name was changed');

  // --- no signature at all -------------------------------------------------
  await write('unsigned', baseCredential(issuerDid, { uuid: 'b17f3e58-6a24-4c9d-85b1-0e7c2f9a4d36' }),
    'never signed — no proof to check');

  // --- a registry that recognises our test issuer ---------------------------
  // Lets the dev page show the success state. Same shape as the real DCC
  // sandbox registry, served from the dev server.
  await write(
    'registry',
    {
      meta: {
        created: '2026-09-21T00:00:00Z',
        updated: '2026-09-21T00:00:00Z',
        note: 'Local development registry. Not a real one.',
      },
      registry: {
        [issuerDid]: {
          name: 'Springfield College',
          location: { country: 'US' },
          url: 'https://springfield.example.edu',
        },
      },
    },
    'a local registry that recognises the test issuer',
  );

  console.log('written to dev/fixtures/');
  for (const [name, note] of written) console.log(`  ${name.padEnd(15)} ${note}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
