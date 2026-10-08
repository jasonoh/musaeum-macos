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
TITLE_SIMILARITY = 0.8
MIN_IMAGE_SIDE = 32
FURNITURE_BAND = 0.08
FURNITURE_MAX_CHARS = 80
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
    upright: list[str] = field(default_factory=list)
    rotated: list[str] = field(default_factory=list)
    plate_expected: bool = False


def _in_any(c: Char, boxes: Sequence[Box]) -> bool:
    return any(b[0] <= c.cx <= b[2] and b[1] <= c.cy <= b[3] for b in boxes)


def _is_furniture(seg: list[Char], text: str, page_box: Optional[Box]) -> bool:
    if page_box is None or len(text.strip()) > FURNITURE_MAX_CHARS:
        return False
    height = page_box[3] - page_box[1]
    top = max(c.top for c in seg)
    bottom = min(c.bottom for c in seg)
    return bottom >= page_box[3] - FURNITURE_BAND * height or top <= page_box[1] + FURNITURE_BAND * height


def _has_ink(page) -> bool:
    image = page.render(scale=INK_SCALE).to_pil().convert("L")
    return image.getextrema()[0] < INK_THRESHOLD


def page_evidence(page, chars: Sequence[Char], exclude: Sequence[Box] = (), page_box: Optional[Box] = None) -> PageEvidence:
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
                _emit(seg, ev.segments, page_box)
                seg = []
            seg.append(c)
            if not c.is_space:
                prev = c
        _emit(seg, ev.segments, page_box)
    return ev


def _emit(seg: list[Char], out: list[list[str]], page_box: Optional[Box]) -> None:
    glyphs = [c for c in seg if not c.is_space]
    if not glyphs:
        return
    text = line_text(seg)
    if _is_furniture(glyphs, text, page_box):
        return
    toks = tokens(text)
    if text.rstrip().endswith(("-", "￾", "‐")) and toks:
        toks = toks[:-1]
    if toks:
        out.append(toks)


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


def check_toc(epub_path: str, expected: Optional[list[tuple[str, int]]]) -> list[str]:
    fails: list[str] = []
    with zipfile.ZipFile(epub_path) as zf:
        entries = nav_entries(zf)
        names = set(zf.namelist())
        ids: dict[str, dict[str, ElementTree.Element]] = {}
        if not entries:
            return ["G5 the nav has no entries"]
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
