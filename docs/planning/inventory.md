# What can be checked about a credential

Draft — Sunny Lee, 18 September 2026. Updated 21 September 2026. Companion
to `requirements.md`.

This is the raw material for the product decisions: every distinct thing
verification can tell us, and what each one means in plain language.

Compiled by reading `@digitalcredentials/verifier-core` 1.0.0-beta.11 as
published, not from documentation. The refined fork
(`skybridgeskills/dcc-verifier-core`) groups these into named layers and adds
non-blocking severity; it is **not published to npm**, so anything depending on
it depends on a git reference until it lands upstream.

A note on wording: the library's own code calls each individual check a
**step** (`VerificationStep`, `constants/verificationSteps.js`). This document
uses *step* for an individual check and *layer* for a group of them, avoiding
"suite", which in this community means a signature suite.

---

## The two tiers that matter most

Verification does not produce one list of results. It produces one of two
shapes, and the difference drives the whole design:

**Tier A — it stopped.** Something was wrong enough that no further checking
was possible. The result is a credential plus one error, and **no per-check
list at all**. There is nothing to show a breakdown of, because nothing else
ran.

**Tier B — it ran.** The result is a list of steps, each independently passed
or failed, plus a separate advisory section.

A design that assumes it always gets a list of checks will break on Tier A.

---

## Tier A — verification could not proceed

### A1. Malformed credential (checked before anything else)

| Code | What it means in plain language |
|---|---|
| `invalid_jsonld` | The file has no context. It isn't a structured credential at all. |
| `no_vc_context` | It's structured, but doesn't declare itself a Verifiable Credential. |
| `invalid_credential_id` | Its identifier isn't a proper web address. The library's own message says this "may have been issued as part of an early pilot" and to ask the issuer for a replacement. |
| `no_proof` | There is no digital signature. Nothing to check. |

All four are decided locally, instantly, with no network.

### A2. The signature check itself could not complete

| Code | What it means in plain language |
|---|---|
| `invalid_signature` | The signature is wrong. Assume tampering. |
| `http_error_with_signature_check` | A network failure stopped the check. We don't know either way. |
| `did_web_unresolved` | The issuer publishes their key on their own website, and we couldn't reach it. We don't know either way. |
| (json-ld errors) | The credential's vocabulary couldn't be processed. Returned raw, unclassified. |

**This distinction is the single most important one in the whole inventory.**
`invalid_signature` means *distrust this*. `http_error_with_signature_check`
and `did_web_unresolved` mean *we couldn't find out* — a completely different
message to a person, and a different suggested action. They are easy to
conflate and must not be.

---

## Tier B — verification ran; here are the steps

### B1. The four steps

| Step id | Plain language | Mobile's severity today |
|---|---|---|
| `valid_signature` | Signed by the key it claims, unaltered since | **failure** if false |
| `revocation_status` | The issuer has not withdrawn it | **failure** if false |
| `expiration` | Still within its validity dates | **warning** if false |
| `registered_issuer` | The issuer appears in a registry we consult | **warning** if false |

The mobile wallet already makes this split, and it is a good one. Signature and
revocation are about trustworthiness; expiry and recognition are about
circumstance.

`registered_issuer` also carries two lists the display can use: which registries
recognised the issuer, and which registries we couldn't reach.

That second list is a genuine third state: **not recognised, not unrecognised,
but unknown because the lookup failed.**

**And `valid` alone cannot tell you which you have.** Verified by running the
library on 21 September, once against a working registry and once against one
that couldn't be reached. Both report `valid: false` with an empty list of
matching issuers. The only difference is that the unreachable case also fills in
the list of registries it couldn't load, naming each one. So a display that
reads `valid` and stops will show "issuer not recognised" whenever the network
fails. See `requirements.md` §4.

> **Open question — the two lists don't match between the running code
> and the published package.** Confirmed by reading both on 21 September. The
> runtime attaches them as `matchingIssuers` and `uncheckedRegistries`; the
> published TypeScript declaration for a step names them `foundInRegistries` and
> `registriesNotLoaded`. A consumer typed against the declaration reads
> `undefined` for both.
>
> It is not just a pair of different names. The shapes differ too: the runtime's
> `matchingIssuers` is a list of objects, each holding an issuer and the registry
> that matched it, while the declared `foundInRegistries` is a list of plain
> strings. So this can't be resolved by renaming — someone has to decide which
> shape is intended.
>
> The mobile wallet is unaffected because it only reads each step's `id` and
> `valid`, but anything wanting to show *which* registry recognised an issuer
> will hit this. Worth settling before we build display on top of them.

### B2. Revocation sub-failures

When the revocation check can't be completed, the step carries an error instead
of a pass/fail. Six distinct ones:

| Code | Plain language |
|---|---|
| `status_list_not_found` | The issuer's revocation list is missing. |
| `status_list_expired` | Their revocation list has itself expired. |
| `status_list_signature_error` | Their revocation list is not correctly signed. |
| `status_list_type_error` | Their revocation list is the wrong kind of document. |
| `status_list_not_yet_valid` | Their revocation list claims to start in the future. |
| `status_list_error` | Something else went wrong. |

**Every one of these is the issuer's problem, not the holder's, and none of
them means the credential is bad.** For an ordinary person all six collapse to
one sentence: *we couldn't check whether this has been withdrawn.* They belong
in the detailed view, individually, because they are exactly what an issuer
debugging their own setup needs.

**A seventh case, and right now the most likely one.** Tested in a browser on 21
September: fetching the withdrawal list fails outright, for a reason particular
to how browsers handle requests to other sites. It isn't in the list above
because the library doesn't have a code for it. It is fixable — veri-good
already works around it, and it is probably worth fixing in verifier-core
itself. Until then, assume the withdrawal check does not complete in the
browser, and that *"we couldn't check whether this has been withdrawn"* is the
result people usually see. See `requirements.md` §3.

### B3. Advisory — schema

Held in a separate section from the steps, and deliberately so: it does not
affect validity.

`schema_check` validates the credential against the Open Badges v3 schemas —
either the one the credential names, or one guessed from its context. This is
the case raised in review: a genuine, unwithdrawn credential that is slightly
malformed.

### B4. Locally decided, not from the library

`supported_format` — the mobile wallet checks the credential's type itself,
outside verifier-core, treating unrecognised types as a failure. Worth knowing
this is a wallet decision, not a library result.

---

## The count, and what to do with it

**19 distinct outcomes** the library can report: four malformed-credential
errors, four signature-check outcomes, four steps, six revocation
sub-failures, and one advisory. The display also needs states of its own for
work in progress and for verification failing outright.

Which raises the real question: **how many of these does someone who just
wants to know whether their diploma is good actually need to see?**

The answer in `requirements.md` §4 is that these 19 are *messages*, and they
map onto **four severities** — success, warning, error, and "we couldn't
check". The severities are a closed set; this list is the open one, and it
grows as we handle more cases.

Mapping them is mostly straightforward, with two worth arguing about:

- **Every revocation sub-failure is "we couldn't check"**, not an error. They
  are all the issuer's setup being broken, and none of them means the
  credential is bad.
- **An unrecognised issuer is a warning**, not an error — but an *unreachable
  registry* is "we couldn't check". Same screen, different cause, and they
  must not look alike. See `requirements.md` §5.

The detail view keeps all 19 distinct. The main view never shows more than
one.
