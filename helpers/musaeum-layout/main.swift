// musaeum-layout — a page's reading order from Apple Vision, as JSON lines.
//
// The PDF reflow (docs/superpowers/specs/2026-10-07-pdf-reflow-reader-design.md,
// D4R and Annex C.5) takes its regions and their order from here and its words
// from the PDF's own text layer, so the OCR transcript this prints is a hint,
// never the book's text. Coordinates are PDF user-space points with a
// bottom-left origin — the space pdfium's character boxes live in — so the
// sidecar can assign characters to regions without knowing how a page was
// rendered. Measured: 5,512 of 5,650 characters on Universe p.78 land inside
// a region; the rest are figure labels.
//
// Usage: musaeum-layout <pdf> [--pages a-b] [--concurrency n] [--scale s]
//
// Builds for macOS 12+ (scripts/build-layout-helper.sh) so it can always say
// why it cannot help: below macOS 26 it prints {"supported": false} and exits 0.
import CoreGraphics
import Foundation
import PDFKit
import Vision

let helperVersion = 1

struct Options {
    var path = ""
    var first = 1
    var last = Int.max
    // 20 Universe pages: 29.0 s at 1, 11.0 s at 4, 8.5 s at 8 (2026-10-08).
    var concurrency = 8
    // Region boundaries at 1.5 match 2.5; time does not change with scale.
    var scale: CGFloat = 1.5
}

func parse(_ args: [String]) -> Options? {
    var o = Options()
    var i = 1
    while i < args.count {
        let a = args[i]
        func next() -> String? { i += 1; return i < args.count ? args[i] : nil }
        switch a {
        case "--pages":
            guard let v = next() else { return nil }
            let parts = v.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 2, parts[0] >= 1, parts[1] >= parts[0] else { return nil }
            o.first = parts[0]; o.last = parts[1]
        case "--concurrency":
            guard let v = next(), let n = Int(v), n >= 1 else { return nil }
            o.concurrency = n
        case "--scale":
            guard let v = next(), let s = Double(v), s > 0 else { return nil }
            o.scale = CGFloat(s)
        default:
            if a.hasPrefix("--") || !o.path.isEmpty { return nil }
            o.path = a
        }
        i += 1
    }
    return o.path.isEmpty ? nil : o
}

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/// The page as drawn (rotation applied), and the map from that drawing's
/// unscaled space back to PDF user space.
struct Raster {
    let image: CGImage
    let size: CGSize  // drawn size in points
    let toPage: CGAffineTransform
    let box: CGRect  // the crop box, user space
}

func render(_ page: PDFPage, scale: CGFloat) -> Raster? {
    let box = page.bounds(for: .cropBox)
    let toDrawn = page.transform(for: .cropBox)
    let drawn = box.applying(toDrawn)
    let w = Int((drawn.width * scale).rounded()), h = Int((drawn.height * scale).rounded())
    guard w > 0, h > 0, let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return nil }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.scaleBy(x: scale, y: scale)
    page.draw(with: .cropBox, to: ctx)
    guard let image = ctx.makeImage() else { return nil }
    let origin = CGAffineTransform(translationX: -drawn.minX, y: -drawn.minY)
    return Raster(
        image: image, size: drawn.size,
        toPage: toDrawn.concatenating(origin).inverted(), box: box)
}

@available(macOS 26.0, *)
func pageRect(_ r: NormalizedRect, _ raster: Raster) -> [Double] {
    let drawn = r.toImageCoordinates(raster.size, origin: .lowerLeft)
    let p = drawn.applying(raster.toPage)
    return [p.minX, p.minY, p.maxX, p.maxY].map { (Double($0) * 100).rounded() / 100 }
}

@available(macOS 26.0, *)
func analyse(_ page: PDFPage, number: Int, scale: CGFloat) async -> [String: Any] {
    let started = Date()
    guard let raster = render(page, scale: scale) else {
        return ["page": number, "error": "render failed"]
    }
    let observations: [DocumentObservation]
    do {
        observations = try await RecognizeDocumentsRequest().perform(on: raster.image)
    } catch {
        return ["page": number, "error": "vision: \(error.localizedDescription)"]
    }
    var regions: [[String: Any]] = []
    var tables: [[String: Any]] = []
    for obs in observations {
        let doc = obs.document
        for p in doc.paragraphs {
            regions.append([
                "kind": "paragraph", "order": regions.count,
                "bbox": pageRect(p.boundingRegion.boundingBox, raster),
                "text": p.transcript,
            ])
        }
        // Vision also reports a table's cells as paragraphs; the sidecar keeps
        // the table and drops the paragraphs inside it.
        for t in doc.tables {
            var cells: [[String: Any]] = []
            for row in t.rows {
                for cell in row {
                    cells.append([
                        "row": cell.rowRange.lowerBound, "col": cell.columnRange.lowerBound,
                        "rowspan": cell.rowRange.count, "colspan": cell.columnRange.count,
                        "bbox": pageRect(cell.content.boundingRegion.boundingBox, raster),
                        "text": cell.content.text.transcript,
                    ])
                }
            }
            tables.append(["bbox": pageRect(t.boundingRegion.boundingBox, raster), "cells": cells])
        }
    }
    let b = raster.box
    return [
        "page": number,
        "box": [b.minX, b.minY, b.maxX, b.maxY],
        "rotation": page.rotation,
        "ms": Int(Date().timeIntervalSince(started) * 1000),
        "regions": regions,
        "tables": tables,
    ]
}

@main
struct Main {
    static func main() async {
        guard let o = parse(CommandLine.arguments) else {
            FileHandle.standardError.write(
                "usage: musaeum-layout <pdf> [--pages a-b] [--concurrency n] [--scale s]\n"
                    .data(using: .utf8)!)
            exit(2)
        }
        guard #available(macOS 26.0, *) else {
            emit(["helper": "musaeum-layout", "version": helperVersion, "supported": false])
            exit(0)
        }
        guard let doc = PDFDocument(url: URL(fileURLWithPath: o.path)) else {
            emit(["helper": "musaeum-layout", "version": helperVersion, "supported": true,
                  "error": "cannot open document"])
            exit(1)
        }
        emit(["helper": "musaeum-layout", "version": helperVersion, "supported": true,
              "pages": doc.pageCount])
        let last = min(o.last, doc.pageCount)
        guard o.first <= last else { exit(0) }
        let numbers = Array(o.first...last)

        // Pages run concurrently and are written strictly in page order, so a
        // reader of the stream can treat line n as page n's whole answer.
        var pending: [Int: [String: Any]] = [:]
        var nextOut = o.first
        await withTaskGroup(of: [String: Any].self) { group in
            var it = numbers.makeIterator()
            func add() {
                guard let n = it.next() else { return }
                // PDFPage is not Sendable; each task opens its own handle on
                // the document so no page object crosses a task boundary.
                let path = o.path, scale = o.scale
                group.addTask {
                    guard let d = PDFDocument(url: URL(fileURLWithPath: path)),
                        let page = d.page(at: n - 1)
                    else { return ["page": n, "error": "cannot open page"] }
                    return await analyse(page, number: n, scale: scale)
                }
            }
            for _ in 0..<o.concurrency { add() }
            for await result in group {
                pending[result["page"] as! Int] = result
                while let ready = pending.removeValue(forKey: nextOut) {
                    emit(ready)
                    nextOut += 1
                }
                add()
            }
        }
    }
}
