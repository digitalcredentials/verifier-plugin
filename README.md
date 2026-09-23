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

Two pull requests merged on 23 September 2026. 811 unit tests and 22 in
Chromium; lint, typecheck and build run on every push.

It has **not** been run inside React or the wallet yet, which is the point of
it, and no screen reader has heard it. See **Open questions**.

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
| `src/index.ts` | The public surface |
| `test/outcomes.test.ts` | The mapping, and the ways a good credential can be made to look bad |
| `test/consistency.test.ts` | 720 combinations asserting the headline and the breakdown can never disagree |
| `test/browser/states.spec.ts` | 22 tests driving the component in a real browser |
| `scripts/make-fixtures.js` | Builds the test credentials, really signed |

```
npm install
npm test            # the mapping, without a browser
npm run test:browser  # the component, in Chromium, verifying for real
npm run dev         # look at it
npm run fixtures    # rebuild the test credentials
```

### Changing `src/outcomes.ts`

`summarise()` and `listChecks()` describe the same credential, and the one bug
this code keeps producing is the two of them disagreeing. Ten defects were
found across four reviews of the first two pull requests, and six were that —
a clean verdict above a row reporting a problem, or a headline claiming in
prose what the breakdown said was never checked.

`test/consistency.test.ts` walks 720 combinations and asserts both: that the
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
  it should have" is followed by "Nothing has changed since it was issued, and
  the issuer hasn't withdrawn it." The breakdown already says both.
- **Does "There's nothing for you to do" reassure, or dismiss?** It comes from
  Nate's remark that most of these are not errors the holder could resolve
  themselves. It is the point of that outcome and the least settled part of
  it.

## Licence

MIT
