# Credential verification in the web wallet

Draft for discussion — Sunny Lee, 18 September 2026. Updated 21 September 2026.
Companion document: `inventory.md`, which lists everything verification can
tell us.

This covers two questions: when the wallet checks a credential, and what it
says about the result.

---

## 1. Who this is for

The people who built the wallet needed to know whether the cryptography
worked, so the screen reports whether the cryptography worked. That was the
right thing to build first. A verification library has to prove it verifies
before anything else matters.

But the audience has changed. Someone opening their own diploma is told it
"has a valid signature" and "has been issued by a known issuer." Those are
sentences about machinery, shown to a person who wants to know about their
diploma.

And that person is not suspicious of their own credential. They know they
earned it. What they actually want to know is closer to:

> **"Will this work when I send it to someone?"**

That question has a different answer, and keeping it in mind changes a lot:
the words we use, what goes at the top of the screen, what we hide, and what
we treat as a problem at all.

Two things follow.

**The person who earned the credential comes first.** People will only use a
wallet they find worth opening, and a screen that reads like a diagnostic
report is a reason to close it.

**Developers matter too**, and they are well served by putting detail one
click away rather than making everyone read it.

One limit worth stating early, because it constrains the wording throughout:
**the wallet cannot tell anyone whether a credential will be accepted.** That
depends on the recipient's software and their own rules, which we cannot see.
We can say what a recipient would find. We cannot promise they will be
satisfied.

---

## 2. What we're building by December

The starting point is what a person can do in the mobile wallet today. That is
a working product real people have used, and rebuilding its thinking from
scratch would cost us the date.

Three things about how we use it as a reference:

**We match what the app actually does, not what its code contains.** If
something exists in the codebase but isn't switched on in the released app,
there was probably a reason.

**We are not copying it line for line.** Where we have a clear reason to do
better, we do better, and we write the reason down. Section 4 has several of
these, and most cost nothing but wording.

**Where we deliberately differ, we say so.** A short, named list of
exceptions, rather than an open invitation to redesign everything.

### An open question about size

Two things sit right at the edge of this document, and we have not agreed
whether they are in December:

- **Getting credentials into the wallet.** Architecture for this already
  exists, and there is a standing request to walk through which parts may need
  discussion before they land.
- **Sharing credentials out.**

It has been pointed out that the mobile wallet does both, so a web wallet that
does neither isn't really a replacement. That is hard to argue with. But these
are much larger than verification, and they belong to other people's plans.

This document takes a narrow position: **it covers verifying a credential when
one arrives, and it does not cover building the arrival flow itself.** If
December has to include both, that changes the size of December considerably,
and someone needs to confirm the rest is on a plan somewhere.

### The shape of the thing, provisionally

Discussed by the team on 21 September. The real plugin interface gets defined
later with the community group, so the job now is to explore what it could
look like, pick something, and write down why. This is that record, and it is
provisional on purpose.

**A web component.** The team leans this way, on the grounds that the wallet
is meant to be swappable. It matters less than it sounds, though: only the
credential goes in, and turning one kind of component into the other is cheap
— React has supported web components since version 19. So this is a starting
point, not a commitment.

**What goes in.** The expectation, and the simplest thing that works: the
credential, and possibly a set of issuer identifiers to check against. Nothing
else.

**What it owns.** All three — showing the credential, showing the
verification, and running the verification. That seems right, and it is what
this document assumes throughout.

**One constraint worth knowing now, because it shapes the design rather than
the code.** A web component sits behind a boundary, and things
the surrounding app owns don't reach across it. It can't use the wallet's own
navigation to link out to other screens, and it can't open the wallet's own
dialogs. Anything this document describes as opening for more detail — the
issuer's full details in section 5, the raw data behind the details toggle in
section 4 — has to work inside the component itself. That is not a problem, but
it does mean the interaction has to be designed for being a web component
rather than adapted to it afterwards.

---

## 3. When verification runs

Verification runs when a screen opens, the same as the mobile wallet. No
caching, no stored results, no freshness rules.

### Why we're not caching yet

This came up and we decided against it for now. The reasoning is worth
keeping, because it will come up again.

The argument for caching is that verification makes network calls to other
people's servers. During the California statewide wallet pilot, where Digital
Bazaar was hosting status endpoints for issuers, log monitoring showed that
wallets varied a lot in how often they fetched, and Digital Bazaar was worried
about the frequent ones once a statewide rollout multiplied them.

The argument against doing it now, which is the one we're taking:

- **We don't need it yet.** Nobody has enough credentials for it to matter.
- **We may actively not want it soon.** While we're working through problems
  with other vendors' credentials, always re-checking is a feature. A cache
  hides the bug you're trying to reproduce.
- **It gets easier later, not harder.** Where results would be stored depends
  on the storage layer, which isn't settled. That is the more important piece,
  and it comes first.

**What would bring this back:** the storage layer settling, or us actually
seeing a load problem.

### What we shouldn't do, caching aside

Some of the work doesn't need the network at all, and we shouldn't pretend it
does:

- **Expiry is a date comparison.** No server involved. Today it happens inside
  the same library call as the signature check, so we can't run it on its own
  yet, but it costs nothing.
- **`did:key` issuers need no lookup.** The signing key is inside the
  identifier. Only `did:web` issuers require fetching anything.

So for a `did:key` credential the only outside calls are the revocation list
and the issuer registry. Worth knowing when this conversation reopens.

### What mobile actually does today

Worth recording accurately, because we got this wrong once.

The mobile app has a fifteen-minute cache, but **the credential detail screen
deliberately skips it** — it passes a flag that forces a fresh check every
time. The badges in the credential list do use the cache. So opening a
credential does re-check it; that's by design, not an oversight.

The two paths also don't return quite the same thing. The fresh one includes a
timestamp and reads the list of checks from one place in the response; the
cached one has no timestamp and reads it from another. That works out fine
today, because only the detail screen shows a "last checked" line. It is the
kind of thing to be careful about if we ever do add caching.

### One thing we do need

**An unreachable registry has to be handled properly.** This is separate from
caching, and it is agreed.

Our issuer registries are files hosted on GitHub Pages. One has been seen to
fail to load, and another organisation reported verification trouble when
relying on them. GitHub's bandwidth limits are high enough that throttling is
unlikely, so this is probably ordinary network flakiness — which means caching
wouldn't fix it anyway. We have to handle it either way.

**Registry lookups themselves work in a browser.** Tested 21 September against
the real registry, in a browser, with verifier-core as published: the request
succeeds and the registry is read. So an unreachable registry really is
occasional flakiness, not something broken by design. That matters for the
wording, because it means "we couldn't confirm the issuer" comes from a genuine
gap in registry coverage rather than from a fault of ours.

**The withdrawal check is a different story.** The same test found that fetching
an issuer's withdrawal list fails in a browser, for a reason particular to
browsers, and it fails every time rather than occasionally. It is fixable and
veri-good already worked around it. But until it is fixed, *"we couldn't check
whether this has been withdrawn" is the normal result, not the rare one.* Two
consequences: the "couldn't check" severity carries far more weight at launch
than the appendix implies, and it needs to be genuinely well written rather
than an edge case we tidy up later.

The requirement: **"we couldn't reach the registry" must never look like "this
credential is bad."** More on this in section 5.

---

## 4. What it shows

### Four severities, and a list of messages

This is the part worth getting right, because everything else hangs off it.

There are **four severity levels**, and that set doesn't grow:

| | Meaning | What the person should do |
|---|---|---|
| **Success** | Everything checked out | Nothing |
| **Warning** | Real, but with something worth knowing | Read it; maybe act |
| **Error** | Don't rely on this | Contact the issuer |
| **Couldn't check** | We weren't able to complete a check | Try again |

Underneath, there is a **growing list of messages**, and each one maps to a
severity. That list gets longer as we handle more cases. The severities don't.

Keeping these separate matters. It means "this was withdrawn" and "this
signature doesn't match" can be two different messages that both show as
errors, instead of being squeezed into one box. And it means a new problem
never requires redesigning the display.

Two consequences we've already agreed:

- **"Withdrawn" and "couldn't be verified" are separate messages**, and you
  can open either one to see what happened.
- **"We couldn't check" is its own severity, not a failure.** A network
  problem is not a verdict. This has to reach the credential list too, where a
  grey "not checked" is honest and a red "not verified" would frighten someone
  about a perfectly good credential.

And one requirement that comes from how the library actually reports results:

- **The issuer check cannot be read at face value.** It reports the same plain
  "no" whether the issuer isn't listed or a registry couldn't be reached. The
  two are only distinguishable by a second piece of the result, which says which
  registries failed. Anything that reads the "no" and stops will show "issuer
  not recognised" during a network failure — which is precisely the mistake
  section 3 says must never happen. It is one extra check, but nobody will
  discover the need for it on their own, so it is written down here.

### The list of credentials

One badge per credential, in four states matching the severities above, plus a
"checking" state while work is in progress.

The rules for rolling several checks up into one badge come from the mobile
wallet, with one change: withdrawn and unverifiable are no longer the same
badge, and an unreachable registry shows as "not checked" rather than a
failure.

### A single credential

The credential leads. Verification sits underneath it as a short line, with
detail available on request.

```
  ┌────────────────────────────────────────┐
  │  Requirements Analysis Certificate     │
  │  Sam Salmon                            │
  │  Springfield College · 12 March 2026   │
  │                                        │
  │  ✓ Verified · checked just now         │
  │                        Show details ⌄  │
  └────────────────────────────────────────┘
```

Opening the details shows each check in plain words, with the raw data one
step further in.

What December ships behind that toggle is modest: a plain list of what was
checked, and a way to copy the full result. The nicely grouped version can
come later, and it depends on two unanswered questions in section 7 anyway.

### Words

Some specific changes, all cheap:

- **"Withdrawn," not "revoked."** "Revoked" sounds far more serious than it
  often is. Say what it means: *this is no longer a valid credential, and a
  new copy must be obtained from the issuer.*
- **"Hasn't been changed since it was issued,"** rather than "has a valid
  signature."
- **"The issuer hasn't withdrawn it,"** rather than "has not been revoked."
- **Relative times.** "Checked 2 hours ago" rather than a full timestamp. The
  exact time can sit in the details. It must not be hover-only, since that
  leaves out keyboard, screen reader and touch users.

The technical words are still right in the detail view. They're just a barrier
on the main screen.

### Every problem says what to do

The "what the person should do" column above is a requirement, not a note. A
problem with no suggested action reads like an accusation.

The advice has to match the cause, though. For a **withdrawn** credential the
issuer already made their decision, so the useful advice is to ask for a
replacement. For a **signature that doesn't match**, a fresh copy genuinely
helps. Those shouldn't share wording.

### Two accessibility rules

Not enhancements. These are baseline, and for a non-profit selling to
universities they may well be a procurement requirement.

- **Results are announced, not just drawn.** They arrive after the screen has
  settled, so someone using a screen reader can miss them entirely unless we
  say something.
- **Colour never carries the message alone.** Red, amber and green is the
  hardest combination for the most common form of colour blindness. Always an
  icon and words as well.

---

## 5. Issuers we don't recognise

This is the hardest part, and there's no good example to copy.

Most issuers are not in any registry. Ours are new and thinly populated. So
"we don't recognise them" must not read as "this is fake" — while we also must
not suggest that an unrecognised credential is trustworthy.

Both mistakes are real:

```
  Say too little  →  "Verified ✓"
                     They think we vouched for the issuer. We didn't.

  Say too much    →  "Unknown issuer ✕"
                     They think their real diploma is fake. It isn't.
```

### Two different questions

The way out is to stop giving one answer. These are separate:

| | Question | Answered by | How sure can we be |
|---|---|---|---|
| **Was it changed?** | Has anything been altered since it was signed? | mathematics | very sure |
| **Who issued it?** | Do we know who this is? | a list we keep | incomplete by design |

### Show where the name came from

The answer to "who issued it" isn't yes or no. It's a name, plus where that
name came from:

```
  Springfield College        found in the DCC Registry
  Springfield College        the credential says so; we couldn't confirm it
  did:key:z6Mkn…             no name available at all
```

That third case is real. Sometimes there is only an identifier and nothing
else, because the issuer built the credential for an audience who already knew
them.

Showing the source turns a frightening yes/no into a plain statement of what
we know. It should appear near the issuer's name in the main view as a short
marker, and also alongside the other checks, even though that repeats it a
little.

There should be a way to see the issuer's full details — in Open Badges that
often includes a name, logo, website and contact address. That is also the
right home for the raw identifier.

### Suggested wording

> **ⓘ Genuine, but we can't confirm who issued it**
>
> This credential hasn't been changed since it was issued, and the issuer
> hasn't withdrawn it.
>
> It says it was issued by **Springfield College**. We couldn't confirm that
> independently — they aren't in any registry we check, which is common. It
> doesn't mean the credential is fake.

Four choices worth explaining:

**One sentence, not two verdicts.** An earlier draft put a green "intact" mark
next to a grey "issuer not listed" mark. People scan. They read the first
thing and stop, so a green tick first produces exactly the false reassurance
we're trying to avoid. "X, but Y" is how people naturally hold a fact with a
catch, and you can't half-read it.

**"Hasn't been changed since it was issued."** Not "valid," which sounds like
we're endorsing it. Not "intact" either, which is a word about files and
parcels and makes people wonder what might have damaged it.

**The issuer's own name, not the identifier.** Someone can't do anything with
`did:key:z6Mkn…`. They can't look it up or contact it. They can recognise a
college name. The identifier belongs in the details.

**ⓘ, not ⚠.** A warning triangle says something is wrong. Nothing is wrong.
Something is unknown.

Both halves of the last sentence are doing work. "We couldn't confirm that"
stops us overclaiming. "It doesn't mean the credential is fake" stops the
false alarm. Neither works on its own.

### A fourth case

When the registry itself is unreachable we know less than in any of the cases
above, and that has to read differently from "they aren't listed." Given that
our registries are static files on GitHub Pages and have failed at least once,
this will happen to real people.

Two things we now know, from testing on 21 September:

- **The result tells us which registry failed, by name.** So this case can say
  something specific rather than gesturing at a general problem.
- **It is distinguishable from "not listed" only if you look for it.** See the
  requirement at the end of section 4. Get this wrong and the fourth case
  silently becomes the second one.

### Two things to keep in view

**What the recipient sees.** This whole document rests on a question about
sending a credential to someone, and we never say what their software will
show. The sequence that costs the most trust is easy to picture: our wallet
says verified, the person sends it, the recipient's checker says "unknown
issuer," and they look like they're passing off a fake. So: **our wording must
never promise more than the recipient's software will show.** Whoever they
share with is going to run into the same thing we did, and the
person shouldn't be surprised by that.

**Someone could abuse this.** Every outcome in `inventory.md` assumes an
honest issuer with a broken setup. Nobody has asked what a dishonest one does,
and the answer is uncomfortable: make up an identity, issue yourself a
convincing diploma, and under this design it shows as genuine with a friendly
note saying unrecognised issuers are normal.

Showing the credential anyway is still right. Refusing helps nobody and
punishes the honest majority, who are most of the population given how thin
the registries are. But it does mean **the wording is the only protection we
have here**, which is why it deserves this much attention.

---

## 6. Set aside for now

Things we considered and decided not to do yet, with what would change our
minds. Keeping this list is the point. Without it, all of this gets argued
again in six weeks by someone who wasn't in the conversation.

**Caching verification results.**
Why not now: we don't need it, always re-checking helps while we debug other
vendors' credentials, and it's easier to add once we know where results would
live.
What would change it: the storage layer settling, or an actual load problem.

**Where results are stored.**
The eventual picture is a small verification history per credential kept in
the user's cloud storage, with revocation checked more often than everything
else. Deliberately undecided, because it follows the storage layer.

**Different freshness rules per check.**
Signatures never change. Expiry is a date. Revocation genuinely changes. That
these deserve different treatment is right, and it's the frame to
pick up when caching comes back. Not now.

**Working offline.**
We're not building an offline experience for this release. The original
argument was also weaker than it looked: the wallet can't prove anything to
anyone else, so a green tick with no signal doesn't help you at a border or in
an interview. What survives is simply not showing a red error when the real
answer is "no network," and that's already the info severity.

**Letting people name issuers themselves.**
One idea: someone could say "this is University of Oregon Libraries" and
have it remembered. Given how far behind registry coverage is, giving people a
way to resolve these themselves is probably important eventually. Worth
designing once registries are further along.

**Showing raw error codes.**
This is worth questioning. Those codes come from a library still in beta,
and putting them on screen quietly turns them into something people depend on.
Either we decide they're a stable published interface, or we show a stable
message and keep the code in the copyable output.

---

## 7. Decisions we need

**On the plugin model**

1. **What is a plugin here, and what are plugins for?** Where the code lives is
   settled — a separate repository, agreed 21 September. The question underneath
   it isn't. The point stands: displaying credentials, verifying them, and
   deciding whether to keep a received one all look like core wallet
   capabilities. The questions asked plainly, and still unanswered: what the
   goals for plugins are, what a plugin is, how one gets enabled or disabled,
   and how it is allowed to touch the user's data and the rest of the app. One
   view is that the plugin requirements should be discussed before the
   implementation is chosen. Until that happens, the shape described in
   section 2 stays provisional.
2. Does the direction in sections 4 and 5 look right?

**On verifier-core and intake**

3. Is the improved version of verifier-core going into the published package,
   or do we depend on the fork directly? It isn't published today.
4. The registry results on the issuer check don't match between the running
   code and the published type definitions (see `inventory.md`). Confirmed 21
   September, and it is not simply a pair of different names: the two describe
   different shapes of data. The running code attaches a list of objects; the
   type definitions describe a list of plain strings. So it can't be fixed by
   renaming — which one is intended?
5. Time to walk through the credential intake architecture you've built, and
   what may need discussion before it lands.

**On the size of December**

6. **Are intake and sharing in December?** This is the big one. It changes the
   size of the release, not just this document.
7. If we're not copying the mobile wallet exactly, what keeps December honest
   instead?
8. Do we treat error codes as something people can rely on?

---

## 8. Not covered here

- **Getting credentials into the wallet.** See the open question in section 2.
- **Sharing and public links.** Same.
- **Issuer-designed layouts.** The idea that an issuer says how their
  credential should look. Real, and further out than December.
- **Which fields to display.** A credential's shape isn't known until you open
  it, so the existing approach is deliberately minimal: a title from the
  obvious place with fallbacks, and few fields. December inherits that.
