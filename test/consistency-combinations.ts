import { describe, it, expect, afterEach } from 'vitest';
import { summarise, listChecks, hasStatusList, issuerIdentity } from '../src/outcomes.js';
import { CHECK, PROBLEM, STATUS_LIST_PROBLEM_PREFIX } from '../src/types.js';
import type { VerificationResponse, CheckResult } from '../src/types.js';

/**
 * How a verdict says the credential is unchanged, or not withdrawn — one list,
 * used by every check below and in consistency.test.ts, so a phrasing caught
 * in one place is caught in all of them.
 *
 * Broad on purpose: a reassurance reworded to echo the Tampering row ("no
 * tampering detected") is still a reassurance. The old "changed since it was
 * issued" phrasings stay, because a claim written the old way is still a
 * claim. "Genuine" counts unless it is asked about — "we can't tell if this is
 * genuine" is the opposite of a claim, and dropping the word instead would
 * stop this seeing "Genuine, but we can't confirm who issued it".
 */
export const CLAIMS_UNCHANGED =
  /(?<!\b(?:if|whether) (?:this|it) is )\b(?:genuine|authentic)\b|n['’]t been (?:tampered|changed|altered|modified)|\bnot been (?:tampered|changed|altered|modified)|was(?:n['’]t| not) (?:tampered|changed|altered|modified)|\bun(?:tampered|altered|modified|changed)\b|\bintact\b|\bno tampering\b|\bnothing has changed/;
// The earner reads "deactivated" now (8 October 2026), so that counts too,
// however the object is put ("it", "this copy"). "Still active" counts
// unless it is asked about: "We couldn't check whether this copy is still
// active" is the opposite of a claim, as with "genuine" above.
export const CLAIMS_NOT_WITHDRAWN =
  /n['’]t (?:been )?(?:withdrawn|revoked|cancelled|deactivated)\b|\bnot (?:been )?(?:withdrawn|revoked|cancelled|deactivated)\b|\bstill valid\b|(?<!whether (?:this|it|this copy) is )\bstill active\b/;

/**
 * Comfort where we don't know (James, 13 October 2026): a "couldn't check"
 * that leans positive gets read as "close enough". It may state what did
 * check out ("It hasn't been tampered with"); CLAIMS_UNCHANGED holds that to
 * the signature row. What it may not do is reassure about what didn't.
 */
export const LEANS_POSITIVE =
  /\b(?:might|may|could|should|probably|likely) (?:still )?be (?:valid|fine|ok(?:ay)?|genuine|good|real|authentic)\b|\b(?:nothing|anything)(?:['’]s| is)? wrong\b|\bno problem with (?:it|this|your credential|the credential)\b|not with your credential|doesn['’]t (?:necessarily |always )?mean (?:it|the credential|this|anything)\b|\bprobably fine\b|\bdon['’]t worry\b/;

/**
 * The headline and the breakdown must never contradict each other.
 *
 * Both code reviews of this file found the same shape of bug: `summarise()`
 * saying one thing while `listChecks()` said another about the same
 * credential. Once it was a green "Verified" above rows reporting the issuer
 * was in no registry; once it was "Verified" above a signature row reading
 * "not checked". A person who opens the details and finds them disagreeing
 * with the verdict has no way to know which to believe.
 *
 * So rather than test the instances, this walks every combination of check
 * results and asserts the two can never disagree — including after both of us
 * have stopped looking at this code.
 *
 * Ported to verifier-core 2.x. The review of that migration found this file
 * switched off and the port not done, and four of its twelve findings were
 * contradictions this would have caught — most sharply a `warning` "Expired"
 * headline above an `error` row reading "withdrawn by the issuer".
 */

/**
 * Every way the signature check can end. Since verifier-core #59 a key that
 * isn't the issuer's has its own problem type, apart from tampering.
 */
type Sig = 'passed' | 'tampered' | 'key_mismatch' | 'unattributable' | 'missing';
/**
 * The validity period, a check of its own since 2.0.0-beta.1: before, the
 * dates were judged inside the signature check. The end date stays a
 * dimension of its own too, because the headline names it and must not
 * invent an expiry the library didn't report.
 */
type Val = 'in_date' | 'expired' | 'not_yet_valid' | 'errored' | 'halted' | 'missing';
/**
 * `unreadable`: a status type the library does not recognise, so it skips.
 * `+other`: the list loaded and was read, but the issuer didn't sign it — the
 * status check's own result is untouched, and a second check reports it,
 * after a mark as well as after a pass since 2.0.0-beta.1.
 * `+errored`: the list was read, but the check comparing its signer threw,
 * so nothing is confirmed either way. Not the same as `+other`: strict, it
 * reads "we couldn't finish that check", not "may not be from the issuer".
 */
type Rev =
  | 'passed'
  | 'revoked'
  | 'suspended'
  | 'passed+other'
  | 'revoked+other'
  | 'suspended+other'
  | 'passed+errored'
  | 'revoked+errored'
  | 'suspended+errored'
  | 'list_error'
  | 'none'
  | 'unreadable'
  | 'halted';
type End = 'in_date' | 'past';
/**
 * `errored` and `skipped` are the cases the 2.x migration got wrong: a lookup
 * that threw, or never ran, is not a confirmed "not in any registry".
 * `unreachable` is some registries answering, none listing the issuer, and
 * others not; `none_reached` is every registry down. The library reports
 * them differently (checked 10 October 2026), and so does the card.
 */
type Iss =
  | 'matched'
  | 'unlisted'
  | 'unreachable'
  | 'none_reached'
  | 'matched+unreachable'
  | 'errored'
  | 'skipped'
  | 'halted';
type Sch = 'valid' | 'invalid' | 'no_schema' | 'unavailable' | 'missing' | 'halted';
/**
 * `halted`: skipped because an earlier check failed fatally. verifier-core
 * stops after a failed signature, so after it none of these run. Expiry and
 * a withdrawal are fatal too, but don't stop anything.
 */
const NOT_RUN = 'Not run: proof.signature failed';

const SIGNATURES: Sig[] = ['passed', 'tampered', 'key_mismatch', 'unattributable', 'missing'];
const VALIDITIES: Val[] = ['in_date', 'expired', 'not_yet_valid', 'errored', 'halted', 'missing'];
const REVOCATIONS: Rev[] = [
  'passed',
  'revoked',
  'suspended',
  'passed+other',
  'revoked+other',
  'suspended+other',
  'passed+errored',
  'revoked+errored',
  'suspended+errored',
  'list_error',
  'none',
  'unreadable',
  'halted',
];
const ENDS: End[] = ['in_date', 'past'];
const ISSUERS: Iss[] = [
  'matched',
  'unlisted',
  'unreachable',
  'none_reached',
  'matched+unreachable',
  'errored',
  'skipped',
  'halted',
];
const SCHEMAS: Sch[] = ['valid', 'invalid', 'no_schema', 'unavailable', 'missing', 'halted'];

export const check = (id: string, outcome: CheckResult['outcome'], fatal = false): CheckResult => ({
  id,
  suite: id.split('.').slice(1, 2)[0]!,
  outcome,
  fatal,
});

const PAST = '2026-01-09T10:00:00Z';
const FUTURE = '2099-01-09T10:00:00Z';

const signatureCheck = (sig: Sig): CheckResult | undefined => {
  switch (sig) {
    case 'missing':
      return undefined;
    case 'passed':
      return check(CHECK.signature, { status: 'success', message: 'Signature verified.' }, true);
    case 'tampered':
      return check(
        CHECK.signature,
        {
          status: 'failure',
          problems: [
            { type: PROBLEM.invalidSignature, title: 'Invalid Signature', detail: 'Invalid signature.' },
          ],
        },
        true,
      );
    case 'key_mismatch':
      return check(
        CHECK.signature,
        {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.verificationMethod,
              title: 'Verification Method Error',
              detail: 'The credential issuer did:key:z6Mkn does not control the verification method.',
            },
          ],
        },
        true,
      );
    case 'unattributable':
      return check(
        CHECK.signature,
        {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.proofVerification,
              title: 'No Applicable Crypto Service',
              detail: 'No registered crypto service can verify this subject.',
            },
          ],
        },
        true,
      );
  }
};

const validityCheck = (val: Val): CheckResult | undefined => {
  switch (val) {
    case 'missing':
      return undefined;
    case 'halted':
      return check(CHECK.validityPeriod, { status: 'skipped', reason: NOT_RUN }, true);
    // A check that throws comes back as a failure naming no date.
    case 'errored':
      return check(
        CHECK.validityPeriod,
        {
          status: 'failure',
          problems: [
            {
              type: 'https://www.w3.org/TR/vc-data-model#CHECK_ERROR',
              title: 'Check Error',
              detail: 'Check "proof.validity-period" threw: x',
            },
          ],
        },
        true,
      );
    case 'in_date':
      return check(
        CHECK.validityPeriod,
        { status: 'success', message: 'The credential is within its validity period.' },
        true,
      );
    case 'expired':
      return check(
        CHECK.validityPeriod,
        {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.credentialExpired,
              title: 'Credential Expired',
              detail: `The current date time (2026-09-23T00:00:00Z) is after "validUntil" (${PAST}).`,
            },
          ],
        },
        true,
      );
    case 'not_yet_valid':
      return check(
        CHECK.validityPeriod,
        {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.credentialNotYetValid,
              title: 'Credential Not Yet Valid',
              detail: `The current date time (2026-09-23T00:00:00Z) is before "validFrom" (${FUTURE}).`,
            },
          ],
        },
        true,
      );
  }
};

const revocationCheck = (rev: Rev): CheckResult | undefined => {
  switch (rev) {
    case 'passed+other':
      return revocationCheck('passed');
    case 'revoked+other':
      return revocationCheck('revoked');
    case 'suspended+other':
      return revocationCheck('suspended');
    case 'passed+errored':
      return revocationCheck('passed');
    case 'revoked+errored':
      return revocationCheck('revoked');
    case 'suspended+errored':
      return revocationCheck('suspended');
    case 'halted':
      return check(CHECK.status, { status: 'skipped', reason: NOT_RUN });
    case 'suspended':
      return check(CHECK.status, {
        status: 'failure',
        problems: [
          { type: PROBLEM.suspended, title: 'Credential Suspended', detail: 'The credential has been suspended.' },
        ],
      });
    case 'none':
      return check(CHECK.status, {
        status: 'skipped',
        reason: 'Credential has no credentialStatus.',
      });
    case 'unreadable':
      return check(CHECK.status, {
        status: 'skipped',
        reason: 'Status type "StatusList2021Entry" is not BitstringStatusListEntry.',
      });
    case 'passed':
      return check(CHECK.status, {
        status: 'success',
        message: 'Credential status is valid (not revoked or suspended).',
      });
    case 'revoked':
      return check(CHECK.status, {
        status: 'failure',
        problems: [
          {
            type: PROBLEM.revoked,
            title: 'Credential Revoked',
            detail: 'The credential has been revoked.',
          },
        ],
      });
    case 'list_error':
      return check(CHECK.status, {
        status: 'failure',
        problems: [
          {
            type: `${STATUS_LIST_PROBLEM_PREFIX}NOT_FOUND`,
            title: 'Status List Not Found',
            detail: 'The status list could not be fetched.',
          },
        ],
      });
  }
};

const registryCheck = (iss: Iss): CheckResult | undefined => {
  const unchecked = '1 registries could not be checked: Second Registry';
  // What the lookup found, as the library also gives it: as data.
  const payload = (matched: boolean, unreached: boolean) => ({
    matches: matched ? [{ registry: { name: 'DCC Registry', type: 'dcc-legacy' } }] : [],
    uncheckedRegistries: unreached ? [{ name: 'Second Registry', type: 'dcc-legacy' }] : [],
  });
  switch (iss) {
    case 'halted':
      return check(CHECK.registeredIssuer, { status: 'skipped', reason: NOT_RUN });
    case 'skipped':
      return check(CHECK.registeredIssuer, {
        status: 'skipped',
        reason: 'No registries configured in verification context.',
      });
    case 'matched':
      return check(CHECK.registeredIssuer, {
        status: 'success',
        message: 'Issuer found in registry: DCC Registry',
        payload: payload(true, false),
      });
    case 'matched+unreachable':
      return check(CHECK.registeredIssuer, {
        status: 'success',
        message: `Issuer found in registry: DCC Registry. ${unchecked}`,
        payload: payload(true, true),
      });
    case 'unlisted':
      return check(CHECK.registeredIssuer, {
        status: 'failure',
        problems: [
          {
            type: PROBLEM.issuerNotRegistered,
            title: 'Issuer Not Registered',
            detail: 'Issuer did:key:z6Mkn was not found in any known DID registry.',
          },
        ],
        payload: payload(false, false),
      });
    case 'unreachable':
      return check(CHECK.registeredIssuer, {
        status: 'failure',
        problems: [
          {
            type: PROBLEM.issuerNotRegistered,
            title: 'Issuer Not Registered',
            detail: 'Issuer did:key:z6Mkn was not found in any known DID registry.',
          },
          { type: PROBLEM.registryUnchecked, title: 'Registry Unchecked', detail: unchecked },
        ],
        payload: payload(false, true),
      });
    case 'none_reached':
      return check(CHECK.registeredIssuer, {
        status: 'failure',
        problems: [
          {
            type: PROBLEM.registryUnchecked,
            title: 'Registry Unchecked',
            detail: `Issuer registration could not be determined: ${unchecked}`,
          },
        ],
        payload: payload(false, true),
      });
    case 'errored':
      return check(CHECK.registeredIssuer, {
        status: 'failure',
        problems: [
          {
            type: 'https://www.w3.org/TR/vc-data-model#REGISTRY_ERROR',
            title: 'Registry Error',
            detail: 'Registry lookup failed.',
          },
        ],
      });
  }
};

const schemaCheck = (sch: Sch): CheckResult | undefined => {
  switch (sch) {
    case 'halted':
      return check(CHECK.schema, { status: 'skipped', reason: NOT_RUN });
    case 'missing':
      return undefined;
    case 'valid':
      return check(CHECK.schema, { status: 'success', message: 'Schema validation passed.' });
    case 'invalid':
      return check(CHECK.schema, {
        status: 'failure',
        problems: [
          {
            type: PROBLEM.schemaValidationFailed,
            title: 'Schema Validation Failed',
            detail:
              "Schema validation failed for https://purl.imsglobal.org/x.json: /credentialSubject/achievement: must have required property 'id'",
          },
        ],
      });
    case 'no_schema':
      return check(CHECK.schema, {
        status: 'skipped',
        reason:
          'Credential does not appear to be an OBv3 credential (OpenBadgeCredential or EndorsementCredential).',
      });
    case 'unavailable':
      return check(CHECK.schema, {
        status: 'skipped',
        reason: 'No verifiable credential found in subject.',
      });
  }
};

export const build = (sig: Sig, val: Val, rev: Rev, end: End, iss: Iss, sch: Sch): VerificationResponse => {
  const results = [
    // The four core checks pass throughout: a failure among them is
    // "it stopped", which has its own describe block in consistency.test.ts.
    check(CHECK.contextExists, { status: 'success', message: 'ok' }, true),
    check(CHECK.vcContext, { status: 'success', message: 'ok' }, true),
    check(CHECK.credentialId, { status: 'success', message: 'ok' }, true),
    check(CHECK.proofExists, { status: 'success', message: 'ok' }, true),
    signatureCheck(sig),
    validityCheck(val),
    revocationCheck(rev),
    // The library compares the list's signer for every list it read, and
    // reports a pass for the issuer's own. `+errored`: the comparison itself
    // threw, so it confirms nothing either way.
    ISSUERS_OWN_LIST.includes(rev)
      ? check(CHECK.statusListIssuer, { status: 'success', message: 'The status list was issued by the credential issuer.' })
      : rev.endsWith('+errored')
      ? check(CHECK.statusListIssuer, {
          status: 'failure',
          problems: [
            { type: 'https://www.w3.org/TR/vc-data-model#CHECK_ERROR', title: 'Check Error', detail: 'Check "status.list-issuer" threw: x' },
          ],
        })
      : rev.endsWith('+other')
      ? check(CHECK.statusListIssuer, {
          status: 'failure',
          problems: [
            {
              type: PROBLEM.statusListIssuerMismatch,
              title: 'Status List Issuer Mismatch',
              detail: 'The status list was issued by did:key:z6Mkother, not the credential issuer did:key:z6Mkn.',
            },
          ],
        })
      : undefined,
    registryCheck(iss),
    schemaCheck(sch),
  ].filter((c): c is CheckResult => c !== undefined);

  return {
    verified: results.every((c) => c.outcome.status !== 'failure'),
    verifiableCredential: {
      issuer: { id: 'did:key:z6Mkn', name: 'Springfield College' },
      validUntil: end === 'past' ? PAST : FUTURE,
      validFrom: val === 'not_yet_valid' ? FUTURE : '2025-01-09T10:00:00Z',
      // "none" means the issuer never set up a way to withdraw it at all.
      ...(rev === 'none' ? {} : { credentialStatus: { type: 'BitstringStatusListEntry' } }),
    },
    results,
  };
};

/**
 * Whether the host said it couldn't get its list of registries. Every
 * combination runs both ways: the flag only matters to a lookup that never
 * answered, and must not open a contradiction anywhere else either.
 */
const HOST_LIST: ('loaded' | 'unavailable')[] = ['loaded', 'unavailable'];

/**
 * Whose withdrawal lists are believed. `any` is the default; `issuers` is
 * `requireIssuerSignedStatusList`, the stricter rule kept for when DCC's
 * issuers sign their own lists. Every list that was read runs both ways: a
 * list someone else signed, or whose signer couldn't be confirmed, where it
 * matters, and the issuer's own, where it must change nothing.
 */
type Lists = 'any' | 'issuers';
/** Lists the issuer signed, as the library reports them: read, and the signer confirmed. */
const ISSUERS_OWN_LIST: Rev[] = ['passed', 'revoked', 'suspended'];
/** Lists read, whose signer the library reported as someone else, or couldn't confirm. */
const notConfirmedOwn = (rev: Rev): boolean => rev.endsWith('+other') || rev.endsWith('+errored');
const listsFor = (rev: Rev): Lists[] =>
  ISSUERS_OWN_LIST.includes(rev) || notConfirmedOwn(rev) ? ['any', 'issuers'] : ['any'];

/**
 * A check is only ever skipped as "not run" because one before it failed
 * fatally and halted: since 2.0.0-beta.1 that is the signature, for
 * everything after it. Expiry and the withdrawal check are fatal but halt
 * nothing. A `halted` check with no failed signature ahead of it is a
 * contradiction in the input, not a combination the rules owe an answer to,
 * so it is left out — everything else, possible or not, stays in.
 */
const SIG_FATAL: Sig[] = ['tampered', 'key_mismatch', 'unattributable'];
const coherent = (sig: Sig, val: Val, rev: Rev, iss: Iss, sch: Sch): boolean =>
  SIG_FATAL.includes(sig) || ![val, rev, iss, sch].includes('halted');

export const cases = SIGNATURES.flatMap((sig) =>
  VALIDITIES.flatMap((val) =>
    REVOCATIONS.flatMap((rev) =>
      ENDS.flatMap((end) =>
        ISSUERS.flatMap((iss) =>
          SCHEMAS.filter((sch) => coherent(sig, val, rev, iss, sch)).flatMap((sch) =>
            HOST_LIST.flatMap((list) =>
              listsFor(rev).map((lists) => ({
                sig,
                val,
                rev,
                end,
                iss,
                sch,
                list,
                lists,
                name: `${sig}/${val}/${rev}/${end}/${iss}/${sch}/${list}${lists === 'issuers' ? '/issuers-lists-only' : ''}`,
              })),
            ),
          ),
        ),
      ),
    ),
  ),
);

const DATES_ROW = CHECK.validityPeriod;

/**
 * Open Badges 3.0 requires an issuer's id and type, not its name, so a genuine
 * credential can give no name at all. The verdict then says "the issuer":
 * "Ask did:key:z6Mk… for a current copy" isn't something the earner can act
 * on. The Issuer row may show the identifier; it is labelled, not a sentence.
 */
const NAMELESS: [string, unknown][] = [
  ['only an identifier', 'did:key:z6Mkn'],
  ['an identifier and no name', { id: 'did:key:z6Mkn' }],
  ['an empty name', { id: 'did:key:z6Mkn', name: '' }],
  ['a blank name', { id: 'did:key:z6Mkn', name: '  ' }],
  ['neither a name nor an identifier', {}],
];

/**
 * Run in parts, one file each (consistency-1.test.ts onwards), each taking
 * every PARTS-th combination, so the files run side by side.
 *
 * Two Vitest limits apply here whatever the results. A test worker fails the
 * run, with every test passing ("Timeout calling onTaskUpdate"), when a
 * message to the main Vitest process waits 60 seconds for its reply to be
 * read, and tests that never wait never read one: as one file this suite
 * passed in 34 s on one CI run and failed at 70 s on the next (22 October
 * 2026). The pause after each test below lets the worker read its replies
 * however long a file runs; a part slowed to 74 s passes with it and fails
 * without. And any one test fails past 5 seconds, so the nameless-issuer
 * tests, which loop, are given longer.
 *
 * Each part takes its number from its file's name, so no two files can run
 * the same part; consistency.test.ts checks that every part has its file.
 */
export const PARTS = 4;

export const agreementTests = (file: string): void => {
  const part = Number(/\/consistency-([1-9]\d*)\.test\.ts$/.exec(file)?.[1]);
  if (!(part >= 1 && part <= PARTS)) throw new Error(`${file} is not one of consistency-1.test.ts to -${PARTS}`);
  const slice = cases.filter((_, i) => i % PARTS === part - 1);
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
  describe(`the headline and the breakdown agree (part ${part} of ${PARTS}: ${slice.length} of ${cases.length} combinations)`, () => {
    it.each(slice)('$name', ({ sig, val, rev, end, iss, sch, list, lists, name }) => {
      const r = build(sig, val, rev, end, iss, sch);
      const options = { registriesUnavailable: list === 'unavailable', requireIssuerSignedStatusList: lists === 'issuers' };
      const out = summarise(r, options);
      const rows = listChecks(r, options);
      const row = (id: string) => rows.find((c) => c.id === id);
      const where = `${name} → ${out.code}`;

      expect(rows.length, `${where}: verification ran, so there must be rows`).toBeGreaterThan(0);

      // By default a list someone else signed is read like the issuer's own:
      // the same headline and the same rows as without the mismatch, whatever
      // the list said and whatever else happened.
      if (lists === 'any' && notConfirmedOwn(rev)) {
        const own = build(sig, val, rev.replace(/\+(other|errored)$/, '') as Rev, end, iss, sch);
        expect(out, `${where}: reads differently from the issuer's own list`).toEqual(summarise(own, options));
        expect(rows, `${where}: rows differ from the issuer's own list`).toEqual(listChecks(own, options));
      }

      // With only the issuer's own lists believed, the issuer's own reads just
      // as it does by default.
      if (lists === 'issuers' && ISSUERS_OWN_LIST.includes(rev)) {
        const loose = { ...options, requireIssuerSignedStatusList: false };
        expect(out, `${where}: refused the issuer's own list`).toEqual(summarise(r, loose));
        expect(rows, `${where}: refused the issuer's own list`).toEqual(listChecks(r, loose));
      }

      // With only the issuer's own lists believed, a list someone else signed
      // settles nothing either way: not "deactivated", not "on hold", not "the
      // issuer hasn't deactivated it".
      if (lists === 'issuers' && notConfirmedOwn(rev)) {
        expect(['withdrawn', 'suspended'], `${where}: believed a list the issuer didn't sign`).not.toContain(out.code);
        expect(row(CHECK.status)?.severity, `${where}: the Status row believed a list the issuer didn't sign`).toBe('unchecked');
        expect(`${out.headline} ${out.detail}`, `${where}: believed a list the issuer didn't sign`).not.toMatch(
          /hasn['’]t (?:withdrawn|deactivated)/,
        );
        // ...and says why in the right words: a stranger's list is "may not be
        // from the issuer"; a signer nobody could confirm is an unfinished
        // check, not a stranger, and retrying may well work.
        const stranger = rev.endsWith('+other');
        if (out.code === 'withdrawal_unknown') {
          expect(out.detail, `${where}: the wrong reason`).toMatch(
            stranger ? /may not be from the issuer/ : /couldn't finish that check/,
          );
          // ...and the right thing to do: tell the issuer about their list, or
          // try again later.
          expect(out.action, `${where}: the wrong action`).toMatch(
            stranger ? /^Let .+ know we couldn't check whether this copy is still active\.$/ : /^Try again in a little while\.$/,
          );
        }
        // Only behind a seal that held: behind a broken one the Status row is
        // about the seal, and reads "not checked" whatever the list said
        // (verifier-plugin#32).
        if (row(CHECK.signature)?.severity === 'success') {
          expect(row(CHECK.status)?.value, `${where}: the wrong Status row`).toBe(
            stranger ? "couldn't check — the information we found may not be from the issuer" : 'not checked',
          );
        }
      }

      // A clean verdict cannot sit above a row reporting a problem.
      if (out.severity === 'success') {
        for (const c of rows) {
          // Two agreed exceptions, and they are the same exception twice:
          // nothing failed and there was nothing to try, so the row carries no
          // information while the verdict is still a pass. Both stay visible
          // for an issuer debugging their own badge, who otherwise cannot tell
          // "nothing to check against" apart from "checked and clean".
          const noWithdrawalList = c.id === CHECK.status && !hasStatusList(r);
          // Unlike the signature, the schema check never establishes that the
          // credential is authentic — it only reports how it was assembled. Not
          // having one therefore does not undermine a pass the way an unchecked
          // signature would, and must not drag the headline down to "we
          // couldn't check this right now".
          const noSchemaToCheck = c.id === CHECK.schema && sch !== 'valid';
          if (noWithdrawalList || noSchemaToCheck) {
            expect(c.severity, `${where}: "${c.label}" under a pass`).toBe('unchecked');
            continue;
          }
          expect(c.severity, `${where}: "${c.label}" is ${c.severity} under a pass`).toBe('success');
        }
      }

      // ...and a row reporting a problem cannot sit under a clean verdict.
      const worst = rows.map((c) => c.severity);
      if (worst.includes('error')) {
        expect(out.severity, `${where}: a row is an error`).toBe('error');
      }
      if (out.severity === 'error') {
        expect(worst, `${where}: an error verdict needs an error row`).toContain('error');
      }
      if (out.severity === 'warning') {
        expect(worst, `${where}: a warning verdict needs a warning row`).toContain('warning');
      }
      // A row must never report something more serious than the headline.
      // "We couldn't check whether this was withdrawn" sitting above a row
      // that says the credential was built wrong buries a definite finding
      // under an unknown — the same bug as a pass above a problem, one tier
      // down, and the tier the schema row newly made reachable.
      if (out.severity === 'unchecked') {
        expect(worst, `${where}: a warning row under an unchecked verdict`).not.toContain('warning');
      }

      // A verdict must not claim in prose what the breakdown says was never
      // checked. This is the one contradiction severities cannot see: both
      // sides read "unchecked" and agree perfectly, while the sentence above
      // them asserts the credential is genuine. Three separate bugs have now
      // been this same sentence, so the rule is written once, for the claim,
      // rather than a third time for the instance.
      const claims = `${out.headline} ${out.detail}`.toLowerCase();

      // The earner never reads a registry's name, or the word: to them it is
      // "our list of known issuers" (James, 1 October 2026). Every verdict and
      // every row, in every combination.
      const earnerProse = [out.headline, out.detail, out.action ?? '', ...rows.map((c) => c.value)].join(' ');
      if (out.severity === 'unchecked') {
        expect(earnerProse.toLowerCase(), `${where}: leans positive where we don't know`).not.toMatch(LEANS_POSITIVE);
      }
      expect(earnerProse, `${where}: names a registry to the earner`).not.toMatch(/registry|registries/i);

      // When the verdict blames the list, the Issuer row has to be about the
      // list too — not the seal. Both read "unchecked", so severities can't see
      // the two giving different reasons.
      if (out.code === 'registry_unreachable') {
        // "Lists", plural, where part of it didn't respond.
        expect(row(CHECK.registeredIssuer)?.value, `${where}: the verdict blames the list, the row doesn't`).toMatch(
          /lists? of known issuers/,
        );
        // ...and for the same reason. "Didn't load" above "couldn't finish
        // checking" gives two accounts of one failure, and a host that says its
        // list was unavailable made that pairing reachable from a second route.
        // The words follow the state, not the other way round.
        expect(/didn't respond/.test(out.detail), `${where}: "didn't respond" without part of the list unreached`).toBe(
          issuerIdentity(r, options).registriesPartlyReached,
        );
        const reason = /didn't respond/.test(out.detail)
          ? "didn't respond"
          : /didn't load/.test(out.detail)
            ? "couldn't load our list"
            : "couldn't finish checking";
        expect(row(CHECK.registeredIssuer)?.value, `${where}: the verdict and the row give different reasons`).toContain(
          reason,
        );
      }

      // The same for the Status row: when the verdict says we couldn't check
      // whether the copy is still active, the row gives the same reason. "Not
      // checked" is the row agreed for "we couldn't finish that check" (see
      // outcomes.test.ts, "reads the same way in the breakdown"). A verdict with
      // none of the three reasons fails, rather than matching by default.
      if (out.code === 'withdrawal_unknown') {
        const reasons: [RegExp, string][] = [
          [/may not be from the issuer/, "couldn't check — the information we found may not be from the issuer"],
          [/couldn't get reliable status information/, "couldn't check — no reliable status information"],
          [/couldn't finish that check/, 'not checked'],
        ];
        const expected = reasons.find(([said]) => said.test(out.detail))?.[1];
        expect(expected, `${where}: a reason this rule doesn't know: "${out.detail}"`).toBeDefined();
        expect(row(CHECK.status)?.value, `${where}: the verdict and the Status row give different reasons`).toBe(expected);
      }

      // Dates the seal vouched for but nobody checked leave only verdicts that
      // outrank them: a finding, or an unknown about the withdrawal list. Not
      // "Verified", and not one about who issued it. Both rows read "unchecked"
      // there, so severities can't see it. Listed by what is allowed, so a new
      // or reordered verdict fails here rather than slipping past.
      if (row(CHECK.signature)?.severity === 'success' && row(DATES_ROW)?.severity === 'unchecked') {
        expect(
          ['dates_unchecked', 'withdrawn', 'suspended', 'malformed', 'withdrawal_unknown'],
          `${where}: the dates went unchecked`,
        ).toContain(out.code);
      }

      // A date is a finding only behind a seal that held: otherwise it is the
      // credential's own claim. The library halts after a failed seal, but the
      // rule must not depend on that.
      if (out.code === 'expired' || out.code === 'not_yet_valid') {
        expect(row(CHECK.signature)?.severity, `${where}: a date reported without the seal`).toBe('success');
      }

      // ...and the Dates and Status rows say the same: no date and no status
      // at all behind a seal that didn't hold — not "in date", not "not
      // deactivated", and not "no way to deactivate this", which removing a
      // credential's status entry would otherwise buy.
      if (row(CHECK.signature)?.severity !== 'success') {
        expect(row(DATES_ROW)?.value, `${where}: the Dates row behind an unheld seal`).toBe('not checked');
        expect(row(CHECK.status)?.value, `${where}: the Status row behind an unheld seal`).toBe('not checked');
      }

      // Only the library says a credential has run out. An end date in the
      // past that it didn't report must not become an "Expired" headline: our
      // clock second-guessing its own is what this rules out.
      if (val !== 'expired') {
        expect(out.code, `${where}: an expiry the library didn't report`).not.toBe('expired');
      }
      // And no verdict but "Expired" talks of expiry, whatever was reported.
      if (out.code !== 'expired') {
        expect(`${out.headline} ${out.detail} ${out.action ?? ''}`, `${where}: talks of expiry under ${out.code}`).not.toMatch(
          /expir|run out|end date|renew/i,
        );
      }

      if (CLAIMS_UNCHANGED.test(claims)) {
        expect(
          row(CHECK.signature)?.severity,
          `${where}: claims the credential is unchanged, but the signature row says "${row(CHECK.signature)?.value}"`,
        ).toBe('success');
      }

      if (CLAIMS_NOT_WITHDRAWN.test(claims)) {
        const revRow = row(CHECK.status)!;
        expect(
          revRow.severity === 'success',
          `${where}: claims it was not deactivated, but the row says "${revRow.value}"`,
        ).toBe(true);
      }

      // A check that never ran says so, and gives no other reason: not "the
      // list didn't load", not "couldn't load the standard". Severities can't
      // see this — both read "unchecked". The one exception is the Issuer row
      // when the seal failed, which talks about the seal instead (James, 1
      // October 2026): that is the reason, and it outranks the lookup.
      const haltedRows = [
        val === 'halted' && DATES_ROW,
        rev === 'halted' && CHECK.status,
        iss === 'halted' && CHECK.registeredIssuer,
        sch === 'halted' && CHECK.schema,
      ].filter((id): id is string => typeof id === 'string');
      for (const id of haltedRows) {
        const value = row(id)?.value ?? '';
        const aboutTheSeal = id === CHECK.registeredIssuer && value.startsWith("can't confirm — ");
        expect(aboutTheSeal || /(^|— )not checked$/.test(value), `${where}: "${row(id)?.label}" never ran, but reads "${value}"`).toBe(true);
      }

      // Each verdict must be borne out by the row it is about.
      const expectations: Record<string, [string, string] | undefined> = {
        verified: [CHECK.signature, 'success'],
        invalid_signature: [CHECK.signature, 'error'],
        signature_unchecked: [CHECK.signature, 'unchecked'],
        did_web_unresolved: [CHECK.signature, 'unchecked'],
        http_error_with_signature_check: [CHECK.signature, 'unchecked'],
        withdrawn: [CHECK.status, 'error'],
        suspended: [CHECK.status, 'error'],
        withdrawal_unknown: [CHECK.status, 'unchecked'],
        expired: [DATES_ROW, 'warning'],
        not_yet_valid: [DATES_ROW, 'warning'],
        dates_unchecked: [DATES_ROW, 'unchecked'],
        key_mismatch: [CHECK.registeredIssuer, 'error'],
        malformed: [CHECK.schema, 'warning'],
      };
      const expected = expectations[out.code];
      if (expected) {
        const [id, severity] = expected;
        expect(row(id)?.severity, `${where}: "${row(id)?.label}" must agree`).toBe(severity);
      }

      // The issuer verdicts must never sit above a row claiming a registry match.
      if (out.code === 'issuer_unconfirmed' || out.code === 'registry_unreachable') {
        expect(row(CHECK.registeredIssuer)?.severity, `${where}: issuer row`).not.toBe('success');
      }

      // Every verdict that is not a pass names one thing to do, except the
      // unconfirmed-issuer case, where §5 deliberately gives no instruction
      // because nothing is wrong and there is nothing to fix.
      if (out.severity !== 'success' && out.code !== 'issuer_unconfirmed') {
        expect(out.action, `${where}: no action offered`).toBeTruthy();
      }
    });
  });

  describe(`an issuer with no name is never addressed by its identifier (part ${part} of ${PARTS}: ${slice.length} combinations each)`, () => {
    // Each loops over a part's combinations: about 0.5 s on a laptop, up to
    // 2 s on CI (23 October 2026), too near Vitest's 5 s limit per test.
    it.each(NAMELESS)('%s', (_, issuer) => {
      for (const { sig, val, rev, end, iss, sch, list, lists, name } of slice) {
        const r = build(sig, val, rev, end, iss, sch);
        r.verifiableCredential = { ...r.verifiableCredential, issuer };
        const out = summarise(r, { registriesUnavailable: list === 'unavailable', requireIssuerSignedStatusList: lists === 'issuers' });
        // Two spaces in a row: an empty name dropped into a sentence.
        for (const sentence of [out.headline, out.detail, out.action ?? '']) {
          expect(sentence, `${name} → ${out.code}`).not.toMatch(/did:|Unknown issuer|\s\s/);
        }
      }
    }, 30_000);
  });
};
