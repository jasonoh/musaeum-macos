"""Cover candidate scoring, selection, and writing.

score = resolution*0.4 + aspect_ratio*0.3 + source_priority*0.2 + file_size*0.1
Top two within 15% → also emit a 'cover' review conflict (top one is still
applied so the book is never coverless while waiting on review).
"""

import base64
import io
import os
from typing import Optional

import requests
from PIL import Image

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


def select_cover(candidates: list, book_dir: str) -> dict:
    """candidates: [{source, url?, data?}]. Writes the winner to book_dir.

    Returns {cover: {...} | None, review: bool, candidates: [scored]}.
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

    if not scored:
        return {"cover": None, "review": False, "candidates": []}

    scored.sort(key=lambda c: c["score"], reverse=True)
    winner = scored[0]
    review = len(scored) > 1 and (winner["score"] - scored[1]["score"]) < 0.15 * winner["score"]

    cover = _write_cover(winner["data"], book_dir)
    cover["source"] = winner["source"]
    cover["width"] = winner["width"]
    cover["height"] = winner["height"]

    return {
        "cover": cover,
        "review": review,
        "candidates": [
            {"source": c["source"], "url": c["url"], "width": c["width"], "height": c["height"]}
            for c in scored
            if c["url"]
        ],
    }


def _write_cover(data: bytes, book_dir: str) -> dict:
    img = Image.open(io.BytesIO(data))
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    full = _encode(img, (FULL_MAX, FULL_MAX * 2), 88)
    thumb = _encode(img, (THUMB_MAX, THUMB_MAX * 2), 85)
    full_path = os.path.join(book_dir, "cover_full.jpg")
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


def fetch_cover(book_dir: str, url: Optional[str] = None, source: str = "google_books") -> dict:
    """Download a specific cover URL (conflict resolution path)."""
    if not url:
        raise ValueError("fetch_cover requires a url")
    data = _download(url)
    if not data:
        raise ValueError(f"Could not download cover from {url}")
    img = Image.open(io.BytesIO(data))
    cover = _write_cover(data, book_dir)
    cover.update({"source": source, "width": img.size[0], "height": img.size[1]})
    return cover


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
