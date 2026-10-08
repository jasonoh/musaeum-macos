import io

import pypdfium2 as pdfium
from PIL import Image

from reflow import gate, layout
from reflow.epub import write_epub
from reflow.layout import _crop, _figure_regions, analyse, render_plate
from reflow.vision import PageLayout, Region
from reflow.model import Block, Document, PageResult
from tests.reflow_pdfs import Page, Rect, Text, write_pdf

BODY = [Text(72, 720 - 14 * i, f"Body line {i} carries enough characters to make this a text page.") for i in range(4)]


def _page(tmp_path, page, name="f.pdf"):
    pdf = pdfium.PdfDocument(write_pdf(tmp_path / name, [page]))
    return pdf, pdf[0]


def _dark_share(data):
    hist = Image.open(io.BytesIO(data)).convert("L").histogram()
    return sum(hist[:128]) / sum(hist)


def test_crop_renders_the_box_it_is_given(tmp_path):
    pdf, page = _page(tmp_path, Page(rects=[Rect(300, 300, 120, 90)]))
    crop = _crop(page, (300, 300, 420, 390), page.get_bbox())
    assert crop is not None and crop.image_type == "png"
    assert abs(crop.width - 240) <= 12 and abs(crop.height - 180) <= 12
    assert _dark_share(crop.data) > 0.8


def test_crop_honours_a_crop_box_origin(tmp_path):
    pdf, page = _page(tmp_path, Page(rects=[Rect(300, 300, 120, 90)], crop=(33, 33, 581, 759)))
    crop = _crop(page, (300, 300, 420, 390), page.get_bbox())
    assert crop is not None and _dark_share(crop.data) > 0.8


def test_crop_off_the_page_is_none_not_an_exception(tmp_path):
    pdf, page = _page(tmp_path, Page())
    assert _crop(page, (700, 700, 800, 800), page.get_bbox()) is None


def test_a_large_crop_is_jpeg(tmp_path):
    pdf, page = _page(tmp_path, Page(rects=[Rect(50, 50, 500, 600, 0.5)]))
    crop = _crop(page, (50, 50, 550, 650), page.get_bbox())
    assert crop.image_type == "jpeg" and crop.data.startswith(b"\xff\xd8")


def test_text_mask_respects_the_page_origin(tmp_path):
    # A block of text on a page whose crop box starts at x=80. With the
    # origin ignored, the mask lands 80pt left of the text and the text's
    # own ink becomes a "table-like" region.
    texts = [Text(100, 700 - 12 * i, "Masked text that must never become a figure region") for i in range(10)]
    pdf, page = _page(tmp_path, Page(texts=texts, rects=[Rect(300, 200, 120, 90)], crop=(80, 80, 600, 780)))
    figures, table_like = _figure_regions(page, [(98, 588, 400, 712)], page.get_bbox())
    assert table_like == []
    assert len(figures) == 1
    left, bottom, right, top = figures[0]
    assert left <= 300 and right >= 420 and bottom <= 200 and top >= 290


def test_a_full_page_photo_with_little_text_is_a_figure(tmp_path):
    pdf, page = _page(tmp_path, Page(texts=BODY[:1], rects=[Rect(0, 0, 612, 700, 0.3)]))  # 88% of the page
    figures, _ = _figure_regions(page, [(72, 715, 500, 730)], page.get_bbox())
    assert len(figures) == 1


def test_plate_renders_a_textless_page(tmp_path):
    pdf, page = _page(tmp_path, Page(rects=[Rect(0, 0, 612, 792, 0.3)]))
    plate = render_plate(page)
    assert plate is not None and plate.image_type == "jpeg"
    assert max(plate.width, plate.height) <= 1400


def test_a_blank_page_has_no_plate(tmp_path):
    pdf, page = _page(tmp_path, Page())
    assert render_plate(page) is None


LABELLED = BODY + [Text(320, 340, "Label inside the figure")]
LABEL_LAYOUT = {
    1: PageLayout(
        page=1, box=(0, 0, 612, 792),
        regions=[Region(0, (70, 670, 450, 732), ""), Region(1, (310, 335, 480, 352), "Label inside the figure")],
    )
}


def test_a_failed_crop_keeps_the_figures_labels(tmp_path, monkeypatch):
    path = write_pdf(tmp_path / "l.pdf", [Page(texts=LABELLED, rects=[Rect(300, 300, 200, 90, 0.8)])])
    monkeypatch.setattr(layout, "_crop", lambda *a, **k: None)
    doc = analyse(path, layouts=LABEL_LAYOUT)
    assert "Label inside the figure" in " ".join(b.text for b in doc.pages[0].blocks)
    assert len(doc.crop_failures) == 1 and not any(b.kind == "figure" for b in doc.pages[0].blocks)


def test_a_written_crop_swallows_its_labels(tmp_path):
    path = write_pdf(tmp_path / "w.pdf", [Page(texts=LABELLED, rects=[Rect(300, 300, 200, 90, 0.8)])])
    doc = analyse(path, layouts=LABEL_LAYOUT)
    assert "Label inside the figure" not in " ".join(b.text for b in doc.pages[0].blocks)
    assert [b.image_type for b in doc.pages[0].blocks if b.kind == "figure"] == ["png"]
    assert "Label inside the figure" in doc.dropped_text


def test_a_textless_page_becomes_a_plate(tmp_path):
    path = write_pdf(tmp_path / "p.pdf", [Page(texts=LABELLED), Page(rects=[Rect(0, 0, 612, 792, 0.3)])])
    doc = analyse(path, layouts={1: LABEL_LAYOUT[1]})
    assert [b.plate for b in doc.pages[1].blocks] == [True]


def _image(kind, w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "gray").save(buf, "PNG" if kind == "png" else "JPEG")
    return buf.getvalue()


def test_epub_names_and_types_images_by_their_encoding(tmp_path):
    doc = Document(source=str(tmp_path / "missing.pdf"))
    doc.pages = [
        PageResult(index=0, chars=500, blocks=[
            Block("para", text="Some text.", page=0),
            Block("figure", page=0, image=_image("png", 80, 60), image_width=80, image_height=60, image_type="png"),
            Block("figure", page=0, image=_image("jpeg", 300, 200), image_width=300, image_height=200, image_type="jpeg"),
        ]),
        PageResult(index=1, chars=0, blocks=[
            Block("figure", page=1, image=_image("jpeg", 600, 800), image_width=600, image_height=800, image_type="jpeg", plate=True),
        ]),
    ]
    out = tmp_path / "out.epub"
    write_epub(doc, str(out), "T")
    assert gate.check_package(str(out)) == []
    assert gate.check_figures(str(out), expected_figures=2, expected_plates=1) == []
