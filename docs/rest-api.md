# The Musaeum REST API — the client contract

**Version 1** (`apiVersion` in the health payload; a payload change bumps it). **Status:** the read surface and the one write — slices 1b and 1c of the iOS companion workstream (`docs/superpowers/specs/2026-09-22-ios-companion-design.md`). The client lives in its own repository and is written against this document.

This file, the golden payloads in `electron/main/services/api/shape.test.ts` and `scripts/api-smoke.sh` are the contract, and they are each other's decider: the goldens are parsed from the `json payload=…` blocks below and compared field for field with what the server builds, so a field added to one and not the other fails the suite (AC19). A contract change is a change to all three in one slice — a field the document does not name, or names and the wire does not carry, is the drift this pair exists to catch.

The server is the running Mac app: it is reachable only while the app is open, it binds the machine's tailnet address (or `rest_api_bind` if set), and its default port is **8788**.

## Authentication

Every route requires a bearer token, generated on first enable and stored in the app's own `app_config`:

```
Authorization: Bearer <token>
```

| Answer  | When                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **401** | No `Authorization` header, a credential that does not match, or a scheme the server does not read. The reply carries `WWW-Authenticate: Bearer` and the body `{"error":"unauthorized"}`. |

The check runs before routing, so an unauthenticated request reaches no route logic — it cannot even learn that a route exists. The token is compared in constant time and never appears in a log, a payload or the server's status record.

## Methods

**Every route answers `GET` except the one write.** The four JSON routes — `/api/health`, `/api/library`, `/api/library/facets` and `/api/books/{id}` — also answer **`HEAD`**, which answers the same status and the same headers with an empty body (the usable part of a `HEAD` probe is `Content-Length` and the status). This is stated rather than implied because slice 1a's health route matched `GET` only, so `HEAD /api/health` answered **404** where a connect check belongs — and `URLSession` probes with `HEAD`. A client may use either method on those four routes.

The two byte routes are **GET-only**: `/api/books/{id}/cover` and `/api/books/{id}/file` answer 404 to a `HEAD`, deliberately (D15 — the length of a book arrives on the first response of a `GET` anyway, so a probe would cost a `stat` on the share to learn nothing new).

`PUT /api/books/{id}/reading` is the exception on both counts: it is **PUT-only**, takes a JSON body, and answers 404 to a `GET`, a `HEAD` or any other method on that path.

Every other method, and every path that is not one of the routes below, answers **404 with `{"error":"not found"}`** — uniformly, and without telling a client whether a _known_ path was behind the wrong method.

## Routes

Base URL: `http://<tailnet-address>:<port>`. Every response is JSON except the two byte routes, and every response carries `cache-control: no-store`.

| Route                                        | Answers                                                                     | Statuses                               |
| -------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| `GET /api/health`                            | the connect check: contract version, app version, book count, library state | 200, 401, 500                          |
| `GET /api/library`                           | one page of the library, or of a search                                     | 200, 400, 401, 500                     |
| `GET /api/library/facets`                    | the filter counts                                                           | 200, 401, 500                          |
| `GET /api/books/{id}`                        | one book                                                                    | 200, 401, 404, 500                     |
| `GET /api/books/{id}/cover?size=thumb\|full` | `image/jpeg`                                                                | 200, 206, 400, 401, 404, 416, 500, 503 |
| `GET /api/books/{id}/file?format=epub`       | the book's bytes                                                            | 200, 206, 400, 401, 404, 416, 500, 503 |
| `PUT /api/books/{id}/reading`                | the book, after writing the reported fraction                               | 200, 400, 401, 404, 500                |

### `GET /api/health`

The client's connect check. Answer it before anything else: `library` says whether the share is mounted, and `books` is the size of the cache.

```json payload=health
{
  "apiVersion": 1,
  "version": "0.1.0",
  "books": 7100,
  "library": "online"
}
```

| Field        | Meaning                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiVersion` | The contract version this server speaks. A client refuses a payload it does not know.                                                                          |
| `version`    | The Mac app's own version, as `app.getVersion()` reads it.                                                                                                     |
| `books`      | Every book in the cache, counted through the same query the library route reports as `total`.                                                                  |
| `library`    | `online` or `offline` — whether the library share is mounted. `offline` does not mean the JSON routes are unusable: /api/library still answers from the cache. |

### `GET /api/library`

One page of the library, or of a search when `q` is present.

| Parameter                                            | Default                       | Notes                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `limit`                                              | `100`                         | Rows per page. Capped at **500**; a larger value is clamped and the response's `limit` says what was actually served.                                                                                                                                                    |
| `offset`                                             | `0`                           | Rows to skip.                                                                                                                                                                                                                                                            |
| `sort`                                               | `title`                       | `title`, `author`, `series`, `date_added`, `rating`, `read_status`. **With `q` and no `sort` the order is relevance** — the app's own full-text `rank` — not title order, because a search whose default were title order would disagree with the Mac's own results.     |
| `dir`                                                | the field's natural direction | `asc` or `desc`. Absent, `date_added` and `rating` are newest/highest first and everything else ascending — the same rule the app's own sort control uses.                                                                                                               |
| `q`                                                  | —                             | A search term, matched through the app's own full-text path (title, author, series, tags, description), so a phone search and a Mac search agree. Terms are ANDed and prefix-matched.                                                                                    |
| `authors`, `series`, `tags`, `formats`, `readStatus` | —                             | Filters. Comma-separated or repeated (`?tags=a&tags=b` reads the same as `?tags=a,b`); `formats` takes `epub`, `mobi`, `azw3`, `pdf`, and `readStatus` takes `unread`, `reading`, `read`. Multiple values within one parameter are ORed; different parameters are ANDed. |
| `minRating`                                          | —                             | A whole number; a book matches when its rating is at least this.                                                                                                                                                                                                         |

```json payload=library
{
  "books": [
    {
      "id": "6f1a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
      "title": "Leviathan Wakes",
      "author": "James S. A. Corey",
      "publisher": "Orbit",
      "publishedDate": "2011-06-15",
      "language": "en",
      "description": "Humanity has colonized the solar system — and the protomolecule is loose.",
      "isbn10": "0316123266",
      "isbn13": "9780316123265",
      "goodreadsId": "8855321",
      "openlibraryId": "OL25167455W",
      "seriesName": "The Expanse",
      "seriesIndex": 1,
      "seriesTotal": 9,
      "tags": ["space opera", "science fiction"],
      "rating": 5,
      "dateAdded": "2026-08-13T18:04:21.000Z",
      "lastModified": "2026-09-21T09:12:00.000Z",
      "formats": ["epub", "mobi"],
      "fileSizeBytes": 4731892,
      "cover": {
        "thumb": true,
        "full": true,
        "version": "2026-09-21T09:12:00.000Z"
      },
      "reading": {
        "status": "reading",
        "percent": 0.42,
        "updatedAt": "2026-09-21T09:12:00.000Z"
      }
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

| Field             | Meaning                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `books`           | This page's books, in the order the app's own library view would show them for the same `sort`/`dir` — the `sort` runs server-side, on the same stored sort keys the Mac sorts by. |
| `total`           | Every row the same query matches, **independent of the page taken**: a page of 100 from 7,100 books reports `total: 7100`. Divide by `limit` for the page count.                   |
| `limit`, `offset` | The window actually served, echoed — a clamped `limit` is visible here.                                                                                                            |

**Walking the library:** request pages with `limit` and a rising `offset` until `offset + books.length >= total`. The order is stable across pages, including under a sort whose keys tie, because every ordered query ends with the book id as a tiebreak — so each book appears on exactly one page and none is skipped. A `400` (below) is the only malformed-parameter answer: a bad `limit`, `offset`, `minRating`, `sort`, `dir`, `formats` or `readStatus` is refused rather than defaulted, because a client that asked for `sort=athor` and silently received title order could never learn it had a typo.

### `GET /api/library/facets`

The filter sidebar's counts, computed over the whole library in one pass.

```json payload=facets
{
  "authors": [
    {
      "value": "James S. A. Corey",
      "count": 9
    }
  ],
  "series": [
    {
      "value": "The Expanse",
      "count": 9
    }
  ],
  "tags": [
    {
      "value": "space opera",
      "count": 412
    }
  ],
  "formats": [
    {
      "value": "epub",
      "count": 5324
    }
  ],
  "readStatus": [
    {
      "value": "reading",
      "count": 1
    }
  ]
}
```

Each array holds `{ value, count }` pairs, ordered by count descending. These counts are **not** narrowed by the list route's filters: they answer "what is in the library", not "what is in the current page", so a client can show what it may filter _to_. A value is `null`-free — an authorless book is simply absent from `authors`.

### `GET /api/books/{id}`

One book, in the same shape as a member of `books` above (the `payload=book` golden). `404` for an id the cache does not hold (`{"error":"not found"}`).

```json payload=book
{
  "id": "6f1a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "title": "Leviathan Wakes",
  "author": "James S. A. Corey",
  "publisher": "Orbit",
  "publishedDate": "2011-06-15",
  "language": "en",
  "description": "Humanity has colonized the solar system — and the protomolecule is loose.",
  "isbn10": "0316123266",
  "isbn13": "9780316123265",
  "goodreadsId": "8855321",
  "openlibraryId": "OL25167455W",
  "seriesName": "The Expanse",
  "seriesIndex": 1,
  "seriesTotal": 9,
  "tags": ["space opera", "science fiction"],
  "rating": 5,
  "dateAdded": "2026-08-13T18:04:21.000Z",
  "lastModified": "2026-09-21T09:12:00.000Z",
  "formats": ["epub", "mobi"],
  "fileSizeBytes": 4731892,
  "cover": {
    "thumb": true,
    "full": true,
    "version": "2026-09-21T09:12:00.000Z"
  },
  "reading": {
    "status": "reading",
    "percent": 0.42,
    "updatedAt": "2026-09-21T09:12:00.000Z"
  }
}
```

Every field is always present; a value the row does not hold is `null` (never absent, never `0`), so a client's decoding is unconditional. Three members deserve their own sentence:

- **`formats`** is in preference order — `epub`, `azw3`, `mobi`, `pdf` — so `formats[0]` is the file the reader would open. The stored order is whatever the writing source left and is deliberately not on the wire.
- **`cover`** reports whether each size exists, plus the row's `lastModified` as a **version**. The client appends it to its own cache key (`…/cover?size=full&v=<version>`, an extra query parameter the route ignores): covers are fixed filenames, so without a version a replaced cover is answered from a cache — measured in the app on 2026-09-21, the same URL kept painting the old image after the file on disk had changed.
- **`reading`** is the phone's whole view of where the book is: `status` (`unread`/`reading`/`read`), `percent` (a fraction, `0.42` = 42%), and `updatedAt` (when this machine last recorded state — `null` if it never has, which is _not_ the same as 0%). A `percent` of `null` means the book has never been opened. The Mac's own position (an EPUB CFI) is **not** on the wire: it is a coordinate no other engine can use, which is why the fraction is the member that travels.

### `GET /api/books/{id}/cover?size=thumb|full`

The cover image's bytes, with `content-type: image/jpeg`.

| Answer  | When                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **200** | The bytes, the whole file.                                                                                                                                            |
| **400** | A `size` that is neither `thumb` nor `full`, or a row whose cover path or book folder escapes the library root.                                                       |
| **404** | An unknown book, a book with no cover of that size (`cover.thumb`/`cover.full` in the book payload is how a client knows before asking), or a row whose file is gone. |
| **503** | The share is not mounted.                                                                                                                                             |
| **206** | A satisfiable `Range` — covers go through the same byte writer as files, so a partial cover is served rather than refused. See _Resumable downloads_.                 |
| **416** | A `Range` this cover cannot satisfy, including any `Range` against a 0-byte file.                                                                                     |     |

`size` defaults to `full`. The route is **stricter than the app's own `musaeum://cover` handler on one point, deliberately**: the handler resolves anything that is not `thumb` to the full cover, because the renderer only ever asks for its two fixed strings, while this typed route refuses a third value with a 400 rather than silently serving a different image. The 400/404 split is the handler's own and is preserved by both consumers.

### `GET /api/books/{id}/file?format=epub`

The book's bytes. `format` is required and is one of `epub`, `mobi`, `azw3`, `pdf`; the file served is the book's file **of that extension** — a book renamed after import still serves, because nothing resolves by canonical filename.

The media type follows the format:

| Format | `Content-Type`                   |
| ------ | -------------------------------- |
| `epub` | `application/epub+zip`           |
| `mobi` | `application/x-mobipocket-ebook` |
| `azw3` | `application/vnd.amazon.ebook`   |
| `pdf`  | `application/pdf`                |

| Answer  | When                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **200** | The whole file, with `Content-Length` and `Accept-Ranges: bytes`.                                                                                                                                      |
| **206** | A `Range` request that can be satisfied — see _Resumable downloads_.                                                                                                                                   |
| **400** | No `format` parameter.                                                                                                                                                                                 |
| **404** | An unknown book, a format the server does not serve, a format this book does not hold, or a book whose stored folder escapes the library root. All of these are one answer, uniformly and reason-free. |
| **416** | A `Range` this file cannot satisfy.                                                                                                                                                                    |
| **503** | The share is not mounted, or the byte-transfer budget is spent.                                                                                                                                        |

### `PUT /api/books/{id}/reading`

**The one write this API has** (D4). A progress report — where the phone is in a book — with a JSON body:

```json
{ "percent": 0.42, "at": "2026-09-22T09:12:00.000Z" }
```

| Member    | Required | Meaning                                                                                                                                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `percent` | yes      | A **fraction**, `0.42` = 42%, between `0` and `1` inclusive. Not a percentage: `60` is refused rather than read as `0.6`.                                                                         |
| `at`      | no       | When the phone read that far, ISO 8601. Send it for a report that was **queued** (the server refuses one older than its own copy); omit it for a live read, when the server's clock is the truth. |

The body is read by its own field list: an unknown member is ignored, and a `position` sent anyway is **discarded, not stored** — the Mac's CFI is a coordinate no other engine can use, and the fraction is the member that travels (D5).

```json payload=reading
{
  "applied": true,
  "book": {
    "id": "6f1a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
    "title": "Leviathan Wakes",
    "author": "James S. A. Corey",
    "publisher": "Orbit",
    "publishedDate": "2011-06-15",
    "language": "en",
    "description": "Humanity has colonized the solar system — and the protomolecule is loose.",
    "isbn10": "0316123266",
    "isbn13": "9780316123265",
    "goodreadsId": "8855321",
    "openlibraryId": "OL25167455W",
    "seriesName": "The Expanse",
    "seriesIndex": 1,
    "seriesTotal": 9,
    "tags": ["space opera", "science fiction"],
    "rating": 5,
    "dateAdded": "2026-08-13T18:04:21.000Z",
    "lastModified": "2026-09-21T09:12:00.000Z",
    "formats": ["epub", "mobi"],
    "fileSizeBytes": 4731892,
    "cover": {
      "thumb": true,
      "full": true,
      "version": "2026-09-21T09:12:00.000Z"
    },
    "reading": {
      "status": "reading",
      "percent": 0.42,
      "updatedAt": "2026-09-21T09:12:00.000Z"
    }
  }
}
```

| Field     | Meaning                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applied` | `true` when the report was written, `false` when it was **refused as stale** (below). A refusal is a `200`, not an error: nothing failed, the report was simply not the newest news about that book.                            |
| `book`    | The book **as it stands now**, in the same shape `GET /api/books/{id}` answers: the write and the read that follows it are one round trip, so a client that has just reported its position has the state it should resume from. |

| Answer  | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **200** | The report was applied — or refused as older than this machine's own clock, which answers `{"applied": false, "book": …}` with the row untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **400** | A body this route cannot make sense of: not JSON, larger than 4 KB, **a body that never finished arriving** (the server waits ~10 s and then answers, rather than waiting on a client that declared more than it sent), not a JSON object, no `percent`, a `percent` that is not a number in `0`–`1`, or an `at` that is not a timestamp. Refused rather than clamped or ignored — a `percent` of `1.2` is a typo, and answering it with a write it did not ask for is worse than saying so. **An explicit `"at": null` is refused**: a client that means "no `at`" omits the member. |
| **404** | An unknown book id, uniformly and reason-free like every other 404 here (D11). The body is validated **before** the book is looked up, so a malformed report answers 400 even for an id that does not exist — the same order the cover route validates `size` in.                                                                                                                                                                                                                                                                                                                     |
| **500** | A handler failed. The server keeps serving.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**What a write does, and what it deliberately does not.** The report goes through the same writer the Mac's own reader uses (`services/reading-state.ts`), so every rule is the reader's own and none is re-derived here:

- `reading_percent` takes the fraction and `reading_updated_at` moves to the **report's own `at`** when it carries one, and to the server's clock when it does not (D16, below).
- **`reading_position` is set to null**, deliberately (D5). The Mac's reader tries a stored position first and falls back to the fraction only when there is none, so blanking the CFI is what makes the newer fraction win: the book resumes at ~42% on the Mac instead of at the stale CFI. The Mac's own next page turn writes a fresh CFI there.
- `read_status` advances by the same rule as any Mac-side write — `unread` → `reading`, `≥ 98%` → `read` — and **never demotes**: a book already marked `read` stays `read` when reported at 5%.
- With the library share unmounted, the report still lands in SQLite and is parked for the next flush (`library: "offline"` in the health payload). Reading is never interrupted by a dropped share, and no error surfaces to the client: the answer is still `200`.
- **A report is a session boundary, so report sessions, not page turns.** Every report takes the tier that also writes `metadata.json` and rewrites `catalog.json` — a several-megabyte read-modify-write over the share — because D5's report is a phone that read a whole way and then stopped. A client that reported every page turn would pay that per turn, on the same threadpool the byte routes' cap of 2 is defending. Send on stop, and at most after a long pause.
- **A page turn is not a metadata edit.** The write pushes only the reading fields, so a title or tag changed on another machine survives the phone's report **in `catalog.json`**, which is merged field-by-field and has a case proving it. The `metadata.json` half is **not** the same claim and is not promised here: `saveProgress` writes the full record from this machine's local row, so an edit that arrived from elsewhere and has not yet been adopted is written back over. That is pre-existing behaviour on the Mac's own close — a phone report does not introduce it — and it is recorded in `tasks.md` rather than claimed as safe.

**Whose clock the row keeps (D16, added 2026-09-22 by the pre-merge review).** A report that is applied stamps `reading_updated_at` with **its own `at`**, not with the moment the request arrived — one clock domain orders one device's reports, which is what D6 asks for. Without it a client that queued three reports while the Mac slept could apply only the first: the row would be stamped at the flush, and the second report (`at = T2`, still older than `Date.now()`) would look like a regression and be refused, leaving the **oldest** position on disk. Reports without `at` are stamped with the server's clock, because that is the honest answer when the client offered none.

**Ordering (D6).** A report is applied when `at` is absent, or when it is **not older** than the book's own `reading_updated_at` (an equal timestamp applies, and so does an unparseable stored clock). A report that is older is refused with `{"applied": false}` and **nothing is written** — the row is byte-identical afterwards. This is what stops a phone that queued progress for a week from dragging a book backwards over everything the Mac read in the meantime. The residual, stated plainly: a phone whose clock is wrong can be refused by its own past, and a client that queues reports must send `at` with each one.

## Resumable downloads

`GET /api/books/{id}/file` accepts **one** range, and the reason is a measurement rather than a preference: on 2026-09-22 the largest EPUB on this library's share measured **554,110,279 bytes (528 MiB)** and reads whole in **25.64 s** (~20.6 MiB/s, almost no CPU). Without ranges a dropped transfer restarts from zero — and the books that most need resuming are the ones worst to restart.

| Request                  | Answer                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| no `Range`               | **200**, the whole file.                                                                                                                       |
| `Range: bytes=1000-`     | **206**, the file's **tail from offset 1000** to its last byte, with `Content-Range: bytes 1000-<total-1>/<total>` and `Accept-Ranges: bytes`. |
| `Range: bytes=1000-1999` | **206**, those bytes, `Content-Range: bytes 1000-1999/<total>`. A closed end past the file's length is clamped to the last byte.               |
| `Range: bytes=<total>-`  | **416**, with `Content-Range: bytes */<total>` so the client learns the real length, and `Accept-Ranges: bytes`.                               |

**The accepted grammar is exactly `bytes=N-` and `bytes=N-M`.** A suffix range (`bytes=-500`), a multi-range (`bytes=0-1,5-6`), another unit and a non-numeric bound all answer **416** rather than being ignored. HTTP permits a server to ignore a `Range` it does not understand and answer the whole entity; this route deliberately does not, because "the whole entity" here can be half a gigabyte over a tailnet, and answering it in full to a client that asked for its tail is the exact failure this route exists to prevent — the client would take minutes to discover it had restarted. **A client resumes by sending `Range: bytes=<bytes-it-already-has>-`**, keeping the partial file, and treating a 416 as "the file changed; start again". **A 0-byte file** — what a half-failed write leaves — is `200` with `Content-Length: 0` when no `Range` is asked for, and **416** with `Content-Range: bytes */0` when one is: `bytes=<total>-` is unsatisfiable at every offset, and an empty 200 to a client that asked for a tail would read as a finished download.

## Concurrent byte transfers are capped at 2

Both byte routes share a budget of **two transfers in flight**, covers included, and the overflow answers **503** with `{"error":"busy"}` and `Retry-After: 1` (seconds) rather than queueing.

Why: the process's file I/O shares a four-slot threadpool with the app's own cover loads, catalog writes and metadata hydration reads, and a transfer is a _long-held_ slot rather than a burst — the largest book takes 25.6 s. A phone that fanned out 60 cover fetches would take the pool away from the app it is reading from, which is the exposure `tasks.md` records for a stalled SMB mount. Two is chosen to leave the app slots to work with.

**What the budget does not do is end a transfer.** Nothing here puts a clock on a read: a share that stops answering — rather than failing — leaves the transfer waiting, and the read underneath it cannot be cancelled, so the slot returns when the kernel gives up on the I/O (minutes, on a dropped SMB mount). Two is therefore the number of requests this server will have stuck at once, which is as much as a cap above the threadpool can promise, and the client's own timeout is load-bearing: an abandoned download that closes its connection is what releases the slot here.

The client's consequence, stated so a grid does not feel mysterious: a `cover_full.jpg` is ~79 KB and reads in **0.05 s** when the share is healthy, so a cover grid is **latency-bound**, not bandwidth-bound — fetching a 60-cover page two at a time is ~30 sequential round trips (~1.5 s per screen), while a fan-out of 60 gets 58 immediate 503s. **Pipeline the covers two at a time and treat 503 as retryable**, honouring `Retry-After`. The library, facets, detail and health routes are **not** behind this budget: they answer from SQLite and never wait for a transfer.

## Failure semantics

The server is never a dependency of the app, and the client should expect all of these as ordinary answers rather than as errors to surface loudly.

| Situation                                       | Answer                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The share is not mounted (`library: "offline"`) | `/api/library`, `/api/library/facets` and `/api/books/{id}` still answer **200** from the cache. Both byte routes answer **503** with `Retry-After: 5` — the app re-checks the share on its own reconnect backoff, whose first step is 5 s.                                                                                                                                |
| No library configured                           | The same 503 on the byte routes; the cache routes answer 200 with whatever they hold.                                                                                                                                                                                                                                                                                      |
| A book's bytes are gone, a cover is gone        | **404** — the same answer as an unknown book, so a client cannot map what this machine holds.                                                                                                                                                                                                                                                                              |
| Too many transfers in flight                    | **503** with `Retry-After: 1` and `{"error":"busy"}`.                                                                                                                                                                                                                                                                                                                      |
| The share drops mid-transfer                    | The read fails: the connection is closed after the status has already been sent, and the client resumes with a `Range` request. If the read _stalls_ instead — a mount that stops answering without failing — nothing is notified and the request waits on the kernel; the client's timeout is what ends it, and new transfers still start while fewer than two are stuck. |
| A handler fails                                 | **500** with `{"error":"internal"}`. The server keeps serving.                                                                                                                                                                                                                                                                                                             |

## Errors

Every refusal is JSON with one member:

```json payload=error
{
  "error": "not found"
}
```

| Status | `error`                 | Meaning                                                                                                                                                                                                                                                                                |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `bad request`           | The request this route received cannot be made sense of: a malformed `limit`/`offset`/`minRating`, an unknown `sort`/`dir`, an unknown `formats`/`readStatus` value, no `format`, a `size` that is neither `thumb` nor `full`, or a progress report whose body this route cannot read. |
| 401    | `unauthorized`          | No credential, or the wrong one. Carries `WWW-Authenticate: Bearer`.                                                                                                                                                                                                                   |
| 404    | `not found`             | An unknown path, a known path behind a method it does not answer, an unknown book (including an unknown book id on the reading route), an unknown format, a format the book does not hold, a cover the book does not have, or a file that is gone.                                     |
| 416    | `range not satisfiable` | A `Range` this file cannot satisfy — including a malformed one. Carries `Content-Range: bytes */<length>`.                                                                                                                                                                             |
| 500    | `internal`              | A handler failed. The server keeps serving.                                                                                                                                                                                                                                            |
| 503    | `busy`                  | Too many byte transfers in flight. Carries `Retry-After: 1`.                                                                                                                                                                                                                           |
| 503    | `library offline`       | The library share is not mounted, so there are no bytes to serve. Carries `Retry-After: 5`.                                                                                                                                                                                            |

## Not in this version

`PUT /api/books/{id}/reading` **is** in this version (above); it is the one write this API grows. Nothing else writes: metadata edits, read-status marks, deletions and device sends are absent by decision, and a v1 client needs none of them.

## What is deliberately not on the wire

The payloads above are an explicit field list, not a projection of the database row. Three things a row holds are omitted on purpose, and a client must not expect them later:

- **`nasPath`** — the library's internal layout. The client asks for a book's file by id and format, never by path.
- **`sortTitle` / `authorSort`** — the derived sort keys. Sorting happens server-side, on the same keys the app sorts by, so a second copy on the wire could only disagree with it.
- **The Mac's reading position (an EPUB CFI)** — a coordinate no other engine can consume. `reading.percent` is the member that travels; a book the phone has moved and the Mac opens for the first time resumes at the fraction it reports. The report's **body** carries no position either: `PUT /api/books/{id}/reading` takes a fraction, and a `position` member sent anyway is ignored.

## Checking a live server with `scripts/api-smoke.sh`

The script is the contract's executable half: it runs against a **live app on an isolated profile**, reads the token and the port from that profile's own database, and prints one `PASS`/`FAIL` line per route. **It will not read the real profile by accident:** with no `--profile`/`MUSAEUM_USER_DATA` and no `--token`/`MUSAEUM_API_TOKEN` it stops and says which one to pass, rather than defaulting to the app's own database.

It exercises the read surface, and — since slice 1c — **the one write**: it reports a fraction to one book and reads it back. That is the only thing in the script that changes anything on the profile it runs against, and it is why the script belongs on a scratch profile; it never sends a `position`, and it also checks that a report dated in the past is refused.

```bash
# an app already running on an isolated profile (see .claude/skills/verify/SKILL.md)
MUSAEUM_USER_DATA="$SCRATCH/profile" bash scripts/api-smoke.sh

# against a specific server instead of reading the profile's config
bash scripts/api-smoke.sh --base http://100.125.135.108:8788 --token "$(sqlite3 ... )"
```

It needs `curl`, `jq` and `sqlite3`, exits non-zero if any route fails, and takes `--profile`, `--base` and `--token` (environment equivalents: `MUSAEUM_USER_DATA`, `MUSAEUM_API_BASE`, `MUSAEUM_API_TOKEN`). It checks, per route: the unauthenticated 401 with `WWW-Authenticate`, the authenticated 200 and payload shape, a page walk that repeats no book id, a search that returns the same ids as the unfiltered walk's subset, the facets payload, a book detail, a cover that is an image, a file whose `Content-Length` matches the bytes received, a `Range` request that answers 206 with a `Content-Range` and the right number of bytes, a 404 for an unknown book, a 400 for a bad `size`, a `HEAD /api/health` that answers 200 with no body, a `PUT …/reading` whose percent reads back off the detail route, and a stale report that comes back `applied: false`.
