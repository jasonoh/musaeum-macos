"""Cover candidate gathering, scoring, summarising, and writing.

score = resolution*0.4 + aspect_ratio*0.3 + source_priority*0.2 + file_size*0.1
Top two within 15% → also emit a 'cover' review conflict (top one is still
applied so the book is never coverless while waiting on review).

Two callers, one set of rules. `hydrate_metadata` gathers candidates, scores
them and writes the winner; `cover_candidates` (the picker's gather) scores the
same list and summarises it without writing anything — so the jackets a person
is offered are exactly the jackets the fetch decides between, ranked by the same
formula and previewed by the same `preview_data_url` the conflict queue's tiles
use. A second copy of the gather, the ranking or the preview rule is the defect
this module exists to keep singular.
"""

import base64
import io
import os
from typing import Optional

import requests
from PIL import Image

from extractors.epub_metadata import extract_embedded_cover
from extractors.pdf_metadata import render_pdf_cover

FULL_MAX = 600
PREVIEW_MAX = 240
MAX_PREVIEWS = 6
THUMB_MAX = 200
TIMEOUT = 20

SOURCE_PRIORITY = {"google_books": 1.0, "openlibrary": 0.66, "embedded": 0.33}

# Ideal book cover is ~2:3 portrait
IDEAL_RATIO = 1.5


def _score(width: int, height: int, size_bytes: int, source: str) -> float:
    resolution = min(1.0, (width * height) / (600 * 900))
    ratio = height / width if width else 0
    aspect = max(0.0, 1.0 - abs(ratio - IDEAL_RATIO) / IDEAL_RATIO)
    priority = SOURCE_PRIORITY.get(source, 0.3)
    file_size = min(1.0, size_bytes / 500_000)
    return resolution * 0.4 + aspect * 0.3 + priority * 0.2 + file_size * 0.1


def _download(url: str) -> Optional[bytes]:
    try:
        resp = requests.get(url, timeout=TIMEOUT)
        resp.raise_for_status()
        return resp.content if len(resp.content) > 1_000 else None
    except Exception:
        return None


def gather_candidates(file_path: str, google: Optional[dict], openlib: Optional[dict]) -> list:
    """Every cover a fetch would consider for this book, in source order.

    The one home for the candidate set. `hydrate_metadata` scores exactly this
    list, and the picker's gather summarises exactly this list, so the jackets a
    person is offered cannot be a different set from the jackets the fetch
    silently decides between — that agreement is the whole point of gathering
    the candidates live (D1 of the cover-choice design).

    The file's own cover is included here and is the one candidate a review
    conflict can never carry: `select_cover` reports its list as URLs, and an
    embedded image has none, so "put the file's own jacket back" is expressible
    only as a candidate.
    """
    candidates = []
    if google and google.get("cover_url"):
        candidates.append(
            {
                "source": "google_books",
                "url": google["cover_url"],
                # The fetcher already holds these bytes — it downloaded them
                # to check they are not Google's placeholder tile — so
                # passing them on saves the scoring step a second download
                # of up to ~500 KB. A source that supplies none is
                # downloaded from its url, exactly as before.
                "data": google.get("cover_data"),
            }
        )
    if openlib and openlib.get("cover_url"):
        candidates.append({"source": "openlibrary", "url": openlib["cover_url"]})

    lower = file_path.lower()
    if lower.endswith(".epub"):
        embedded = extract_embedded_cover(file_path)
    elif lower.endswith(".pdf"):
        embedded = render_pdf_cover(file_path)
    else:
        embedded = None
    if embedded:
        candidates.append({"source": "embedded", "data": embedded})

    return candidates


def score_candidates(candidates: list) -> list:
    """The candidates that are real images, with their scores, best first.

    Downloads a candidate that did not bring its own bytes, drops anything PIL
    cannot read and anything under the 120 px floor, and sorts. The sort lives
    here rather than at each caller because both take the head as *the* winner —
    the writer, and the summariser that tells the picker which one would win.
    """
    scored = []
    for cand in candidates:
        data = cand.get("data") or (_download(cand["url"]) if cand.get("url") else None)
        if not data:
            continue
        try:
            img = Image.open(io.BytesIO(data))
            width, height = img.size
        except Exception:
            continue
        if width < 120 or height < 120:
            continue
        scored.append(
            {
                "source": cand["source"],
                "url": cand.get("url"),
                "data": data,
                "width": width,
                "height": height,
                "score": _score(width, height, len(data), cand["source"]),
            }
        )

    scored.sort(key=lambda c: c["score"], reverse=True)
    return scored


def select_cover(candidates: list, book_dir: str) -> dict:
    """candidates: [{source, url?, data?}]. Writes the winner to book_dir.

    Returns {cover: {...} | None, review: bool, candidates: [scored]}.
    """
    scored = score_candidates(candidates)
    if not scored:
        return {"cover": None, "review": False, "candidates": []}

    winner = scored[0]
    review = len(scored) > 1 and (winner["score"] - scored[1]["score"]) < 0.15 * winner["score"]

    cover = _write_cover(winner["data"], book_dir)
    cover["source"] = winner["source"]
    cover["width"] = winner["width"]
    cover["height"] = winner["height"]

    return {
        "cover": cover,
        "review": review,
        # URLs only, on purpose: a queued cover conflict carries a *value* a
        # resolver can send back to `fetch_cover`, and an embedded candidate has
        # no URL to send. The picker is where the file's own jacket is visible —
        # see `summarise_candidates`.
        "candidates": [
            {"source": c["source"], "url": c["url"], "width": c["width"], "height": c["height"]}
            for c in scored
            if c["url"]
        ],
    }


def summarise_candidates(scored: list, book_dir: str) -> list:
    """The picker's payload: one entry per scored candidate, best first.

    `scored` must be `score_candidates`' own list, because `winner` is its head
    and a second sort here would be a second answer to "which jacket wins".

    Three things this decides, each with a rule it reuses rather than restates:

    - `thumb` is `preview_data_url` of the candidate's own bytes. That is the
      function the conflict queue's tiles already go through, and the renderer's
      CSP (`img-src 'self' musaeum: data: blob:`) means a remote image cannot be
      shown at all — so a picker thumb and a queue thumb cannot diverge, and
      neither is ever a URL the renderer would have to fetch.
    - `applied` is **byte identity with `cover_full.jpg`**, not provenance. The
      cover's source is recorded nowhere, so comparing the bytes this candidate
      *would* become against what is on disk is the only way to say "this is the
      one your book has now" — and it is the same derivation `_write_cover`
      writes, so "what the book has" and "what a pick would write" cannot
      disagree.
    - `url` is *absent* for `embedded` rather than null. That absence is what
      `set_cover` refuses on: the file's own jacket is re-extracted, never
      fetched, and a candidate carrying a url it may not be fetched from would
      turn "put the file's own jacket back" into a network request.

    Bounded by construction: the pool is what `score_candidates` kept (three or
    four in practice), so this is not a list to cap. A candidate whose image
    cannot be shown is dropped rather than offered as a blank tile; if that one
    was also the best-scoring, no entry claims `winner` — the jacket that would
    win is not on offer, and marking the runner-up would misreport which one a
    fetch would write.
    """
    stored = _full_cover_path(book_dir)
    out = []
    for index, cand in enumerate(scored):
        # Constructed together, because the two are two views of one rendering:
        # `_renditions` proves the image can become the cover, `preview_data_url`
        # proves it can be shown. (`score_candidates` admits a candidate whose
        # *header* parsed, so an image whose pixels do not load can reach this
        # far; it is dropped rather than offered as a blank tile, which is what
        # the queue does with an unfetchable url — "a dead URL simply absent". A
        # picker candidate nobody can see is not one anybody can choose.)
        thumb = preview_data_url(cand["data"])
        if not thumb:
            continue
        entry = {"source": cand["source"]}
        if cand.get("url"):
            entry["url"] = cand["url"]
        entry.update(
            {
                "width": cand["width"],
                "height": cand["height"],
                "score": cand["score"],
                "winner": index == 0,
                "applied": _renders_to_stored(cand["data"], stored),
                "thumb": thumb,
            }
        )
        out.append(entry)
    return out


def _full_cover_path(book_dir: str) -> str:
    """Where the full cover lives.

    One home for the fixed filename, because two questions read it now: what a
    write puts on disk, and what the book is *already* wearing. The second is
    `applied`, and a second copy of the name is how those two would come to
    disagree about which file "on disk" means.
    """
    return os.path.join(book_dir, "cover_full.jpg")


def _write_cover(data: bytes, book_dir: str) -> dict:
    full, thumb = _renditions(data)
    full_path = _full_cover_path(book_dir)
    thumb_path = os.path.join(book_dir, "cover_thumb.jpg")

    # Compared *before* writing: "did this run change the cover?" is what the
    # caller reports back to the user, and the filenames are fixed, so nothing
    # downstream can tell a re-download of the same image from a genuinely new
    # one. Byte comparison, not mtime — a re-download rewrites identical bytes
    # and always advances mtime, which would report every refresh as a change.
    changed = _differs(full_path, full) or _differs(thumb_path, thumb)

    for path, blob in ((full_path, full), (thumb_path, thumb)):
        with open(path, "wb") as fh:
            fh.write(blob)

    return {"full": "cover_full.jpg", "thumb": "cover_thumb.jpg", "changed": changed}


def _renditions(data: bytes) -> tuple:
    """The two JPEGs an image becomes on disk, in the order they are written.

    One home for the rendition sizes and qualities, because two questions are
    answered from them: `_write_cover` writes exactly these bytes, and
    `summarise_candidates` compares a candidate against the full one to decide
    `applied`. Deriving them twice would let "this is the cover on disk" and
    "this is what a pick would write" come out disagreeing on the same image.
    """
    img = Image.open(io.BytesIO(data))
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    return (
        _encode(img, (FULL_MAX, FULL_MAX * 2), 88),
        _encode(img, (THUMB_MAX, THUMB_MAX * 2), 85),
    )


def _renders_to_stored(data: bytes, stored_path: str) -> bool:
    """True when writing this candidate would leave `stored_path` byte-identical.

    Byte identity is the whole rule: a source is recorded nowhere, so the bytes
    on disk are the only thing that can say which candidate a book is wearing.
    An image that cannot be rendered is not the one on disk.
    """
    try:
        full, _ = _renditions(data)
    except Exception:
        return False
    return not _differs(stored_path, full)


def _encode(img: Image.Image, max_size: tuple, quality: int) -> bytes:
    """Render one JPEG size to memory, so it can be compared before it lands."""
    copy = img.copy()
    copy.thumbnail(max_size)
    buf = io.BytesIO()
    copy.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def _differs(path: str, data: bytes) -> bool:
    """True when writing `data` to `path` would change what is on disk."""
    try:
        with open(path, "rb") as fh:
            return fh.read() != data
    except OSError:
        # Missing or unreadable: whatever is there now, this write creates it
        return True


def _write_chosen(data: bytes, book_dir: str, source: str) -> dict:
    """Write these bytes as the book's cover — the tail both writers share."""
    img = Image.open(io.BytesIO(data))
    cover = _write_cover(data, book_dir)
    cover.update({"source": source, "width": img.size[0], "height": img.size[1]})
    return cover


def fetch_cover(book_dir: str, url: Optional[str] = None, source: str = "google_books") -> dict:
    """Download a specific cover URL (conflict resolution path)."""
    if not url:
        raise ValueError("fetch_cover requires a url")
    data = _download(url)
    if not data:
        raise ValueError(f"Could not download cover from {url}")
    return _write_chosen(data, book_dir, source)


def write_choice(file_path: str, book_dir: str, source: str, url: Optional[str] = None) -> dict:
    """Write the cover a person chose in the picker; same shape as `fetch_cover`.

    `source='embedded'` re-extracts the file's own jacket and writes that — the
    one candidate with no URL, and therefore the one thing neither
    `fetch_cover` nor a resolved conflict could ever put back. Every other
    source is the `url` the gather returned, and goes through `fetch_cover`:
    the picker and the conflict queue converge on one writer rather than two.

    Only the *mechanics* live here. The policy half of D6 — a source outside
    `SOURCE_PRIORITY`, an online source with no url, an embedded one with a url
    — is refused in the main process, on the boundary the renderer can actually
    reach, where the refusal is a value the user reads ("never an empty grid")
    rather than an exception. What is left is what cannot be done at all: a
    source with no url has nothing to write, and a file with no embedded jacket
    has nothing to put back.
    """
    if source != "embedded":
        return fetch_cover(book_dir, url, source)

    data = extract_embedded_cover(file_path)
    if not data:
        raise ValueError("This file carries no cover to put back")
    return _write_chosen(data, book_dir, source)


def set_cover_from_file(book_dir: str, image_path: str) -> dict:
    """Write an image from this machine as the book's cover (D6).

    The third way a cover arrives, and the only one that starts from neither a
    URL nor the book's own file: the path was chosen in a main-process dialog,
    so it is an absolute path the renderer never sees. Everything after that is
    the path the other two already take — `_write_chosen` derives the 600/200
    renditions from `_renditions` and writes the two fixed filenames — because a
    second encoder or a second thumbnail size would be a second answer to a
    question this module has already answered (D6, `docs/superpowers/specs/
    2026-09-25-cover-sources-design.md`).

    Deliberately **not** a source: an upload is a write, not something the
    gather could have produced, so it takes no `source` parameter, `SOURCE_PRIORITY`
    gains no key, and `_score` is untouched — a fourth key there would be a
    scoring change, and `refusalFor`'s first refusal would stop meaning "a source
    the gather could have produced". The `"upload"` this passes to the writer is
    provenance for the returned dict only; nothing persists it.

    The guard runs before anything is written, and its refusals are sentences the
    user reads — the main process hands the `ValueError`'s message straight to the
    dialog's own line (D6-d), because "nothing was written" and "here is why" have
    to arrive together.
    """
    return _write_chosen(_read_cover_file(image_path), book_dir, "upload")


def _read_cover_file(image_path: str) -> bytes:
    """The bytes of the file that is to become a cover, or the sentence refusing it.

    Two refusals, both of them states a person can see and act on: a file PIL
    cannot read as an image, and one smaller than the **120 px** floor
    `score_candidates` applies above. That number is *quoted* from there rather
    than re-chosen — a candidate the picker may not offer is not one an upload
    may accept, and a person who saw the grid refuse an image would have no way
    to learn why the dialog took it.

    Raised as `ValueError` on purpose (D6-d): the message is the JSON-RPC
    `error`, and therefore the value the picker prints. Nothing has been written
    when one of these fires — the writer is never reached.
    """
    try:
        with open(image_path, "rb") as fh:
            data = fh.read()
    except OSError:
        # Missing, unreadable, or a directory — three causes, one sentence a
        # person can act on: the file they picked is not one this app can read.
        raise ValueError("That file could not be read") from None

    # The pixels, not just the header. `Image.open` reads a file's dimensions
    # lazily, so a *truncated* image — a half-finished download, which is the
    # likeliest damaged file a person picks — passes `open` quite happily and
    # only fails when something wants its bytes. Measured before this line
    # existed: a JPEG cut to a third arrived at the dialog as
    # `OSError: image file is truncated (2 bytes not processed)`, a Python
    # exception where this guard's whole job is a sentence. Loading here keeps
    # every refusal inside two categories a person can act on, and keeps the
    # promise structural rather than inherited from `_write_cover`'s internal
    # order: nothing is written before this function returns.
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        width, height = img.size
    except Image.UnidentifiedImageError:
        raise ValueError("That file is not an image Musaeum can read") from None
    except Exception:
        # A real image that cannot be read all the way through: damaged, cut
        # short, or something Pillow gives up on partway. Its own sentence,
        # because "not an image" would be false about a file that plainly is one
        # — and a person who picked a half-downloaded file needs to hear that,
        # not to be told their file is not an image.
        raise ValueError("That image is damaged — Musaeum could not read all of it") from None

    if width < 120 or height < 120:
        raise ValueError(
            f"That image is {width}x{height} px — a cover needs at least 120 px on each side"
        )
    return data


def preview_data_url(data: Optional[bytes], quality: int = 80) -> Optional[str]:
    """A small inlined JPEG for `data`, or `None` if it is not an image.

    The renderer's CSP is `img-src 'self' musaeum: data: blob:` and names no
    remote origin, so a cover can only be *shown* to a person as a data URL (or
    through the `musaeum://` route, which serves what is already on disk). This
    is what a cover-conflict candidate needs to become visible at all — see
    `docs/superpowers/specs/2026-09-21-cover-choice-design.md`, D3, whose
    deferred condition (a cover conflict actually appearing) fired on
    2026-09-21 the day slice 1a landed and made them more likely.
    """
    if not data:
        return None
    try:
        img = Image.open(io.BytesIO(data))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        copy = img.copy()
        copy.thumbnail((PREVIEW_MAX, PREVIEW_MAX * 2))
        buf = io.BytesIO()
        copy.save(buf, "JPEG", quality=quality)
    except Exception:
        # Not an image, or one PIL cannot read — no preview is a state the
        # caller renders ("the image could not be shown"), never an exception
        return None
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def previews_for(urls: list) -> dict:
    """`{url: data_url}` for the URLs that answered with an image.

    Bounded twice on purpose: `MAX_PREVIEWS` URLs considered per call, and each
    preview capped at `PREVIEW_MAX` px — a conflict carries two or three
    candidates, and the whole point of a preview is to travel cheaply through
    the IPC boundary that a remote URL cannot cross.
    """
    out = {}
    for url in list(dict.fromkeys(urls))[:MAX_PREVIEWS]:
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            continue
        preview = preview_data_url(_download(url))
        if preview:
            out[url] = preview
    return out
