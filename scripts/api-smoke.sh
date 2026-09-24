#!/usr/bin/env bash
#
# api-smoke.sh — the REST contract, exercised against a live app.
#
# Slice 1b's second decider for the contract (D12): the unit half is the suite,
# and this is the half that talks to a running Mac. It reads the credential and
# the port out of **the app's own database** rather than taking them on faith,
# then asks every route the surface has and prints one PASS/FAIL line per
# check. Every line below is an observation of this run — a status, a header, a
# byte count, a value read back off a payload — and never an inference.
#
#   MUSAEUM_USER_DATA=/tmp/scratch/profile bash scripts/api-smoke.sh
#   bash scripts/api-smoke.sh --base http://100.125.135.108:8788 --token <token>
#
# Requires: curl, jq, sqlite3 and zip (the upload's fixture is built here, and
# `zip -0` is how it stores `mimetype` the way the EPUB spec requires). Exit
# status is non-zero if any check failed.
#
# **Two sections write — slice 1c's reading report and slice 2's upload — and
# they are the only ones that do.** The reading report sends the fraction the
# book already holds (0.42 for a book that has none), so re-running it reports
# the same thing again rather than walking the book forward, and it never sends a
# position. The upload **adds a book**, and it adds one per run: the book it
# creates is named from the run's own clock, so two runs never collide and a
# second run cannot be mistaken for a re-run. Because of both, point this script
# at a **scratch profile** — with a library root you are willing to grow — rather
# than the profile you read on: the old contract held that a smoke run changed
# nothing, and that stopped being true when the first write shipped.
#
# What it cannot decide, and why the suite has to: **the bytes it receives are
# not hashed against the file on the share.** The wire deliberately does not
# carry a book's path (D10), so this script compares statuses, headers and byte
# counts. The *tail* of a resumed download is decided by the unit case in
# `electron/main/api/rest.test.ts`, which does hash `readFileSync(path).subarray(N)`
# — a server that ignored `Range` answers 206-shaped bytes and would pass every
# check this script can make. The reading report's rules are decided in
# `electron/main/services/api/reading.test.ts` for the same reason: this script
# can observe that the percent landed, not that the position was blanked by
# `saveProgress` rather than by a second writer.

set -uo pipefail

# Deliberately no default. This script reads a token out of a database and pulls book
# bytes; the app's own profile is the one place it must not wander into by accident.
PROFILE="${MUSAEUM_USER_DATA:-}"
BASE="${MUSAEUM_API_BASE:-}"
TOKEN="${MUSAEUM_API_TOKEN:-}"
PORT="${MUSAEUM_API_PORT:-}"
BIND=""
TIMEOUT=20
# Above this, the whole-file check is replaced by a one-byte range probe: this
# library's largest EPUB is 528 MiB, and a smoke run is not a download. The
# substitution is printed as a note rather than passed off as the same check.
WHOLE_FILE_CEILING=20971520

usage() {
  cat <<'USAGE'
Usage: scripts/api-smoke.sh [--profile DIR] [--base URL] [--token TOKEN]

  --profile DIR   the profile whose musaeum.db holds the token and port
                  (default: $MUSAEUM_USER_DATA, and no other — a run with neither a
                   profile nor both --base and --token stops here instead)
  --base URL      the server to talk to, e.g. http://100.125.135.108:8788
                  (default: from rest_api_bind, else this machine's tailnet address)
  --token TOKEN   the bearer token (default: read from the profile's database)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Either an explicit profile, or enough to reach a server without one. Anything else
# stops here rather than falling back to the app's own profile, which is how a
# "smoke run" could become a real download against the real library.
if [ -z "$PROFILE" ] && { [ -z "$TOKEN" ] || [ -z "$BASE" ]; }; then
  echo "FAIL  no profile given, and not enough to reach a server without one." >&2
  echo "      Pass --profile DIR (or MUSAEUM_USER_DATA), or both --base URL and --token TOKEN." >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BODY="$WORK/body"
HEADERS="$WORK/headers"
PASSED=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  printf 'PASS  %s\n' "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL  %s%s\n' "$1" "${2:+ — $2}"
}

# check <label> <expected> <actual>
check() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected $2, got $3"; fi
}

note() { printf 'note  %s\n' "$1"; }

for tool in curl jq sqlite3 zip; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "FAIL  $tool is not installed — this script needs curl, jq, sqlite3 and zip" >&2
    exit 2
  }
done

DB="$PROFILE/musaeum.db"

config() {
  sqlite3 "file:$DB?mode=ro" "SELECT value FROM app_config WHERE key='$1'" 2>/dev/null | tr -d '\r'
}

if { [ -z "$TOKEN" ] || [ -z "$PORT" ] || [ -z "$BASE" ]; } && [ ! -f "$DB" ]; then
  echo "FAIL  no database at $DB — is the profile right? (--profile DIR, or MUSAEUM_USER_DATA)" >&2
  exit 2
fi

if [ -z "$TOKEN" ]; then
  TOKEN="$(config rest_api_token)"
  [ -n "$TOKEN" ] || {
    echo "FAIL  rest_api_token is not set in $DB — enable the API from Settings first" >&2
    exit 2
  }
fi

if [ -z "$PORT" ]; then
  PORT="$(config rest_api_port)"
  # The server's own default when the key is unset or unusable
  case "$PORT" in '' | *[!0-9]*) PORT=8788 ;; esac
fi

[ -n "$BIND" ] || BIND="$(config rest_api_bind)"

if [ -z "$BASE" ]; then
  HOST="$BIND"
  if [ -z "$HOST" ]; then
    # The tailnet is the only non-loopback address the server binds (D3), and a
    # Tailscale address is the one in 100.64.0.0/10
    HOST="$(ifconfig 2>/dev/null | awk '/inet 100\./ {print $2}' | head -1)"
  fi
  if [ -z "$HOST" ]; then
    echo "FAIL  no tailnet address found and no rest_api_bind set — pass --base, or set rest_api_bind" >&2
    exit 2
  fi
  BASE="http://$HOST:$PORT"
fi

AUTH=(-H "Authorization: Bearer $TOKEN")

# request <path> [extra curl args…] — prints the status code, leaving the headers
# in $HEADERS and the body in $BODY. curl prints 000 when nothing answered.
request() {
  local path="$1"
  shift
  curl -sS --max-time "$TIMEOUT" -o "$BODY" -D "$HEADERS" -w '%{http_code}' \
    "${AUTH[@]}" ${1+"$@"} "$BASE$path" 2>/dev/null
}

# header <name> — the first response header with that name, case-insensitively.
# `tolower` in awk rather than IGNORECASE, which BSD awk does not have.
header() {
  tr -d '\r' <"$HEADERS" | awk -v name="$(printf '%s' "$1" | tr 'A-Z' 'a-z')" '
    {
      colon = index($0, ":")
      if (colon == 0) next
      if (tolower(substr($0, 1, colon - 1)) == name) {
        value = substr($0, colon + 1)
        sub(/^[ ]*/, "", value)
        print value
        exit
      }
    }'
}

body_size() { wc -c <"$BODY" | tr -d ' '; }

as_number() {
  case "${1:-}" in '' | *[!0-9]*) echo 0 ;; *) echo "$1" ;; esac
}

printf 'api smoke — %s (profile %s)\n' "$BASE" "$PROFILE"

# ---------------------------------------------------------------------------
# The credential, and the method a client probes with
# ---------------------------------------------------------------------------

printf '\n--- auth\n'

code=$(curl -sS --max-time "$TIMEOUT" -o "$BODY" -D "$HEADERS" -w '%{http_code}' \
  "$BASE/api/health" 2>/dev/null)
check 'health without a credential answers 401' 401 "$code"
check 'the 401 carries WWW-Authenticate: Bearer' 'Bearer' "$(header www-authenticate)"

code=$(curl -sS --max-time "$TIMEOUT" -o "$BODY" -D "$HEADERS" -w '%{http_code}' \
  -H 'Authorization: Bearer 0000000000000000000000000000000000000000000000000000000000000000' \
  "$BASE/api/health" 2>/dev/null)
check 'health with a wrong credential answers 401' 401 "$code"

printf '\n--- health (GET and HEAD)\n'

code=$(request /api/health)
check 'GET /api/health answers 200' 200 "$code"
check 'the payload carries apiVersion 1' 1 "$(jq -r '.apiVersion' "$BODY")"
check 'the payload counts the cache' 'number' "$(jq -r '.books | type' "$BODY")"
check 'the payload names the library state' 'one-of-two' \
  "$(jq -r 'if (.library == "online" or .library == "offline") then "one-of-two" else .library end' "$BODY")"

GET_LENGTH="$(header content-length)"
# The method policy: URLSession probes with HEAD, and 1a's GET-only switch
# answered 404 where the connect check belongs — which is what this slice fixed
HEAD_RESULT="$(curl -sS --head --max-time "$TIMEOUT" -D "$HEADERS" -o /dev/null \
  -w '%{http_code} %{size_download}' "${AUTH[@]}" "$BASE/api/health" 2>/dev/null)"
check 'HEAD /api/health answers 200' 200 "${HEAD_RESULT%% *}"
check 'the HEAD carries the same Content-Length as the GET' "$GET_LENGTH" "$(header content-length)"
check 'the HEAD downloads no body' 0 "${HEAD_RESULT##* }"

# ---------------------------------------------------------------------------
# The library: one page, a walk, a search, the counts
# ---------------------------------------------------------------------------

printf '\n--- library\n'

code=$(request '/api/library?limit=2&offset=0')
check 'GET /api/library answers 200' 200 "$code"
check 'the page carries books, total, limit and offset' 'ok' \
  "$(jq -r 'if (.books and (.total | type == "number") and (.limit | type == "number") and (.offset | type == "number")) then "ok" else "malformed" end' "$BODY")"
check 'the page carries exactly `limit` rows' 2 "$(jq '.books | length' "$BODY")"

TOTAL="$(as_number "$(jq -r '.total' "$BODY")")"

if [ "$TOTAL" -gt 0 ]; then
  # A walk to exhaustion, bounded so a smoke run stays a smoke run
  SEEN="$WORK/seen"
  : >"$SEEN"
  offset=0
  pages=0
  while [ "$offset" -lt "$TOTAL" ] && [ "$pages" -lt 5 ]; do
    request "/api/library?limit=2&offset=$offset" >/dev/null
    jq -r '.books[].id' "$BODY" >>"$SEEN"
    offset=$((offset + 2))
    pages=$((pages + 1))
  done
  WALKED="$(wc -l <"$SEEN" | tr -d ' ')"
  UNIQUE="$(sort -u "$SEEN" | wc -l | tr -d ' ')"
  check 'a page walk repeats no book id' "$WALKED" "$UNIQUE"

  FIRST_ID="$(head -1 "$SEEN")"
  request "/api/books/$FIRST_ID" >/dev/null
  FIRST_TITLE="$(jq -r '.title' "$BODY")"
else
  fail 'a page walk repeats no book id' 'the cache holds no books to walk'
  FIRST_ID=""
  FIRST_TITLE=""
fi

printf '\n--- library/facets\n'

code=$(request /api/library/facets)
check 'GET /api/library/facets answers 200' 200 "$code"
check 'the facets carry all five lists' 'ok' \
  "$(jq -r 'if (.authors and .series and .tags and .formats and .readStatus) then "ok" else "missing a list" end' "$BODY")"

printf '\n--- library?q= (the app own FTS path)\n'

if [ -n "$FIRST_TITLE" ]; then
  TERM="$(printf '%s' "$FIRST_TITLE" | awk '{print $1}')"
  code=$(request "/api/library?q=$(printf '%s' "$TERM" | jq -sRr @uri)&limit=100")
  check "GET /api/library?q=$TERM answers 200" 200 "$code"
  check 'the search finds the book it was asked for' 'yes' \
    "$(jq -r --arg id "$FIRST_ID" 'if any(.books[]; .id == $id) then "yes" else "no" end' "$BODY")"
fi

# ---------------------------------------------------------------------------
# One book, its cover and its bytes
# ---------------------------------------------------------------------------

printf '\n--- book detail\n'

if [ -n "$FIRST_ID" ]; then
  code=$(request "/api/books/$FIRST_ID")
  check 'GET /api/books/{id} answers 200' 200 "$code"
  check 'the detail is the book that was asked for' "$FIRST_ID" "$(jq -r '.id' "$BODY")"
  check 'the payload carries cover and reading objects' 'ok' \
    "$(jq -r 'if (.cover and .reading) then "ok" else "missing cover or reading" end' "$BODY")"
  check 'the payload does not carry the library path' 'no-nasPath' \
    "$(jq -r 'if has("nasPath") then "leaked-nasPath" else "no-nasPath" end' "$BODY")"
fi

code=$(request /api/books/not-a-book)
check 'an unknown book answers 404' 404 "$code"

# ---------------------------------------------------------------------------
# The first write: the phone's progress report (slice 1c)
# ---------------------------------------------------------------------------

printf '\n--- the reading report (the first of two writes)\n'

if [ -n "$FIRST_ID" ]; then
  # The fraction this book already holds, or the contract's own example for a
  # book nothing has reported yet. Reporting back what is already there is what
  # makes this section safe to re-run: it frees the write path, not the book.
  code=$(request "/api/books/$FIRST_ID")
  PERCENT="$(jq -r '.reading.percent // empty' "$BODY")"
  [ -n "$PERCENT" ] || PERCENT=0.42

  code=$(request "/api/books/$FIRST_ID/reading" -X PUT -H 'Content-Type: application/json' \
    --data "{\"percent\":$PERCENT}")
  check 'PUT /api/books/{id}/reading answers 200' 200 "$code"
  check 'the report was applied' 'true' "$(jq -r '.applied' "$BODY")"
  check 'the answer carries the book it wrote' "$FIRST_ID" "$(jq -r '.book.id' "$BODY")"

  # The read-back: a value observed on the *detail* route, not echoed back from
  # the write's own answer
  code=$(request "/api/books/$FIRST_ID")
  check "the write landed: reading.percent reads back as $PERCENT" "$PERCENT" \
    "$(jq -r '.reading.percent' "$BODY")"
  check 'the book payload still carries no position' 'no-position' \
    "$(jq -r 'if (.reading | has("position")) then "leaked-position" else "no-position" end' "$BODY")"

  # D6: a queued report older than this machine's own copy is refused, and the
  # row does not move. The first report above is what gives the row its clock.
  code=$(request "/api/books/$FIRST_ID/reading" -X PUT -H 'Content-Type: application/json' \
    --data '{"percent":0.01,"at":"2000-01-01T00:00:00.000Z"}')
  check 'a report dated in the past answers 200' 200 "$code"
  check 'a stale report comes back applied: false' 'false' "$(jq -r '.applied' "$BODY")"

  code=$(request "/api/books/$FIRST_ID")
  check 'the refusal wrote nothing — the percent is unchanged' "$PERCENT" \
    "$(jq -r '.reading.percent' "$BODY")"

  # The 400s and the 404, observed as statuses. The rules themselves are the
  # suite's (`services/api/reading.test.ts`); what this proves is that a live
  # server refuses them the same way.
  code=$(request "/api/books/$FIRST_ID/reading" -X PUT -H 'Content-Type: application/json' \
    --data '{"percent":1.5}')
  check 'a percent outside 0-1 answers 400' 400 "$code"

  code=$(request "/api/books/$FIRST_ID/reading" -X PUT -H 'Content-Type: application/json' \
    --data 'not json at all')
  check 'a body that is not JSON answers 400' 400 "$code"

  code=$(request "/api/books/not-a-book/reading" -X PUT -H 'Content-Type: application/json' \
    --data '{"percent":0.5}')
  check 'a report for an unknown book answers 404' 404 "$code"

  # The method policy: this path answers a PUT and nothing else, and the read
  # routes are untouched by its arrival
  code=$(request "/api/books/$FIRST_ID/reading")
  check 'a GET of the write route answers 404' 404 "$code"
else
  fail 'PUT /api/books/{id}/reading answers 200' 'the cache holds no book to report against'
fi

# ---------------------------------------------------------------------------
# The second write: a book arriving as bytes (slice 2)
# ---------------------------------------------------------------------------

printf '\n--- upload (the second write, and the one that creates a book)\n'

# **A fixture this script owns** (S9). The bytes are a real EPUB — a stored
# `mimetype` first, a `container.xml`, an OPF with a title — and the title is
# *this run's own name*, so hydration can only set the string the import already
# used and two runs cannot collide with each other. `zip -0` stores rather than
# deflates, which is what the EPUB spec requires of `mimetype`.
UPLOAD_NAME="Smoke Upload $(date +%Y%m%d-%H%M%S)"
FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE/book/META-INF" "$FIXTURE/book/OEBPS"
printf 'application/epub+zip' >"$FIXTURE/book/mimetype"
printf '%s' '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' \
  >"$FIXTURE/book/META-INF/container.xml"
printf '%s' "<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"bookid\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>$UPLOAD_NAME</dc:title><dc:language>en</dc:language></metadata><manifest><item id=\"c1\" href=\"chapter1.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"c1\"/></spine></package>" \
  >"$FIXTURE/book/OEBPS/content.opf"
# A chapter, so the file is a book rather than a container with a title in it —
# and so its bytes are past the kilobyte the download section's range check asks
# for. The upload puts this book *into* the library, which means the range check
# can meet it on a re-run; it has to be a book either check can serve.
printf '%s' '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>' \
  >"$FIXTURE/book/OEBPS/chapter1.xhtml"
i=0
while [ "$i" -lt 60 ]; do
  printf '<p>Line %s of the smoke fixture, which exists to be bytes rather than to be read.</p>\n' "$i" \
    >>"$FIXTURE/book/OEBPS/chapter1.xhtml"
  i=$((i + 1))
done
printf '%s' '</body></html>' >>"$FIXTURE/book/OEBPS/chapter1.xhtml"
(
  cd "$FIXTURE/book" || exit 1
  zip -X -0 -q "$FIXTURE/smoke.epub" mimetype
  zip -X -q -r "$FIXTURE/smoke.epub" META-INF OEBPS
)
UPLOAD_BYTES="$(wc -c <"$FIXTURE/smoke.epub" | tr -d ' ')"
UPLOAD_QUERY="format=epub&filename=$(printf '%s' "$UPLOAD_NAME.epub" | sed 's/ /%20/g')"

code=$(request "/api/books?$UPLOAD_QUERY" -X POST -H 'Content-Type: application/epub+zip' \
  --data-binary "@$FIXTURE/smoke.epub")
check 'POST /api/books answers 201' 201 "$code"
UPLOAD_ID="$(jq -r '.book.id // empty' "$BODY")"
check 'the answer names the book it created' 'an id' \
  "$([ -n "$UPLOAD_ID" ] && echo 'an id' || echo 'no id')"
check 'the title is the filename it was given' "$UPLOAD_NAME" "$(jq -r '.book.title' "$BODY")"
check 'the format is the parameter it was given' 'epub' "$(jq -r '.book.formats | join(",")' "$BODY")"
check 'the size is the number of bytes it sent' "$UPLOAD_BYTES" \
  "$(as_number "$(jq -r '.book.fileSizeBytes // 0' "$BODY")")"
check 'nothing in the library collided with it' 'null' "$(jq -r '.duplicate' "$BODY")"

# The read-back: the id the answer named, fetched on the route a client uses.
# This is the half of AC14 that makes the check an import rather than a status
# line, and it reads the *payload* rather than the write's own echo.
if [ -n "$UPLOAD_ID" ]; then
  code=$(request "/api/books/$UPLOAD_ID")
  check 'the uploaded book reads back off the detail route' 200 "$code"
  check 'the book that reads back is the one that was uploaded' "$UPLOAD_ID" "$(jq -r '.id' "$BODY")"
  check 'the read-back carries the same title' "$UPLOAD_NAME" "$(jq -r '.title' "$BODY")"
else
  fail 'the uploaded book reads back off the detail route' 'the answer carried no id'
fi

# The refusals, observed as statuses. Their rules are the suite's
# (`electron/main/api/upload.test.ts`, `services/api/upload.test.ts`); what this
# proves is that a live server refuses them the same way.
code=$(request '/api/books?filename=No-Format.epub' -X POST \
  -H 'Content-Type: application/epub+zip' --data-binary "@$FIXTURE/smoke.epub")
check 'an upload with no format answers 400' 400 "$code"
check 'the refusal is the contract body' 'bad request' "$(jq -r '.error' "$BODY")"

code=$(request '/api/books?format=epub&filename=Empty.epub' -X POST \
  -H 'Content-Type: application/epub+zip' --data '')
check 'an empty body answers 400' 400 "$code"

# **The method policy** (S6): the collection answers POST and nothing else, and
# HEAD is deliberately not an exception for it.
code=$(request '/api/books?format=epub&filename=Method.epub')
check 'a GET of the collection answers 404' 404 "$code"
code=$(curl -sS --head --max-time "$TIMEOUT" -D "$HEADERS" -o /dev/null -w '%{http_code}' \
  "${AUTH[@]}" "$BASE/api/books" 2>/dev/null)
check 'a HEAD of the collection answers 404' 404 "$code"

# **The 413 is not exercised here, deliberately.** It needs a body past 1 GiB,
# and a gigabyte is not a smoke test. The breach and the refusal it produces are
# decided on a socket with a small cap through the module's own seam in
# `electron/main/api/upload.test.ts`; a smoke run can add nothing to that.
note 'the 1 GiB cap is not exercised here — see the mid-flight 413 case in electron/main/api/upload.test.ts'

printf '\n--- cover bytes\n'

request '/api/library?limit=100' >/dev/null
# Kept aside: the checks below overwrite $BODY with the images they ask for, and
# the candidate lists have to come from the page rather than from a JPEG
cp "$BODY" "$WORK/library.json"
LIBRARY_PAGE="$WORK/library.json"
# The first book that *serves* a cover, not the first that claims one: a row can
# claim a thumbnail and still be refused — a path that climbs out of the library
# root, a file since deleted — and that refusal is the contract working, not a
# failure of this run. A run in which no claimed cover serves one does fail.
COVER_ID=""
for candidate in $(jq -r '.books[] | select(.cover.thumb) | .id' "$LIBRARY_PAGE" | head -10); do
  code=$(request "/api/books/$candidate/cover?size=thumb")
  if [ "$code" = 200 ]; then
    COVER_ID="$candidate"
    break
  fi
done

if [ -n "$COVER_ID" ]; then
  code=$(request "/api/books/$COVER_ID/cover?size=thumb")
  check 'GET /api/books/{id}/cover answers 200' 200 "$code"
  check 'the cover is an image' 'image/jpeg' "$(header content-type)"
  check 'the cover has bytes' 'yes' "$([ "$(body_size)" -gt 0 ] && echo yes || echo no)"

  FULL_ID=""
  for candidate in $(jq -r '.books[] | select(.cover.full) | .id' "$LIBRARY_PAGE" | head -10); do
    code=$(request "/api/books/$candidate/cover?size=full")
    if [ "$code" = 200 ]; then
      FULL_ID="$candidate"
      break
    fi
  done
  if [ -n "$FULL_ID" ]; then
    pass 'the full size answers 200 for a book that holds one'
  else
    note 'no book in the first 100 served a full cover — the full-size branch was not exercised'
  fi

  code=$(request "/api/books/$COVER_ID/cover?size=banana")
  check 'a size that is neither thumb nor full answers 400' 400 "$code"
else
  fail 'GET /api/books/{id}/cover answers 200' 'no book in the first 100 served a cover it claimed'
fi

code=$(request '/api/books/not-a-book/cover?size=thumb')
check 'a cover for an unknown book answers 404' 404 "$code"

printf '\n--- file bytes, and a resumed download\n'

request '/api/library?limit=100' >/dev/null
# The whole-file check needs a book whose size is *known* and inside the ceiling.
# `fileSizeBytes` is null for a book nothing has measured, and a null sorted as 0
# won this pick — so "the smallest book on the page" could be the 528 MiB one,
# downloaded whole by a script whose own header says a smoke run is not a download.
FILE_ID="$(jq -r --argjson ceiling "$WHOLE_FILE_CEILING" \
  '[.books[] | select((.formats | length) > 0) | select((.fileSizeBytes // 0) > 0)
    | select((.fileSizeBytes // 0) <= $ceiling)]
   | sort_by(.fileSizeBytes) | .[0].id // empty' "$BODY")"
WHOLE_FILE=1
if [ -z "$FILE_ID" ]; then
  # Nothing on this page with a known small size: probe with a one-byte range instead
  FILE_ID="$(jq -r '[.books[] | select((.formats | length) > 0)] | .[0].id // empty' "$BODY")"
  WHOLE_FILE=0
fi
FILE_FORMAT="$(jq -r --arg id "$FILE_ID" '.books[] | select(.id == $id) | .formats[0]' "$BODY")"
FILE_SIZE="$(as_number "$(jq -r --arg id "$FILE_ID" '.books[] | select(.id == $id) | (.fileSizeBytes // 0)' "$BODY")")"

if [ -n "$FILE_ID" ] && [ -n "$FILE_FORMAT" ]; then
  if [ "$WHOLE_FILE" = 1 ]; then
    code=$(request "/api/books/$FILE_ID/file?format=$FILE_FORMAT")
    check "GET /api/books/{id}/file?format=$FILE_FORMAT answers 200" 200 "$code"
    LENGTH="$(header content-length)"
    check 'the Content-Length matches the bytes served' "$LENGTH" "$(body_size)"
  else
    # The length without the download: a one-byte range reports the total
    code=$(request "/api/books/$FILE_ID/file?format=$FILE_FORMAT" -H 'Range: bytes=0-0')
    check 'a one-byte range answers 206' 206 "$code"
    LENGTH="$(header content-range)"
    LENGTH="${LENGTH##*/}"
    note "no book on this page carries a known size inside the ${WHOLE_FILE_CEILING}-byte ceiling: the whole-file check was replaced by that range probe"
  fi

  check 'the file route advertises ranges' 'bytes' "$(header accept-ranges)"
  check 'the file route names the format own media type' 'ok' \
    "$(header content-type | grep -q '^application/' && echo ok || echo "$(header content-type)")"

  # Clamped to the file, so the check asks for what exists. A library whose
  # smallest book is under a kilobyte — which this slice's own upload fixture can
  # be once the upload has *put* a book in the library — answers a shorter
  # Content-Range rather than a 416, and a check with 1023 hard-coded would fail
  # a healthy server.
  RANGE_END=$((LENGTH > 1024 ? 1023 : LENGTH - 1))
  RANGE_BYTES=$((RANGE_END + 1))
  if [ "$LENGTH" -le 1024 ]; then
    note "the smallest book on this page is $LENGTH bytes — the range check was clamped to it"
  fi

  code=$(request "/api/books/$FILE_ID/file?format=$FILE_FORMAT" -H "Range: bytes=0-$RANGE_END")
  check 'a resumed range answers 206' 206 "$code"
  check 'the 206 carries Content-Range' "bytes 0-$RANGE_END/$LENGTH" "$(header content-range)"
  check "the 206 serves $RANGE_BYTES bytes" "$RANGE_BYTES" "$(body_size)"

  code=$(request "/api/books/$FILE_ID/file?format=$FILE_FORMAT" -H "Range: bytes=$LENGTH-")
  check 'a range past the end answers 416' 416 "$code"
  check 'the 416 carries the length it could satisfy' "bytes */$LENGTH" "$(header content-range)"

  code=$(request "/api/books/$FILE_ID/file?format=sh")
  check 'an unknown format answers 404' 404 "$code"

  MISSING="$(printf 'epub\nmobi\nazw3\npdf\n' | grep -v -x "$FILE_FORMAT" | head -1)"
  code=$(request "/api/books/$FILE_ID/file?format=$MISSING")
  check "a format the book does not have ($MISSING) answers 404" 404 "$code"
else
  fail 'GET /api/books/{id}/file answers 200' 'no book in the first 100 declares a format'
fi

printf '\n--- the shape of a refusal\n'

code=$(request '/api/library?sort=athor')
check 'a malformed sort answers 400' 400 "$code"
check 'the refusal is the contract body' 'bad request' "$(jq -r '.error' "$BODY")"

code=$(request /api/nothing-here)
check 'an unmatched path answers 404' 404 "$code"
check 'the 404 is the contract body' 'not found' "$(jq -r '.error' "$BODY")"

printf '\npassed %s, failed %s\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
