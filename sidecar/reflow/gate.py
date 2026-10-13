"""The corpus gate (spec Annex C.4): checks that can fail a book.

Slice 1 "passed" because its gate asked only whether the XML parsed and
counted words as a multiset, which cannot see order. Every check here is
computed from the artifact and from what the source PDF says. Where a check is
defined over the pipeline's own bookkeeping — the figure boxes it wrote, the
pages it read from Vision, the furniture it dropped — that input is a named
parameter, so it is visible in the call rather than trusted silently.

**One rule it shares with the pipeline, deliberately.** G2 and G6 read the
source's *words* with C.5 item 3's space rule (`regions.line_text`), because
that rule is the spec's definition of a word: a stored space survives only at a
gap of at least 0.1× the size. Reading the stored characters raw called the
repair of *Universe*'s `fi ghting`, `Th e sun` and `diff erence` lost words, and
made G1's golden passages and G6 contradict each other — measured on *Universe*
pp.1–60: 10.6% loss raw against 5.9% with the rule. It stays strict in the
direction that matters: a space the source keeps is a boundary, so a pipeline
that merges across a real word space still loses those words.
"""

from __future__ import annotations

import difflib
import io
import posixpath
import re
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from html import unescape
from typing import Iterable, Optional, Sequence
from xml.etree import ElementTree

from . import furniture
from .chars import Char, baseline_lines
from .regions import line_text

Box = tuple[float, float, float, float]

OPF_NS = "{http://www.idpf.org/2007/opf}"
XHTML_NS = "{http://www.w3.org/1999/xhtml}"
EPUB_NS = "{http://www.idpf.org/2007/ops}"
CONTAINER_NS = "{urn:oasis:names:tc:opendocument:xmlns:container}"

TRIGRAM_RECALL_MIN = 0.95
WORD_LOSS_MAX = 0.03
TOC_HEADING_SHARE_MIN = 0.90
TOC_MAX_PAGES_PER_ENTRY = 50
TITLE_SIMILARITY = 0.8
MIN_IMAGE_SIDE = 32
PLATE_MAX_CHARS = 50
INK_SCALE = 0.25
INK_THRESHOLD = 245

_QUOTES = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "￾": "-"})
_TOKEN = re.compile(r"[0-9A-Za-zÀ-ÖØ-öø-ÿ]+(?:'[A-Za-z]+)?")
_LINE_HYPHEN = re.compile(r"(\w)[-‐‑]\s*[\r\n]+\s*(\w)")
_TAG = re.compile(r"<[^>]+>")
_HEAD = re.compile(r"<head\b.*?</head>", re.S | re.I)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_HEADING_TAGS = {f"{XHTML_NS}h{i}" for i in range(1, 7)}


def tokens(text: str) -> list[str]:
    """Lower-case word tokens, quotes folded, words broken at a line end rejoined."""
    text = _LINE_HYPHEN.sub(r"\1\2", text.translate(_QUOTES))
    return [t.lower() for t in _TOKEN.findall(text)]


# --- reading the package -------------------------------------------------
def _opf(zf: zipfile.ZipFile) -> tuple[str, ElementTree.Element]:
    container = ElementTree.fromstring(zf.read("META-INF/container.xml"))
    rootfile = container.find(f".//{CONTAINER_NS}rootfile")
    path = rootfile.get("full-path") if rootfile is not None else "OEBPS/content.opf"
    return path, ElementTree.fromstring(zf.read(path))


def _manifest(zf: zipfile.ZipFile) -> tuple[ElementTree.Element, dict[str, tuple[str, str, str]]]:
    """The OPF, and its manifest as id → (zip path, media type, properties)."""
    path, opf = _opf(zf)
    base = posixpath.dirname(path)
    items = {}
    for item in opf.iter(f"{OPF_NS}item"):
        href = item.get("href") or ""
        items[item.get("id") or ""] = (
            posixpath.normpath(posixpath.join(base, href)),
            item.get("media-type") or "",
            item.get("properties") or "",
        )
    return opf, items


def spine_documents(zf: zipfile.ZipFile) -> list[str]:
    opf, items = _manifest(zf)
    return [items[ref.get("idref")][0] for ref in opf.iter(f"{OPF_NS}itemref") if ref.get("idref") in items]


def spine_text(epub_path: str) -> str:
    """The book's text in reading order: every spine document, tags and <head> removed."""
    with zipfile.ZipFile(epub_path) as zf:
        parts = []
        for name in spine_documents(zf):
            raw = zf.read(name).decode("utf-8", "replace")
            parts.append(unescape(_TAG.sub(" ", _HEAD.sub(" ", raw))))
    return "\n".join(parts)


# --- G1 golden passages ----------------------------------------------------
def check_golden(spine: str, passages: Sequence[str]) -> list[str]:
    haystack = " " + " ".join(tokens(spine)) + " "
    fails = []
    for passage in passages:
        needle = " ".join(tokens(passage))
        if needle and f" {needle} " not in haystack:
            fails.append(f"G1 passage not contiguous: {' '.join(needle.split()[:8])}…")
    return fails


# --- G2/G3/G4 evidence from one PDF page -----------------------------------
@dataclass
class PageEvidence:
    segments: list[list[str]] = field(default_factory=list)
    rotated: list[str] = field(default_factory=list)
    upright: list[str] = field(default_factory=list)
    plate_expected: bool = False


def _in_any(c: Char, boxes: Sequence[Box]) -> bool:
    return any(b[0] <= c.cx <= b[2] and b[1] <= c.cy <= b[3] for b in boxes)


def _bounds(seg: Sequence[Char]) -> tuple[float, float]:
    return max(c.top for c in seg), min(c.bottom for c in seg)


def _in_band(seg: Sequence[Char], page_box: Optional[Box]) -> bool:
    if page_box is None:
        return False
    top, bottom = _bounds(seg)
    return furniture.in_band(top, bottom, page_box[1], page_box[3])


def _is_furniture(seg: Sequence[Char], text: str, page_box: Optional[Box]) -> bool:
    """Is this line page furniture rather than the book's words?

    The gate's side of `layout.mark_running_heads`, and it has to agree with it:
    counting the words a *correct* drop removed is exactly how the artifact of a
    broken rule passed. Two routes, and the first is the one this check has
    always had — a band line of the display cap (80 characters) or fewer is
    excused outright, so G2 never demands a word that can only be a running head.
    The second is the pipeline's shape route, read here off the text layer's own
    line rather than Vision's region (`reflow.furniture` carries it once for
    both): a letter-spaced line, or anything the page prints in its outer margin.
    The gate's route is a *superset* of the pipeline's on purpose — it may excuse
    a line the pipeline kept, which costs G2 a little evidence and can never make
    it demand a word the pipeline was right to drop.
    """
    text = text.strip()
    if not text or page_box is None:
        return False
    if _in_band(seg, page_box):
        if len(text) <= furniture.MAX_CHARS:
            return True
        if furniture.letter_spaced(text):
            return True
    top, bottom = _bounds(seg)
    return furniture.shaped(top, bottom, page_box[1], page_box[3], text)


def _has_ink(page) -> bool:
    image = page.render(scale=INK_SCALE).to_pil().convert("L")
    return image.getextrema()[0] < INK_THRESHOLD


def page_evidence(
    page,
    chars: Sequence[Char],
    exclude: Sequence[Box] = (),
    page_box: Optional[Box] = None,
) -> PageEvidence:
    """What the gate needs from one page of the source PDF.

    A *segment* is a run of characters on one baseline with no gap wider than
    the line's median glyph height, so it never crosses a gutter: its word
    trigrams must survive into the artifact whatever the layout was. A segment
    ending in a hyphen loses its last fragment, which the artifact rejoins.
    """
    ev = PageEvidence()
    glyph_count = sum(1 for c in chars if not c.is_space)
    if glyph_count < PLATE_MAX_CHARS and page is not None:
        ev.plate_expected = _has_ink(page)
    ev.rotated = tokens("".join(c.text for c in chars if c.rotated))
    upright = [c for c in chars if not c.rotated]
    lines = baseline_lines(upright)
    ev.upright = tokens("\n".join(line_text(ln) for ln in lines))
    for line in baseline_lines([c for c in upright if not _in_any(c, exclude)]):
        glyphs = [c for c in line if not c.is_space]
        if not glyphs:
            continue
        heights = sorted(c.height for c in glyphs)
        limit = heights[len(heights) // 2]
        seg: list[Char] = []
        prev: Optional[Char] = None
        for c in line:
            if prev is not None and not c.is_space and c.left - prev.right > limit:
                _emit(seg, ev, page_box)
                seg = []
            seg.append(c)
            if not c.is_space:
                prev = c
        _emit(seg, ev, page_box)
    return ev


def _emit(seg: list[Char], ev: PageEvidence, page_box: Optional[Box]) -> None:
    glyphs = [c for c in seg if not c.is_space]
    if not glyphs:
        return
    text = line_text(seg)
    if _is_furniture(glyphs, text, page_box):
        return
    toks = tokens(text)
    if text.rstrip().endswith(("-", "\ufffe", "‐")) and toks:
        toks = toks[:-1]
    if not toks:
        return
    ev.segments.append(toks)


def trigram_recall(segments: Iterable[list[str]], spine_tokens: Sequence[str]) -> tuple[float, int]:
    """Share of within-segment word trigrams found contiguous in the artifact."""
    have = {tuple(spine_tokens[i : i + 3]) for i in range(len(spine_tokens) - 2)}
    total = found = 0
    for seg in segments:
        for i in range(len(seg) - 2):
            total += 1
            found += tuple(seg[i : i + 3]) in have
    return (found / total if total else 1.0), total


def rotated_only(rotated: Iterable[str], upright: Iterable[str]) -> set[str]:
    """Tokens that exist in the book only as rotated text — the stamp's own words."""
    seen = set(upright)
    return {t for t in rotated if t not in seen and len(t) >= 4}


def check_rotated(spine_tokens: Sequence[str], stamp: set[str]) -> list[str]:
    leaked = sorted(stamp.intersection(spine_tokens))
    return [f"G3 rotated text in the flow: {', '.join(leaked[:6])}"] if leaked else []


# --- G4 figures ------------------------------------------------------------
_MAGIC = {"png": b"\x89PNG\r\n\x1a\n", "jpeg": b"\xff\xd8\xff"}
_EXT = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg"}
_MEDIA = {"image/png": "png", "image/jpeg": "jpeg"}


def check_figures(epub_path: str, *, expected_figures: Optional[int], expected_plates: Optional[int]) -> list[str]:
    from PIL import Image

    fails: list[str] = []
    figures = plates = 0
    with zipfile.ZipFile(epub_path) as zf:
        _, items = _manifest(zf)
        for path, media, _ in items.values():
            if not media.startswith("image/"):
                continue
            data = zf.read(path)
            name = posixpath.basename(path)
            by_bytes = next((k for k, m in _MAGIC.items() if data.startswith(m)), None)
            by_ext = _EXT.get(posixpath.splitext(name)[1].lower())
            by_media = _MEDIA.get(media)
            if not (by_bytes == by_ext == by_media):
                fails.append(f"G4 {name}: bytes {by_bytes}, extension {by_ext}, media type {media}")
            try:
                w, h = Image.open(io.BytesIO(data)).size
                if min(w, h) < MIN_IMAGE_SIDE:
                    fails.append(f"G4 {name}: {w}x{h} is a sliver")
            except Exception as err:
                fails.append(f"G4 {name}: unreadable ({type(err).__name__})")
            if "-plate." in name:
                plates += 1
            else:
                figures += 1
    if expected_figures is not None and figures != expected_figures:
        fails.append(f"G4 {figures} figures written, {expected_figures} detected")
    if expected_plates is not None and plates != expected_plates:
        fails.append(f"G4 {plates} plates written, {expected_plates} text-less pages carry ink")
    return fails


# --- G5 TOC ----------------------------------------------------------------
def _norm_title(text: str) -> str:
    return " ".join(_CONTROL.sub("", text).lower().split())[:100]


def _similar(a: str, b: str) -> bool:
    a, b = _norm_title(a), _norm_title(b)
    if not a or not b:
        return False
    if a == b or (min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a) or a.endswith(b) or b.endswith(a))):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= TITLE_SIMILARITY


def nav_entries(zf: zipfile.ZipFile) -> list[tuple[str, int, str]]:
    """The toc nav as (title, depth, resolved zip path with fragment)."""
    _, items = _manifest(zf)
    nav_path = next((p for p, _, props in items.values() if "nav" in props.split()), None)
    if nav_path is None:
        return []
    root = ElementTree.fromstring(zf.read(nav_path))
    toc = next((n for n in root.iter(f"{XHTML_NS}nav") if n.get(f"{EPUB_NS}type") == "toc"), None)
    out: list[tuple[str, int, str]] = []

    def walk(ol: ElementTree.Element, depth: int) -> None:
        for li in ol.findall(f"{XHTML_NS}li"):
            a = li.find(f"{XHTML_NS}a")
            if a is not None:
                href = a.get("href") or ""
                target, _, frag = href.partition("#")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(nav_path), target))
                out.append(("".join(a.itertext()).strip(), depth, f"{resolved}#{frag}" if frag else resolved))
            sub = li.find(f"{XHTML_NS}ol")
            if sub is not None:
                walk(sub, depth + 1)

    top = toc.find(f"{XHTML_NS}ol") if toc is not None else None
    if top is not None:
        walk(top, 0)
    return out


def check_toc(epub_path: str, expected: Optional[list[tuple[str, int]]], pages: Optional[int] = None) -> list[str]:
    """G5: the nav against the outline, and against the book's own size.

    `expected=None` means the source's outline offered no usable entries (the
    page-label case, C.5 item 9), so there is nothing to compare entry for
    entry — but the check must still be able to *fail*, and until 2026-10-11 it
    could not: with no expectation it ran the heading-share test on whatever nav
    the artifact happened to carry, so a 355-page book whose TOC was two entries
    (*Modernist Cuisine*: `MODERNIST`, `CUISINE` — its usable outline is empty,
    so the heading pass supplied the TOC) passed with `expected=None`. `pages`
    is the source's page count; when it is given, a nav must carry at least one
    entry per `TOC_MAX_PAGES_PER_ENTRY` pages. The bar is a floor, not a target:
    a book with no chapters at all reflows as one section and fails it, which is
    the honest reading of "you cannot navigate this book" (reversal condition:
    the first real book whose only defect is that it has no chapters).
    """
    fails: list[str] = []
    with zipfile.ZipFile(epub_path) as zf:
        entries = nav_entries(zf)
        names = set(zf.namelist())
        ids: dict[str, dict[str, ElementTree.Element]] = {}
        if not entries:
            return ["G5 the nav has no entries"]
        if pages is not None:
            needed = -(-pages // TOC_MAX_PAGES_PER_ENTRY)
            if len(entries) < needed:
                fails.append(f"G5 {len(entries)} entries for {pages} pages (needs {needed})")
        if expected is not None:
            got = [(_norm_title(t), d) for t, d, _ in entries]
            want = [(_norm_title(t), d) for t, d in expected]
            if len(got) != len(want):
                fails.append(f"G5 nav has {len(got)} entries, outline has {len(want)}")
            else:
                diff = next((i for i, (g, w) in enumerate(zip(got, want)) if g != w), None)
                if diff is not None:
                    fails.append(f"G5 entry {diff + 1}: nav {got[diff]} vs outline {want[diff]}")
        hits = 0
        for title, _, href in entries:
            path, _, frag = href.partition("#")
            if path not in names:
                fails.append(f"G5 {href} does not resolve (no such file)")
                continue
            if path not in ids:
                root = ElementTree.fromstring(zf.read(path))
                ids[path] = {el.get("id"): el for el in root.iter() if el.get("id")}
            element = ids[path].get(frag) if frag else None
            if frag and element is None:
                fails.append(f"G5 {href} does not resolve (no id {frag})")
                continue
            if element is not None and element.tag in _HEADING_TAGS and _similar("".join(element.itertext()), title):
                hits += 1
        share = hits / len(entries)
        if share < TOC_HEADING_SHARE_MIN:
            fails.append(f"G5 {hits} of {len(entries)} entries land on a matching heading ({share:.0%})")
    return fails


# --- G6 words --------------------------------------------------------------
def word_loss(pdf_tokens: Counter, art_tokens: Counter, excluded: Counter) -> tuple[float, Counter]:
    missing = pdf_tokens - art_tokens
    missing.subtract(excluded)
    missing = +missing
    total = sum(pdf_tokens.values())
    return (sum(missing.values()) / total if total else 0.0), missing


# --- G7 package --------------------------------------------------------------
def check_package(epub_path: str) -> list[str]:
    """Structural checks an EPUB reader would refuse the file over."""
    problems: list[str] = []
    with zipfile.ZipFile(epub_path) as zf:
        names = zf.namelist()
        if not names or names[0] != "mimetype":
            problems.append("G7 mimetype is not the first entry")
        if "mimetype" in names:
            if zf.getinfo("mimetype").compress_type != zipfile.ZIP_STORED:
                problems.append("G7 mimetype is compressed")
            if zf.read("mimetype") != b"application/epub+zip":
                problems.append("G7 mimetype has the wrong content")
        for name in ("META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml"):
            if name not in names:
                problems.append(f"G7 {name} is missing")
        for name in names:
            if name.endswith((".xhtml", ".opf", ".ncx", ".xml")):
                try:
                    ElementTree.fromstring(zf.read(name))
                except ElementTree.ParseError as err:
                    problems.append(f"G7 {name} does not parse: {err}")
        if "OEBPS/content.opf" in names and "META-INF/container.xml" in names:
            try:
                _, items = _manifest(zf)
                for path, _, _ in items.values():
                    if path not in names:
                        problems.append(f"G7 manifest href {path} is not in the zip")
            except ElementTree.ParseError:
                pass
    return problems


# --- the band-furniture census (B's own decider) ----------------------------
# The two shapes a reader sees as furniture in the flowing text, matched on the
# artifact's own words. A rights notice, in the forms a printed page carries
# one; every one of *Universe*'s 244 Cengage footer paragraphs carries the
# first, whole or in fragments, and the noise a pass leaves behind is what the
# census is for.
_NOTICE = re.compile(
    r"all rights reserved|rights reserved|may not be copied|prior written permission|rights restrictions",
    re.I,
)
_BLOCK = re.compile(r"<(?:p|h[1-6])\b[^>]*>(.*?)</(?:p|h[1-6])>", re.S | re.I)


def _running_head(text: str) -> bool:
    """A letter-spaced line of capitals — the head's own shape.

    Both extra halves are load-bearing and were measured, not assumed. The
    letters must dominate, because an artifact has no pages to scope the test to
    a band and a letter-spaced *equation* is not a running head: *Universe*'s
    `K 5 °C 1 273`, `L 5 M3.5 5 43.5 5 128` and `2.0 2 MV 5 25 1 5(2.12)` are
    upper case, letter-spaced by the same test the rule uses, and two-thirds
    numerals. The capitals requirement is what excludes the book's own prose
    that happens to be set out letter by letter.
    """
    letters = [c for c in text if c.isalpha()]
    if len(letters) < 2 or len(letters) * 2 < len([c for c in text if not c.isspace()]):
        return False
    return sum(1 for c in letters if c.isupper()) * 5 >= len(letters) * 4 and furniture.letter_spaced(text)


def _key(text: str) -> str:
    """What a shape repeats under: digits collapse, case and space fold."""
    return " ".join(re.sub(r"\d+", "#", text.lower()).split())


def furniture_census(epub_path: str) -> dict:
    """How much printer's furniture an artifact still prints in its flowing text.

    B's own decider, and it exists because **not one of the eight checks counts
    a word an artifact *added***: G2 and G6 measure the words a pass *lost*, so
    *Universe*'s ~500 blocks of running head, page number and legal footer read
    as a pass on every check the gate has. This reads the artifact's own blocks
    and counts the two shapes a reader sees as furniture — a rights notice and a
    letter-spaced running head — with the whole flow as the denominator.

    **A shape the artifact carries once is a page's own, not the printer's**, and
    it is not counted: *Modernist Cuisine* and *Politics, Philosophy, Culture*
    each carry exactly one rights notice — their copyright page, front matter a
    reader may want — and *Politics*' title page sets `P O L I T I C S` and
    `C U L T U R E` in the same capitals a running head uses. What is *furniture*
    is what the printer repeats, so only a shape carried twice or more **under
    one digit-normalized text** counts, which is also what lets a running head
    that carries a different page number on every page still register. That is
    the one place this instrument uses repetition, and a share of *two* is the
    opposite of the fragile thing: the tier needed a per-page key to recur on
    half the book's pages.

    It is deliberately not the rule (`reflow.furniture`). The rule asks *where* a
    block sits on its page, and an artifact has no pages; counting by shape alone
    is what keeps this an independent instrument rather than the rule marking its
    own homework.
    """
    blocks = 0
    notices: Counter = Counter()
    heads: Counter = Counter()
    with zipfile.ZipFile(epub_path) as zf:
        for name in spine_documents(zf):
            raw = zf.read(name).decode("utf-8", "replace")
            for match in _BLOCK.finditer(_HEAD.sub(" ", raw)):
                text = " ".join(unescape(_TAG.sub(" ", match.group(1))).split())
                if not text:
                    continue
                blocks += 1
                if _NOTICE.search(text):
                    notices[_key(text)] += 1
                elif _running_head(text):
                    heads[_key(text)] += 1
    repeated = lambda counts: sum(n for n in counts.values() if n > 1)  # noqa: E731
    return {
        "blocks": blocks,
        "notices": repeated(notices),
        "heads": repeated(heads),
        "furniture": repeated(notices) + repeated(heads),
    }
