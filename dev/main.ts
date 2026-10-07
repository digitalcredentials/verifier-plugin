import '../src/verifier-credential.js';
import type { VerifierCredential } from '../src/verifier-credential.js';
import type { Registry } from '../src/verify.js';

const fixture = (path: string) => new URL(`./fixtures/${path}`, location.href).href;

const LOCAL_REGISTRY: Registry[] = [
  { name: 'Local Dev Registry', type: 'dcc-legacy', url: fixture('registry.json') },
];

/**
 * A registry that answers and lists nobody, for an issuer we looked up and
 * didn't find. An empty list used to stand in for this; verifier-core now
 * skips the lookup for one, which is "we couldn't check", not "not listed".
 */
const UNLISTED_REGISTRY: Registry[] = [
  { name: 'Local Dev Registry', type: 'dcc-legacy', url: fixture('registry-unlisted.json') },
];

/** A registry that will never answer, for the "we couldn't check" state. */
const OFFLINE_REGISTRY: Registry[] = [
  { name: 'Local Dev Registry', type: 'dcc-legacy', url: fixture('nope.json') },
];

interface Situation {
  label: string;
  file: string;
  registries: Registry[];
  note: string;
}

/**
 * Every state the design has to handle, in the order a person is most likely
 * to meet them. Regenerate the credentials with `node scripts/make-fixtures.js`.
 *
 * Each one has to look different from the others. A situation that renders
 * identically to another belongs in a test, not on a page for judging how
 * things read — it costs a reader a click to learn nothing.
 */
const SITUATIONS: Situation[] = [
  { label: 'Verified', file: 'verified', registries: LOCAL_REGISTRY, note: 'issuer in the registry, nothing wrong' },
  { label: 'Not withdrawn', file: 'not-withdrawn', registries: LOCAL_REGISTRY, note: 'withdrawal list checked and clear' },
  { label: 'Issuer unknown', file: 'verified', registries: UNLISTED_REGISTRY, note: 'genuine, but no registry lists the issuer' },
  { label: 'Registry offline', file: 'verified', registries: OFFLINE_REGISTRY, note: "we couldn't reach the registry" },
  { label: 'Expired', file: 'expired', registries: LOCAL_REGISTRY, note: 'past its end date' },
  { label: 'Not yet valid', file: 'not-yet-valid', registries: LOCAL_REGISTRY, note: 'genuine, but its start date is still to come' },
  { label: 'Withdrawn', file: 'withdrawn', registries: LOCAL_REGISTRY, note: 'the issuer withdrew it' },
  { label: 'Suspended', file: 'suspended', registries: LOCAL_REGISTRY, note: 'the issuer set it aside, perhaps for now' },
  { label: 'Built wrong', file: 'malformed', registries: LOCAL_REGISTRY, note: 'genuine, but missing a field its standard requires' },
  { label: 'Changed', file: 'tampered', registries: LOCAL_REGISTRY, note: 'altered after issuing' },
  { label: 'Not their seal', file: 'not-their-seal', registries: LOCAL_REGISTRY, note: "names the issuer, sealed with someone else's key" },
  { label: 'Untrusted list', file: 'list-not-issuers', registries: LOCAL_REGISTRY, note: "its withdrawal list isn't signed by the issuer" },
  { label: 'No signature', file: 'unsigned', registries: LOCAL_REGISTRY, note: 'nothing to check' },
];

const el = document.getElementById('vc') as VerifierCredential;
const bar = document.getElementById('switch')!;
const log = document.getElementById('log')!;
const note = document.getElementById('note')!;

const write = (line: string) => {
  const now = new Date().toLocaleTimeString('en-GB');
  log.textContent = `${now}  ${line}\n${log.textContent === 'waiting…' ? '' : log.textContent}`;
};

el.addEventListener('verification-started', () => write('started'));
el.addEventListener('verification-complete', (e) => {
  const { outcome, checks } = (e as CustomEvent).detail;
  write(`complete   severity=${outcome.severity}  code=${outcome.code}  checks=${checks.length}`);
});
el.addEventListener('verification-failed', (e) => {
  write(`failed     ${String((e as CustomEvent).detail.error)}`);
});

let latest = 0;

const load = async (situation: Situation) => {
  const request = ++latest;
  const response = await fetch(`./fixtures/${situation.file}.json`);
  const credential = (await response.json()) as Record<string, unknown>;
  // Clicking faster than the fetches return would otherwise leave the
  // highlighted button describing a different card from the one on screen.
  if (request !== latest) return;

  bar.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.textContent === situation.label));
  });
  note.textContent = situation.note;
  el.registries = situation.registries;
  el.credential = credential;
};

for (const situation of SITUATIONS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = situation.label;
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => void load(situation));
  bar.append(button);
}

void load(SITUATIONS[0]!);
