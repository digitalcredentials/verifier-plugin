# verifier-plugin

A credential viewer and verifier for the Digital Credentials Commons web
wallet, built as a plugin rather than as part of the wallet itself.

Its job is to show someone their own credential and tell them whether it still
holds up. It is **not** a way to prove a credential to anyone else — a wallet
can't do that. It tells the person who earned the credential that it still
verifies, gives them a sense of what a recipient would see, and says what to do
when something is wrong.

> Name is provisional. Kerri picked something plain so it could be renamed once
> the plugin model is clearer.

## Status

Working. A `<verifier-credential>` web component: a real credential in, real
verification, one card out. Nine situations render correctly from genuinely
signed fixtures.

**Try it:** https://digitalcredentials.github.io/verifier-plugin/ — the demo
page, published from `main`. Pick a situation and the card verifies a real,
signed test credential in your browser. Every pull request also gets its own
copy at `/verifier-plugin/pr-<number>/`, linked in a comment on the PR, so a
change can be tried before it merges. It is taken down when the PR closes.

Unit tests, browser tests, lint, typecheck and build run on every push. The
browser tests run again against each published copy, because that is the one
people look at.

It has run inside the LCW web wallet, in dev and production builds, with plain
and encrypted collections (lcw-front-end#104). That pull request was closed in
favour of the wallet's plugin interface, which this package now follows: see
**Using it in the LCW web wallet**. No screen reader has heard it yet. See
**Open questions**.

## Using it in the LCW web wallet

The wallet's plugin guide is
[lcw-front-end `docs/plugins.md`](https://github.com/digitalcredentials/lcw-front-end/blob/main/docs/plugins.md).
This package follows it as a web-component plugin.

**Install.** From the `release` branch, which `.github/workflows/release.yml`
rebuilds from every push to `main`:

```json
"@digitalcredentials/verifier-plugin": "github:digitalcredentials/verifier-plugin#release"
```

`npm install` runs none of this package's scripts, and verifier-core is bundled
into `dist/`, so the wallet installs nothing else. `npm update
@digitalcredentials/verifier-plugin` moves the lock file to the latest build.

**Register.** Importing the package registers `<verifier-credential>` and tells
the wallet's JSX about it, so the wallet needs no type declarations of its own.
The credential detail slot:

```tsx
// src/plugins/Verifier.tsx
import '@digitalcredentials/verifier-plugin';
import type { Registry } from '@digitalcredentials/verifier-plugin';
import type { WalletHost } from './types';

// The wallet's trust list is its own configuration, passed in as a property.
const registries: Registry[] = [
  { name: 'DCC Sandbox Registry', type: 'dcc-legacy', url: 'https://digitalcredentials.github.io/sandbox-registry/registry.json' },
];

export function VerifierDetail({ credential }: { credential: Record<string, unknown> | null; host: WalletHost }) {
  return <verifier-credential credential={credential ?? undefined} registries={registries} />;
}
```

The wallet's `WalletPlugin` also requires a page of its own (`Component`); see
the guide, section 5.

**Properties**, set as properties, not attributes (React 19 does this for a
custom element that defines them):

| Property | |
|---|---|
| `credential` | The credential to show and check. Setting it checks it; `undefined` clears the card. |
| `registries` | The registries to look the issuer up in, as `Registry[]`. Defaults to the DCC Sandbox Registry. Changing it checks again. |
| `registriesUnavailable` | Set when the wallet couldn't get its list of registries. The issuer is then not looked up, and the card says the list didn't load. Use this, not `registries = []`: an empty list names nobody, so every issuer would read as not on it. |

**Events**, bubbling and composed: `verification-started` `{ credential }`,
`verification-complete` `{ outcome, checks, response }`, `verification-failed`
`{ error }`.

**Styling.** It draws in a shadow root with its own styles. To match the
wallet's palette, set any of these CSS custom properties on the element:
`--vp-surface`, `--vp-surface-2`, `--vp-ink`, `--vp-ink-2`, `--vp-ink-3`,
`--vp-rule`, `--vp-rule-strong`, `--vp-accent`, `--vp-ok`, `--vp-warn`,
`--vp-bad`, `--vp-unk`, `--vp-font`, `--vp-mono`.

## Decisions so far

From the standup on 21 September 2026:

- **Separate repository**, not part of the web wallet. It may move into the
  wallet later, or become a component other people use. Keeping it separate
  means experimenting without disturbing anything else.
- **It's a plugin.** The web wallet is meant to be thin, with functionality
  added around it. Sharing and QR codes are separate plugins; viewing a
  credential may become one too.
- **Verification library: `@digitalcredentials/verifier-core`**, the published
  one. *Which* version was settled on 22 September: whatever `verifier-plus`
  uses. That is `^1.0.0-beta.7`, resolving to `1.0.0-beta.11`, which is what
  this pins.

  Nate is building on a 2.x that is not published yet — checks grouped into
  suites by phase, dotted check ids, presentation and per-credential results
  separated. Worth knowing that it carries `skipped`-with-a-reason and a
  per-check `fatal` flag as first-class, both of which are hand-built here. So
  the mapping gets thinner when it lands, not thicker.
- **veri-good is a reference, not a foundation.** It was an experiment, it
  targets a different setting (an issuer's own web page), and nobody uses it.
  Worth learning from, not worth inheriting.

## Does verifier-core work in a browser?

This was the open risk — the reason veri-good used the Digital Bazaar
libraries directly was a memory of verifier-core having browser problems.

**Checked on 21 September 2026: yes, mostly.** Bundled with esbuild for the
browser and run in headless Chromium against two test credentials:

| | Result |
|---|---|
| Bundling | Clean. No Node polyfills needed |
| `did:key` credential, no status list | Verified, ~0.9s |
| `did:web` credential, with status list | Signature verified, ~1.6s |

**Update, 1 October 2026: the status-list problem below is fixed, and
tested.** It was a 1.x problem. 2.x fetches with a bare `fetch(url)`, so
nothing is preflighted, and a page on localhost reads the withdrawal lists on
GitHub Pages correctly. The browser tests cover it against a second local
server that refuses preflights the way GitHub Pages does
(`test/browser/pages-like-server.js`). Separately, the tests now serve a copy
of the Open Badges schema instead of fetching it, after one request took 52
seconds. The rest of this section is the 21 September record of 1.x, kept as
it was: it no longer describes how things stand.

**One real problem: fetching a status list fails in the browser.** The request
triggers a CORS preflight, and GitHub Pages answers `OPTIONS` with a 405, so
the check never completes. A plain `GET` to the same URL returns
`access-control-allow-origin: *` and works fine — the preflight is the whole
problem.

This is not specific to our test fixtures. Any issuer hosting a status list on
something that doesn't answer `OPTIONS` will hit it.

**The fix already exists in veri-good.** `src/checkStatusDirectly.js` supplies
its own document loader for exactly this reason, with the comment:

> we need to use our own document loader so we can run the fetch to get the
> status list, without preflight calls that cause CORS errors

So the work here is to give verifier-core a document loader that fetches
without triggering a preflight. Worth raising upstream as well, since it
affects any browser-based verifier.

**Registry lookups are fine.** Tested 21 September 2026 in headless Chromium,
against the real sandbox registry: a plain `GET`, no preflight, `200` with
`access-control-allow-origin: *`. The reason is in the code — the registry
client calls bare `fetch(url)` with no headers or options, which browsers treat
as a simple request and don't preflight. The status list fails because it goes
through the document loader, which sets headers.

So "we can't confirm who issued this" is a genuine gap in registry coverage,
not a bug of ours.

**Schema fetches are fine too.** Added 22 September: verifier-core validates
Open Badges credentials against a schema it fetches from `purl.imsglobal.org`,
and that request is a simple `GET` like the registry lookup, so it is not
preflighted. The browser test for the "Built wrong" state exercises it end to
end against the real published schema. So of the three things this library
fetches, only the status list is blocked.

**One thing the fix needs, that we can't do from here.** verifier-core builds
its document loader at module scope and `verifyCredential` takes no loader
argument, so there is no way to supply the veri-good workaround from outside
the library. The status-list fix has to land in verifier-core itself, or in
Nate's fork. Until it does, the withdrawal check does not complete in a browser
for any credential that carries a status list.

## Design

The requirements and the list of everything verification can report live in
[`docs/planning/`](docs/planning/):

- [`requirements.md`](docs/planning/requirements.md) — when verification runs,
  and what it shows. `src/outcomes.ts` cites its §4 and §5 by number: those
  sections are the specification this component implements.
- [`inventory.md`](docs/planning/inventory.md) — everything verifier-core can
  report, in two tiers.

They live here rather than in a planning repo so they move with the code. A
change in behaviour that leaves them untouched should look wrong in review —
which is how §4 came to describe something its own implementation no longer
did.

In short: four severity levels that don't grow (success, warning, error, and
"we couldn't check"), a list of messages that does grow, plain language for the
person who earned the credential, technical detail in a developer view of its
own, and careful wording for the common case where we can't confirm who the
issuer is.

## What's here

A first slice: a real credential in, real verification, one card out.

| | |
|---|---|
| `src/outcomes.ts` | Turns a verification result into what a person reads. Pure, no rendering, no network — this is where the design lives |
| `src/types.ts` | The shapes verifier-core actually returns, written from the running code rather than its type declarations |
| `src/verify.ts` | Runs verifier-core. Deliberately thin |
| `src/credential.ts` | Pulls out the few fields we display |
| `src/verifier-credential.ts` | The `<verifier-credential>` web component |
| `src/index.ts` | The public surface |
| `src/jsx.ts` | Tells a React host's JSX about `<verifier-credential>`; types only |
| `test/outcomes.test.ts` | The mapping, and the ways a good credential can be made to look bad |
| `test/consistency.test.ts` | 1,500 combinations asserting the headline and the breakdown can never disagree |
| `test/browser/states.spec.ts` | Drives the component in a real browser, locally or against a published copy |
| `test/types/jsx.tsx` | Type test: a React host can write `<verifier-credential>` once it imports the package |
| `scripts/make-fixtures.js` | Builds the test credentials, really signed |
| `scripts/build-site.js` | Builds the demo page for a published address, with credentials signed for it |
| `.github/workflows/preview.yml` | Publishes `main` and each PR to GitHub Pages, then tests the published copy |
| `.github/workflows/release.yml` | Builds `main` into the `release` branch the wallet installs from |

```
npm install
npm test            # the mapping, without a browser
npm run typecheck   # types, including what a React host sees
npm run test:browser  # the component, in Chromium, verifying for real
npm run dev         # look at it
npm run fixtures    # rebuild the test credentials

# the published site, built and tested locally
npm run build:site -- http://localhost:4173/verifier-plugin/
npx vite preview --mode site --port 4173
PLAYWRIGHT_BASE_URL=http://localhost:4173/verifier-plugin/ npm run test:browser
```

### The published site

`.github/workflows/preview.yml` publishes `main` to
https://digitalcredentials.github.io/verifier-plugin/ and each pull request to
`/verifier-plugin/pr-<number>/`, comments the link on the PR, runs the browser
tests against it, and removes it when the PR closes. Pull requests from forks,
and from Dependabot, get no preview.

It needs one setting, made once: **Settings → Pages → Deploy from a branch →
`gh-pages`, `/ (root)`**. The first run creates that branch. Until the setting
is on, the step that waits for the published copy gives up after ten minutes.

The site's test credentials are signed fresh for its address, because a
credential names its withdrawal list by full address. They use the same test
issuer as `dev/fixtures`, whose key comes from a fixed seed in
`scripts/make-fixtures.js` — so it is public, and anyone can sign as it. The
published `fixtures/registry.json` says so in its own note. It is there to show
what a recognised issuer looks like, and must never be configured as a real
registry.

### Changing `src/outcomes.ts`

`summarise()` and `listChecks()` describe the same credential, and the one bug
this code keeps producing is the two of them disagreeing. Ten defects were
found across four reviews of the first two pull requests, and six were that —
a clean verdict above a row reporting a problem, or a headline claiming in
prose what the breakdown said was never checked.

`test/consistency.test.ts` walks 1,500 combinations and asserts both: that the
severities agree, and that no verdict claims the credential is unchanged or
not withdrawn unless the row it rests on actually reported. Run it if you
touch either function.

Two rules fall out of it, both learned the hard way:

- **Say only what reported.** The reassurance beside a finding is assembled in
  one place from the checks that came back. Writing it as fixed text is how it
  went wrong three times.
- **Do not name a cause the log cannot establish.** A withdrawal check that
  left no step behind might be an unrecognised status method, or verification
  stopping earlier. The row says "not checked" and guesses at neither.

### The test credentials

Generated by `scripts/make-fixtures.js` from a fixed seed, so they're
reproducible, and really signed, so the signatures really verify. That matters
for the expired one in particular: it needs a *valid* signature over a date
that has passed, or it reads as tampered and we'd be testing the wrong thing.

The dev page covers every state the design has to handle:

| | |
|---|---|
| Verified | issuer in the registry, nothing wrong |
| Not withdrawn | withdrawal list fetched and checked |
| Issuer unknown | genuine, but no registry lists the issuer |
| Registry offline | we couldn't reach the registry — deliberately a different message |
| Expired | past its end date |
| Withdrawn | the issuer withdrew it |
| Built wrong | genuine, but missing a field its own standard requires |
| Changed | altered after signing |
| No signature | nothing to check |

The status list and the dev registry are served by the dev server on the same
origin as the page, so the demo's withdrawn states behave predictably. The
browser tests also check a withdrawal list on another site, as a wallet meets
it: `test/browser/pages-like-server.js` signs its own credentials pointing at
itself, and refuses preflights the way GitHub Pages does.

## Open questions

- **What shape is this component?** Provisionally a web component — Kerri and
  Nate both lean that way, and James notes it's cheap to convert either
  direction since React 19 supports web components. Settled enough to build on,
  not settled enough to argue from.
- **How much does it own?** Displaying the credential, displaying the
  verification, and running the verification. Nate's read, and it's what this
  does.
- **The formal plugin interface** is now written down for the LCW web wallet
  in lcw-front-end `docs/plugins.md`, and this package follows it. James calls
  it a start, so expect it to change.

**Settled since**: a credential with no withdrawal list now says so, in the
details only. Nothing failed and there was nothing to try, so it reads as no
information rather than as a problem — silence was fine for the person who
earned the credential, but an issuer debugging their own badge could not tell
a missing list apart from one that loaded and came back clean.

Open on the wording, and none of them are bugs:

- **Does the "How it was built" row earn its place?** Every card ends with it,
  and on a good credential it says "as the standard expects" — a row almost
  nobody needs, on the screen almost everybody sees.
- **Should a warning also reassure?** "This credential is missing information
  it should have" is followed by "It hasn't been tampered with, and the issuer
  hasn't withdrawn it." The breakdown already says both.
- **Does "There's nothing for you to do" reassure, or dismiss?** It comes from
  Nate's remark that most of these are not errors the holder could resolve
  themselves. It is the point of that outcome and the least settled part of
  it.

## Licence

MIT
