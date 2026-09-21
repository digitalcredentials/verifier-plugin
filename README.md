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

Just started. Nothing here yet beyond this README.

## Decisions so far

From the standup on 21 September 2026:

- **Separate repository**, not part of the web wallet. It may move into the
  wallet later, or become a component other people use. Keeping it separate
  means experimenting without disturbing anything else.
- **It's a plugin.** The web wallet is meant to be thin, with functionality
  added around it. Sharing and QR codes are separate plugins; viewing a
  credential may become one too.
- **Verification library: `@digitalcredentials/verifier-core`**, the published
  one. Nate has a fork with more in it — checks grouped into suites, added
  dynamically by credential type, and a richer result log. He and James will
  work out whether that lands upstream. Switching later is cheap.
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

**One thing the fix needs, that we can't do from here.** verifier-core builds
its document loader at module scope and `verifyCredential` takes no loader
argument, so there is no way to supply the veri-good workaround from outside
the library. The status-list fix has to land in verifier-core itself, or in
Nate's fork. Until it does, the withdrawal check does not complete in a browser
for any credential that carries a status list.

## Design

The requirements and the list of everything verification can report live in
`dcc-plans`, under `plans/dcc-platform/2026-09-16-wallet-verification/`:

- `requirements.md` — when verification runs, and what it shows
- `inventory.md` — all 19 outcomes the library can report

In short: four severity levels that don't grow (success, warning, error, and
"we couldn't check"), a list of messages that does grow, plain language for the
person who earned the credential, technical detail one click away, and careful
wording for the common case where we can't confirm who the issuer is.

## What's here

A first slice: a real credential in, real verification, one card out.

| | |
|---|---|
| `src/outcomes.ts` | Turns a verification result into what a person reads. Pure, no rendering, no network — this is where the design lives |
| `src/types.ts` | The shapes verifier-core actually returns, written from the running code rather than its type declarations |
| `src/verify.ts` | Runs verifier-core. Deliberately thin |
| `src/credential.ts` | Pulls out the few fields we display |
| `src/verifier-credential.ts` | The `<verifier-credential>` web component |
| `test/outcomes.test.ts` | 29 tests, mostly on the ways a good credential can be made to look bad |
| `test/browser/states.spec.ts` | 10 tests driving the component in a real browser |
| `scripts/make-fixtures.js` | Builds the test credentials, really signed |

```
npm install
npm test            # the mapping, without a browser
npm run test:browser  # the component, in Chromium, verifying for real
npm run dev         # look at it
npm run fixtures    # rebuild the test credentials
```

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
| Changed | altered after signing |
| No signature | nothing to check |

The status list and the dev registry are served by the dev server on the same
origin as the page. They have to be — fetching a status list cross-origin fails
in a browser today, so this is the only way to exercise the withdrawn state at
all until that's fixed upstream.

## Open questions

- **What shape is this component?** Provisionally a web component — Kerri and
  Nate both lean that way, and James notes it's cheap to convert either
  direction since React 19 supports web components. Settled enough to build on,
  not settled enough to argue from.
- **How much does it own?** Displaying the credential, displaying the
  verification, and running the verification. Nate's read, and it's what this
  does.
- **The formal plugin interface** is being worked out separately, with the
  community. Whatever gets built here should expect to adapt.
- **What do we say about a credential with no withdrawal list?** Right now the
  row is simply absent, matching the mobile wallet. Saying nothing may be
  right; it may also be worth a plain line saying the issuer provided no way to
  withdraw it. Sunny's call.

## Licence

MIT
