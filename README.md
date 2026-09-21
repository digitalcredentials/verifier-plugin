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

Not yet tested: registry lookups, which are also served from GitHub Pages and
may have the same problem.

## Design

The requirements and the list of everything verification can report live in
`dcc-plans`, under `plans/dcc-platform/2026-09-16-wallet-verification/`:

- `requirements.md` — when verification runs, and what it shows
- `inventory.md` — all 19 outcomes the library can report

In short: four severity levels that don't grow (success, warning, error, and
"we couldn't check"), a list of messages that does grow, plain language for the
person who earned the credential, technical detail one click away, and careful
wording for the common case where we can't confirm who the issuer is.

## Open questions

- **What shape is this component?** A web component, or a React component to
  import? What goes in as props, what comes out as events? Nate raised this and
  it isn't settled. A web component fits the "swappable plugin" idea better,
  but it's worth agreeing before building much.
- **How much does it own?** Probably displaying the credential, displaying the
  verification, and running the verification. Nate's read, and it seems right.
- **The formal plugin interface** is being worked out separately, with the
  community. Whatever gets built here should expect to adapt.

## Licence

MIT
