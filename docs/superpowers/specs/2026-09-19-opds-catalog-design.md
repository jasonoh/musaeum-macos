# Design: OPDS catalog server (delivery to a second device)

**Date:** 2026-09-19
**Status:** **Proposed — conditional.** Read the precondition before the design.
**Scope:** an OPDS 1.2 catalog served by the running app, so another device can browse and
download the library without a browser, a sync client, or a second copy of the books.
**Related:** the iOS/REST contract staged at `electron/main/api/rest.ts` (a different consumer —
see D3). The reader (`specs/2026-08-13-native-reader-design.md`) is unrelated but shares the
containment rule this feature must reuse.

---

## Precondition — this is the whole reason the doc is short on enthusiasm

**Do not build this without a device that will consume it.** The analysis behind it put OPDS in
a "conditional" bucket: the trigger is **a second reading device that speaks OPDS** — a Boox, a
Kobo running KOReader, a phone running KOReader or Librera. Until that device exists, not
building this is the correct default, and nothing below changes that.

Two further things must be true at the same time, and both are properties of the _machine_, not
the feature:

1. **The Mac is awake with the app running and the share mounted.** OPDS is served by the app
   from the live library; it is not a background service and it does not cache books locally.
2. **The security posture is decided** (see Security). This is the app's **first network
   surface** — for a tool whose entire data model was arranged around "nothing listens", that is
   a posture change, not a checkbox.

If the trigger fires, this spec is actionable as written. If it does not, the correct action is
to leave it in tasks.md.

---

## What OPDS is, and what it is not

OPDS is a **delivery** protocol: an Atom feed carrying `<link>` elements per publication, which
a client renders as a browsable catalogue and downloads from. The client reads the file
**locally** afterwards.

Notable consequences, both worth stating because they are easy to assume otherwise:

- **It is not remote reading.** The device downloads the book and reads it with its own engine.
  There is no streaming, and no OPDS-PSE (page-streaming) in scope.
- **It does not carry Musaeum's reading position.** OPDS 1.2's closest relation,
  `http://opds-spec.org/shelf`, means "content previously acquired by the user"
  (`opds-1.2` §6.1) — not a progress ledger. Reading-position sync stays with the staged
  REST/iOS contract. Anyone expecting the Boox to resume where the Mac left off should know
  that this feature does not deliver it.

### Version: 1.2 (Atom/XML), not 2.0 (RWPM/JSON)

OPDS 2.0 is the current specification (Readium Web Publication Manifest + JSON-LD); 1.2 is the
Atom-based historical version that the client population actually implements. KOReader — the
realistic client here — **handles both**: `plugins/opds.koplugin/opdsbrowser.lua` carries a
`getItemFromPublication` path that reads `entry.metadata` (the RWPM shape) alongside its Atom
path. Read at pinned ref `5e45c4b5`; re-check against the current release before building.

1.2 is chosen as the common denominator: it is what KOReader, Librera, FBReader, Thorium and
every Calibre-Web client read, and hand-rolled Atom is deterministic and unit-testable in a way
that JSON-LD contexts are not, for our purposes.

_Reversal:_ if the only device is Thorium or another Readium-based client that speaks 2.0 and
not 1.2, emit 2.0 instead — the data model work is shared, and the pure builders are the only
thing that changes.

---

## Architecture

Following the repo's layering: the HTTP layer is thin, the protocol logic is pure, and the
existing security boundary is reused rather than re-derived.

```
electron/main/index.ts            startOpdsIfEnabled() next to startRestApiIfEnabled()
├── api/opds.ts                   node:http server, routing, auth, byte streaming (thin)
├── services/opds/
│   ├── feed.ts                   PURE: Book[] → XML (root, nav, acquisition, entry, OpenSearch)
│   └── feed.test.ts              golden files + escaping + pagination cases
└── services/book-bytes.ts        resolveBookFile() — REUSED, not reimplemented (D6)
```

**No new dependency.** `node:http` plus one `escapeXml` helper covers this; the repo carries no
web framework and neither express nor an XML library earns its place here (D7). Electron's main
process is Node, so `node:http` is available without anything being added.

### Routes (slice O1 — the useful half)

| Route                                | Kind                   | Media type / behaviour                                   |
| ------------------------------------ | ---------------------- | -------------------------------------------------------- |
| `GET /opds`                          | Navigation Feed        | `kind=navigation`; links to the feeds below              |
| `GET /opds/new?page=N`               | Acquisition Feed       | `date_added` desc; `rel="http://opds-spec.org/sort/new"` |
| `GET /opds/all?page=N`               | Acquisition Feed       | `sort_title` asc, `id ASC` tiebreak                      |
| `GET /opds/search?q=…`               | Acquisition Feed       | the existing FTS5 path                                   |
| `GET /opds/search.xml`               | OpenSearch description | advertises the template                                  |
| `GET /opds/cover/{id}/{thumb\|full}` | image                  | `image/jpeg`                                             |
| `GET /opds/book/{id}/{format}`       | the file               | downloaded, with Content-Length                          |

### Routes (slice O2 — browse tree)

| Route                                               | Kind                                                 |
| --------------------------------------------------- | ---------------------------------------------------- |
| `GET /opds/authors`                                 | Navigation Feed of letters A–Z, `Other` for the rest |
| `GET /opds/authors/{letter}?page=N`                 | Acquisition Feed                                     |
| `GET /opds/series` → `/opds/series/{letter}?page=N` | same shape                                           |
| `GET /opds/unread?page=N`                           | Acquisition Feed over `read_status != 'read'`        |

`new` and `all` are not a browse tree, they are the two things a client needs to be _useful_:
something to fetch (new) and something complete to search within (all). O2 is what makes it
pleasant. Splitting here keeps each slice inside `CLAUDE.md`'s file bound.

**`sort/new` earns its own route for a specific reason:** KOReader's OPDS sync expects the
server to be sorted by new — its wiki says so directly ("Servers must be sorted by new") and
describes adding a custom catalog for exactly this. Without a `sort/new` feed, the sync feature
has nothing to walk.

### The feed documents

**Root (`/opds`)** is a Navigation Feed, and a Navigation Feed **must not contain catalog
entries** — its Atom entries link to other feeds (§2.2). Every catalog must have exactly one
root (§2.1), and it should be linked with `rel="start"` from every other feed (§2.1) and with
`rel="self"` (§2.6). Feed-level `atom:id`, `atom:title`, `atom:updated` are required by Atom;
`atom:author` is included for clients that display it.

**Link media types are exact strings** and are the most common way a feed gets rejected by a
picky client:

- Acquisition Feed: `application/atom+xml;profile=opds-catalog;kind=acquisition` (§2.3, §7.1.3)
- Navigation Feed: `application/atom+xml;profile=opds-catalog;kind=navigation` (§2.2, §7.1.3)

**Entries are Complete, emitted inline** — no per-book entry document route. §5.1.2 makes a
Partial entry _require_ an `alternate` link to a Complete Catalog Entry resource, and says an
entry without such a link **must include all metadata elements**. Emitting complete entries
inline is the conformant choice that bounds the build; the cost is a slightly larger feed, which
pagination absorbs (D5).

**Entry fields** (only the ones this library can actually fill):

| Element                                           | Source                                 | Notes                                                                    |
| ------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `atom:id`                                         | `urn:uuid:<book.id>`                   | book ids are already UUIDv4                                              |
| `atom:title`                                      | `title`                                | escaped                                                                  |
| `atom:author/name`                                | `author`                               | one author; the schema keeps a single string                             |
| `atom:updated`                                    | `last_modified` → `date_added` → epoch | **required by Atom**; a book with neither still needs a value            |
| `dc:language`                                     | `language`                             | omit when null                                                           |
| `dc:issued`                                       | `published_date`                       | omit when null                                                           |
| `dc:identifier`                                   | `urn:isbn:<isbn13 \| isbn10>`          | omit when neither                                                        |
| `dc:publisher`                                    | `publisher`                            | omit when null                                                           |
| `atom:category`                                   | each tag                               | `term` + `label`; no `scheme`                                            |
| `atom:summary`                                    | `description`                          | `type="text"`, no child elements (§5.1.3); truncated to a bounded length |
| `link rel="http://opds-spec.org/image"`           | `cover_full`                           | `type="image/jpeg"`                                                      |
| `link rel="http://opds-spec.org/image/thumbnail"` | `cover_thumb`                          | `type="image/jpeg"`                                                      |
| acquisition links                                 | one per format                         | see below                                                                |

**Acquisition links.** §5.3: _all_ Acquisition Links **must** include a `type` attribute. One
link per format the book has, iterated with **`orderedFormats()`** — never `formats[0]`
(invariant 3; the stored array order is whatever the writing source left). Rel value:
`http://opds-spec.org/acquisition/open-access` — these are the user's own files, delivered
without payment or registration, which is precisely what that relation means (§5.2.1).

KOReader accepts any of `download`, `publication`, `http://opds-spec.org/acquisition`, and
`http://opds-spec.org/acquisition/open-access` for a downloadable item, so the most specific
relation is also the compatible one.

| Format | `type`                           |
| ------ | -------------------------------- |
| epub   | `application/epub+zip`           |
| pdf    | `application/pdf`                |
| mobi   | `application/x-mobipocket-ebook` |
| azw3   | `application/x-mobipocket-ebook` |

The two Mobipocket types are **unregistered** and deliberately shared: there is no registered
media type for KF8, the de-facto value used by existing catalogs is
`application/x-mobipocket-ebook`, and a client that filters by type would otherwise see two
distinct Mobipocket formats. `application/vnd.amazon.ebook` is the alternative some catalogs
use for azw3 — recorded here so a later change is a decision rather than a drive-by edit.

**Images must be GIF, JPEG or PNG** (§5.2.2). Ours are JPEG at both sizes, which is why
`cover_full.jpg` / `cover_thumb.jpg` map directly.

### Pagination

`rel="next"` links in the feed body, per RFC5005 §3 (which §2.4 of OPDS 1.2 references for
paginated responses). Page size is a constant to be chosen by measurement — target **< 500KB of
XML per page** with real descriptions, which for this library means a few dozen entries. The
last page carries no `next` link. Emit `opensearch:totalResults` and `opensearch:itemsPerPage`
on paginated feeds (§3 permits OpenSearch elements in feed documents).

**Feed sorting reuses the service-layer query path.** The alternative — a second SQL path for
books — is how the sort-key rule (invariant 4) and the filter rules drift between the UI and
this feature. If the existing query builder does not admit `LIMIT`/`OFFSET`, that is the one
place O1 adds a query, and it should be added _to the existing builder_, not beside it. This is
the first thing to check during implementation.

### Search

OPDS search is an OpenSearch description document advertised with `rel="search"` and
`type="application/opensearchdescription+xml"` (§3), whose `Url` element **must** use the OPDS
acquisition media type:

```xml
<Url type="application/atom+xml;profile=opds-catalog;kind=acquisition"
     template="http://<host>:<port>/opds/search?q={searchTerms}" />
```

The backing query is the FTS5 path the app already uses, so a client's search box gets the same
results as the library's own search — with the same caveat that it searches **metadata, not page
text** (title, author, series, tags, description).

### Security

OPDS 1.2 §7.2.1 is direct: client and server implementations _"must be capable of being
configured to use HTTP Basic Authentication in conjunction with a connection made with TLS
1.3"_, and unauthorized requests should be answered with an appropriate 4xx — **401 with
`WWW-Authenticate: Basic realm="Musaeum"`**. That is the authentication design; there is no
cookie, session, or OAuth in scope.

**The TLS half is delegated to the transport, and that is a decision with a residual risk.**
Musaeum will not terminate TLS in-app. So:

- **Default bind is `127.0.0.1`.** On loopback, plain HTTP exposes nothing to the network.
- **A non-loopback bind is a separate, explicit opt-in**, with a warning in the UI, because
  Basic over plain HTTP on an untrusted LAN sends the credential in the clear on every request.
- **The recommended non-loopback transport is Tailscale**, where the link is WireGuard-encrypted
  and the interface can be bound specifically. (This machine is already on a tailnet, so that is
  available rather than hypothetical.)

**Credential handling** follows the `google_books_api_key` precedent — an `app_config` key, set
in Settings, winning over nothing else — with one deliberate difference: the value is a
**generated 32-hex-character token by default**, not a user-chosen password. A token that is
only ever used here cannot be a reused credential from somewhere else, and it is not worth
guessing. If a human-readable password is ever wanted, the stronger storage is Electron's
`safeStorage` (macOS Keychain); that is a follow-up decision, recorded rather than assumed.

Comparison is constant-time (`crypto.timingSafeEqual`). Failed auth is logged with the client
address and nothing else — never the attempted credential.

### Failure semantics (invariant 12)

The server is a _reporter_, never a fatal path:

- **Port in use / bind failure** → logged, surfaced as a status line in Settings, and the app
  starts normally. It must never prevent the window from opening.
- **NAS offline** → acquisition feeds serve from the SQLite cache (the library still browses,
  matching offline mode's "full browse, no write ops"); **downloads answer 503** with a short
  body, because the bytes genuinely are not reachable.
- **Unknown book, unknown format, missing file, traversal attempt** → **404**, uniform and
  reason-free, exactly as the `musaeum://` routes behave (they answer 404 "rather than leaking
  which of the reasons applied").
- **No library configured yet** → 503 from `/opds`, so a client sees "server busy" rather than
  an empty catalog it will cache.

---

## Out of scope

Facets (§4), Complete/Crawlable Acquisition Feeds and the `fh:complete` element (§2.5),
`opds:indirectAcquisition` and prices (the whole buy/borrow/subscribe family), OPDS-PSE page
streaming, `rel="shelf"` (see above), TLS termination, HTTP range requests (whole-file downloads
only), conditional GET / `ETag` / `If-None-Match` on feeds, multi-user or per-user shelves, an
upload path, a web UI, remote reading, **reading-position sync**, comic/CBZ formats (the app does
not support them at all), and the **REST/iOS contract**, which stays its own staged, disabled
module.

Conditional GET is the one omission worth revisiting cheaply: if a device re-walks a large
catalog and feels slow, `ETag`/`Last-Modified` on feed responses is a small, contained win.

---

## Decisions

**D1 — Conditional. Not built without a consuming device.** (Precondition above.)
_Rejected:_ building it now because it is cheap and interesting. Its cost is not the code; it is
a permanent network surface on a box holding the library.

**D2 — OPDS 1.2 (Atom/XML), not 2.0 (RWPM/JSON).** Broadest client coverage; deterministic and
unit-testable output.
_Rejected:_ 2.0 as the primary, which JSON-encodes more directly from SQLite but serves a
smaller client set.
_Reversal:_ the only client turns out to be Readium-based and speaks 2.0 only.

**D3 — A new `opds_enabled` key, not a reuse of `rest_api_enabled`.** The REST flag gates the
staged iOS contract; overloading it would make enabling OPDS change the meaning of a different,
deliberately-staged feature, and would couple two contracts that have nothing to do with each
other.
_Rejected:_ one "expose an API" switch.
_Reversal:_ the REST API ships and both surfaces are managed as one "network" section — a UI
grouping decision, not a flag merge.

**D4 — Loopback by default; non-loopback is an explicit opt-in; TLS delegated to the transport.**
_Rejected:_ binding `0.0.0.0` for convenience (a credential over plain HTTP on a home LAN), and
self-signed TLS in-app (certificate trust on the device is a worse problem than the transport
one, and the transport already has a good answer here).
_Reversal:_ a device that cannot use Tailscale or any encrypted tunnel **and** must reach the
library over an untrusted network. At that point the answer is TLS with a real certificate, not
a wider bind.

**D5 — Complete entries inline; no per-book entry documents.**
§5.1.2 makes a Partial entry _require_ an `alternate` link to a Complete Catalog Entry, which
would mean a second route per book for a benefit (smaller feeds) that pagination already buys.
_Rejected:_ partial entries + `alternate` links.
_Reversal:_ a client that chokes on a few hundred KB of feed while a paginated feed is already
in place — measure first.

**D6 — Reuse `resolveBookFile()` for both the download and the cover route.**
`services/book-bytes.ts` is the security boundary for turning a book id plus a format into a
path: it validates against a format allowlist, resolves by **extension** (never the canonical
filename — invariant 2), rejects a traversing `nasPath`, and **realpaths both the root and the
candidate** before comparing (invariant 9). A second resolver written beside it would be a
second place to get that wrong, and the wrong version would be the one exposed to a network.
_Rejected:_ a purpose-built resolver for HTTP.
_Reversal:_ none foreseen — if OPDS needs a resolution rule the existing function lacks, that
rule belongs _in_ the function, shared.

**D7 — No new dependency.** `node:http` + hand-rolled XML with a single `escapeXml`.
_Rejected:_ a web framework (nothing here needs routing beyond a switch, middleware beyond one
auth check) and an XML builder (one function, ~4 characters, well-tested).
_Reversal:_ if feed generation grows facets and indirect acquisitions, a builder starts to earn
its place.

**D8 — Generated token in `app_config`, matching the Google Books key's storage path.**
_Rejected:_ a user-chosen password in plaintext config (invites credential reuse), and
`safeStorage` on day one (added complexity before there is a user-chosen secret to protect).
_Reversal:_ a human-readable password is wanted → move to `safeStorage`.

**D9 — O1 (server, auth, new/all/search, covers, downloads) before O2 (browse tree).**
Each stays inside the file bound, O1 is independently useful, and O2 is a pure addition to the
root feed's link list.
_Rejected:_ one slice.
_Reversal:_ none — this is sequencing, and O2 can follow immediately if O1 lands cheaply.

---

## Acceptance criteria

**O1 — the server is usable and conformant**

- **AC2.1** `GET /opds` with no credentials → **401** and a `WWW-Authenticate: Basic` header.
- **AC2.2** With credentials → 200 and exactly
  `application/atom+xml;profile=opds-catalog;kind=navigation`; the document's entries link to
  acquisition feeds and contain **no** catalog entries (§2.2).
- **AC2.3** Every acquisition link carries a `type` attribute (§5.3, a MUST) and exactly one
  relation from the acquisition family.
- **AC2.4** **Escaping round-trips.** A title containing `&`, `<`, `>`, `"`, `'` and a non-ASCII
  character produces well-formed XML that parses back to the original string. _Instrument:_ unit
  case with those literals; this is the hand-rolled-emitter failure, and the case exists because
  of it.
- **AC2.5** A book with three formats yields three acquisition links **in `orderedFormats()`
  order**, and a book whose `formats` array is stored in a different order yields the same link
  order (invariant 3).
- **AC2.6** Pagination: page N carries a `rel="next"` link while entries remain and none on the
  last page; across all pages every book appears exactly once.
- **AC2.7** A book with no cover yields no artwork links rather than a broken URL; `/opds/cover`
  for it answers 404.
- **AC2.8** `/opds/book/{id}/{format}` serves bytes **identical to the file on disk** (hash
  compare) with a correct `Content-Length`, and answers 404 for: an unknown format, a format the
  book does not have, a book id that does not exist, and a `nasPath` that escapes the root.
- **AC2.9** `/opds/search.xml` is served with `application/opensearchdescription+xml`, its
  template resolves against the live server, and `?q=` returns the same books the app's own
  search returns for that query.
- **AC2.10** The server binds `127.0.0.1` by default and refuses a non-loopback address without
  the explicit opt-in.
- **AC2.11** **A bind failure is not fatal**: with the port occupied, the app starts, the
  library works, and the reason is visible in Settings.
- **AC2.12** With the NAS unmounted: `/opds` and `/opds/all` still answer 200 from the cache;
  `/opds/book/...` answers 503; the app is unaffected.
- **AC2.13** `opds_enabled = false` (the default) means nothing listens at all — verified by a
  connection attempt being refused.
- **AC2.14** Exactly one `startOpdsIfEnabled()` call site, and the REST stub's behaviour is
  unchanged with `rest_api_enabled` set (D3).
- **AC2.15** `npm run typecheck` (0), `npm run lint` (0), `npm test` green.

**O2 — the browse tree**

- **AC2.16** `/opds/new` is ordered by `date_added` descending and advertised from the root with
  `rel="http://opds-spec.org/sort/new"` (§6.2 — "most recent items first" is the spec's own
  ordering requirement).
- **AC2.17** `/opds/authors` is a navigation feed whose entries link to acquisition feeds, one
  per letter, with no author appearing under two letters, and every author in the library
  reachable.
- **AC2.18** `/opds/unread` matches the app's own unread count. _Instrument:_ compare against
  `getFacets().readStatus`.

**Live, on the real device — the only test that proves the point**

- **AC2.19** KOReader (or the actual device's client) can add the catalog by URL with a
  username/token, browse, search, download a book, and open it. Recorded in the CHANGELOG with
  the client version.
- **AC2.20** If OPDS sync is wanted, the device's sync walks `/opds/new` without error.

---

## Testing

**vitest (main process)** — the pure builders carry almost every criterion:

- Golden-file cases per feed type (root, `new`, `all`, one author letter, `unread`), with the
  fixtures exercising: escaping (AC2.4), multi-format ordering (AC2.5), missing cover (AC2.7),
  missing author/publisher/description/language/dates, a `series_index` of `null`, and the
  `atom:updated` fallback chain.
- Pagination arithmetic (AC2.6) as a pure function over entry counts.
- Search: the template substitution and a query round-trip against a fixture library.
- Route resolution for the file route (AC2.8), reusing `book-bytes.ts`'s already-tested resolver
  plus the HTTP-level 404 branches — this is why the resolver is reused rather than re-derived.

**Not proposed for v1:** validating generated feeds against the OPDS 1.2 spec's own RELAX NG
schema (Appendix B of the specification). It is the strongest available instrument and it is
deliberately not taken now, because it needs an XML validator as a dev dependency for a feature
that may never be enabled. Recorded as the upgrade path if this feature gets real use.

**Manual/live:** the AC2.19 walkthrough against a real client, plus `curl` checks of the auth
paths (no credentials, wrong token, correct token) and a mid-download disconnect.

---

## Implementation notes (routing for a cold session)

**Read first, per `CLAUDE.md`'s table:**

- `docs/data-contracts.md` — the preload/IPC surface, `app_config` keys, and the sidecar
  contract, since Settings changes touch the same stored shapes.
- `docs/invariants/settings-and-editing.md` — **required before adding any `app_config` key**:
  this feature adds three (`opds_enabled`, `opds_port`, `opds_token`) plus, if the token is
  user-editable, the rules that govern a cleared field.
- `docs/invariants/reader.md` — for the `musaeum://` protocol's containment rules, which the
  download/cover routes mirror.
- `docs/invariants/files-and-deletion.md` — extension-based resolution (§invariant 2), which the
  download route depends on.

**Invariants at risk:**

| #   | Rule                                              | How this feature touches it                                  |
| --- | ------------------------------------------------- | ------------------------------------------------------------ |
| 3   | Nothing may read `formats[0]`                     | Acquisition links iterate `orderedFormats()` (AC2.5)         |
| 4   | Sort keys derived at every write path             | Feeds must sort with the existing SQL, not a second ordering |
| 8   | Business logic in `services/`                     | `api/opds.ts` is thin; all feed logic is a pure service      |
| 9   | No `file://` to the renderer; realpath both sides | Reuse `resolveBookFile` verbatim (D6)                        |
| 12  | Failures stay non-fatal                           | AC2.11, AC2.12 — the server never blocks app startup         |

**Ownership:** `main-engineer` for the server, feed builders, and config keys;
`contracts-engineer` for the `settings.types.ts` / `EditableSettings` changes; and the Settings
UI row is `renderer-engineer`. That is three owners across one slice — the shape `CLAUDE.md`
says to escalate if it is not already agreed, so **confirm the split before starting**.

**Expected footprint (O1): ~9–10 code files, at the file bound.**

| File                                        | Change                                                        |
| ------------------------------------------- | ------------------------------------------------------------- |
| `electron/main/api/opds.ts`                 | new — server, routes, auth, streaming                         |
| `electron/main/services/opds/feed.ts`       | new — pure builders + `escapeXml`                             |
| `electron/main/services/opds/feed.test.ts`  | new — the cases above                                         |
| `electron/main/services/settings.ts`        | new keys, validation, defaults                                |
| `src/types/settings.types.ts`               | `EditableSettings` + `SettingsView` additions                 |
| `src/components/settings/SettingsModal.tsx` | the OPDS row (enable, port, token, test)                      |
| `electron/main/index.ts`                    | one call site                                                 |
| `electron/main/services/db.ts`              | only if pagination belongs in the query builder — check first |
| `docs/invariants/settings-and-editing.md`   | the new keys and their rules                                  |

O2 adds roughly four more (nav-feed builders, two routes, their cases) and is a separate slice
for that reason.

**Settings surface, concretely** (follow the existing field conventions — validation before
write, placeholders showing the value in force, clearing a field deleting the key so
auto-detection/absence resumes, and a failed save leaving the previous settings intact):

- `opds_enabled` — off by default.
- `opds_port` — default to be chosen (avoid 8787, which is taken on this machine).
- `opds_token` — generated, masked in the UI, with the full URL shown for typing into the device.
- Bind address — loopback default, non-loopback behind the D4 warning.

**Gate before hand-back:** `npm run typecheck`, `npm run lint`, `npm test`, the `curl` auth
checks, and the live client walkthrough (AC2.19). This is a visible feature — it earns a
CHANGELOG entry with the client version and what was actually measured, and `docs/architecture.md`
gains the server in its process model.
