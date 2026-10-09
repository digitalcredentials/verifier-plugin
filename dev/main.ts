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
  { label: 'Not withdrawn', file: 'not-withdrawn', registries: LOCAL_REGISTRY, note: 'status list checked: not deactivated or on hold' },
  { label: 'Issuer unknown', file: 'verified', registries: UNLISTED_REGISTRY, note: 'genuine, but no registry lists the issuer' },
  { label: 'Registry offline', file: 'verified', registries: OFFLINE_REGISTRY, note: "we couldn't reach the registry" },
  { label: 'Expired', file: 'expired', registries: LOCAL_REGISTRY, note: 'past its end date' },
  { label: 'Not yet valid', file: 'not-yet-valid', registries: LOCAL_REGISTRY, note: 'genuine, but its start date is still to come' },
  { label: 'Withdrawn', file: 'withdrawn', registries: LOCAL_REGISTRY, note: 'the issuer deactivated this copy' },
  { label: 'Suspended', file: 'suspended', registries: LOCAL_REGISTRY, note: 'the issuer put this copy on hold, perhaps for now' },
  { label: 'Built wrong', file: 'malformed', registries: LOCAL_REGISTRY, note: 'genuine, but missing a field its standard requires' },
  { label: 'Changed', file: 'tampered', registries: LOCAL_REGISTRY, note: 'altered after issuing' },
  { label: 'Not their seal', file: 'not-their-seal', registries: LOCAL_REGISTRY, note: "names the issuer, signed with someone else's key" },
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

/**
 * The list of known issuer registries DCC maintains, which the wallet checks
 * against too. A linked credential is a real one, so it is checked against
 * the real list, not the test registry the situations use.
 */
const KNOWN_REGISTRIES = 'https://digitalcredentials.github.io/dcc-known-registries/known-did-registries.json';

/** Long enough for any working server; a fetch that stalls rather than fails would otherwise leave the page blank. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The credential address in a link: `?vc=<address>`, or `#verify?vc=<address>`
 * as VerifierPlus takes it, so a VerifierPlus link works here with its host
 * swapped. Undefined when the page wasn't opened from a link.
 *
 * Everything after `vc=` is the address, because the wallet's share links
 * put it there unencoded — `&` and `+` included — and a query-string parser
 * would cut it short or turn `+` into a space. An encoded address is decoded,
 * but only when it isn't already a web address as it stands.
 */
const linkedAddress = (): string | undefined => {
  const query = location.hash.startsWith('#verify?') ? location.hash.slice('#verify'.length) : location.search;
  const raw = /[?&]vc=(.*)$/s.exec(query)?.[1];
  if (raw === undefined || URL.canParse(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * Only `https:` addresses in builds. The dev server also takes `http:`, so
 * the browser tests can link to the fixtures it serves; builds replace
 * `import.meta.env.DEV` with `false`.
 */
const FETCHABLE = import.meta.env.DEV ? ['https:', 'http:'] : ['https:'];

/**
 * The credential in what a link points to: the document itself, or the first
 * credential in a presentation, which is how the wallet stores and shares
 * one. Undefined when it isn't a credential. The wallet's own test
 * (credentialFrom in lcw-front-end's src/lib/linkedin.ts), so whatever the
 * wallet treats as a credential is checked here too, plus one case it
 * doesn't take: a presentation holding its one credential as itself rather
 * than in a list.
 */
const credentialIn = (data: unknown): { credential?: Record<string, unknown>; count: number } => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { count: 0 };
  const held: unknown[] =
    'verifiableCredential' in data ? [(data as { verifiableCredential: unknown }).verifiableCredential].flat() : [data];
  const first = held[0];
  if (typeof first !== 'object' || first === null) return { count: 0 };
  const candidate = first as Record<string, unknown>;
  const types = [candidate.type ?? []].flat();
  if (!types.includes('VerifiableCredential') && !candidate.credentialSubject) return { count: 0 };
  return { credential: candidate, count: held.length };
};

type Fetched =
  | { ok: true; credential: Record<string, unknown>; count: number }
  | { ok: false; headline: string; before: string; shown: string; after: string };

/**
 * Fetches the linked credential, or says why not. Every failure names what
 * was asked for, which is shown as text, never as HTML: it comes from
 * whoever made the link.
 */
const fetchCredential = async (address: string): Promise<Fetched> => {
  const url = URL.canParse(address) ? new URL(address) : undefined;
  if (!url || !FETCHABLE.includes(url.protocol)) {
    const asked = 'After “vc=” it should give the web address of a credential, starting https://.';
    return address
      ? { ok: false, headline: "That link doesn't say where the credential is", before: `${asked} It gives `, shown: address, after: '.' }
      : { ok: false, headline: "That link doesn't say where the credential is", before: `${asked} It gives nothing.`, shown: '', after: '' };
  }
  let response: Response;
  let text: string;
  try {
    // No headers, so no CORS preflight, which GitHub Pages refuses. The
    // body is read inside the time limit too: a server can stall after
    // sending its headers.
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    text = await response.text();
  } catch (error) {
    write(`link       ${String(error)}`);
    return {
      ok: false,
      headline: "We couldn't fetch that credential",
      before: '',
      shown: url.href,
      // A browser can't tell these apart: it hides why a fetch across sites failed.
      after: " didn't answer, or doesn't let other websites read it.",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      headline: "We couldn't fetch that credential",
      before: '',
      shown: url.href,
      after: ` answered with an error (${response.status}).`,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const { credential, count } = credentialIn(data);
  if (!credential) {
    return {
      ok: false,
      headline: "That link doesn't point to a credential",
      before: '',
      shown: url.href,
      after: " sent something that isn't a credential.",
    };
  }
  return { ok: true, credential, count };
};

/** The known registries, or undefined when they didn't load — which the card is told, rather than given none. */
const knownRegistries = async (): Promise<Registry[] | undefined> => {
  try {
    const response = await fetch(KNOWN_REGISTRIES, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const list: unknown = await response.json();
    if (!Array.isArray(list)) throw new Error('not a list');
    return list as Registry[];
  } catch (error) {
    write(`registries ${String(error)}`);
    return undefined;
  }
};

/**
 * A credential from a link. The situation buttons go: they would swap the
 * linked credential for a test one.
 */
const openLink = async (address: string) => {
  bar.remove();
  document.getElementById('intro')!.textContent = 'The credential your link points to, checked in your browser.';
  const [fetched, registries] = await Promise.all([fetchCredential(address), knownRegistries()]);

  if (!fetched.ok) {
    const problem = document.getElementById('problem')!;
    const headline = document.createElement('strong');
    headline.textContent = fetched.headline;
    const shown = document.createElement('code');
    shown.textContent = fetched.shown;
    problem.replaceChildren(headline, fetched.before, ...(fetched.shown ? [shown] : []), fetched.after);
    el.style.display = 'none';
    return;
  }

  note.textContent =
    fetched.count > 1 ? `This link holds ${fetched.count} credentials. This is the first.` : '';
  // Set together, so the card checks once.
  if (registries) el.registries = registries;
  else el.registriesUnavailable = true;
  el.credential = fetched.credential;
};

const address = linkedAddress();

if (address !== undefined) {
  void openLink(address);
} else {
  for (const situation of SITUATIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = situation.label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => void load(situation));
    bar.append(button);
  }
  void load(SITUATIONS[0]!);
}

// The page reads its link once, on load. Editing the part after `#` doesn't
// reload a page on its own, so it does it here.
addEventListener('hashchange', () => location.reload());
