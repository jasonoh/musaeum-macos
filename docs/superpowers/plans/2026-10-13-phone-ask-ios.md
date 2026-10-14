# Phone Ask — the phone half (slices 3 and 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader ask about the book they are reading on the phone: a streaming client for the Mac's `POST /api/ai/ask`, behind an `AskBackend` seam, and the reader's Ask sheet with the same probe, rung and disclosure behavior as the Mac panel.

**Architecture:** Slice 3 is Core-only — contract models decoded strictly from the Mac's own goldens, a pure SSE parser, the request encoder, `MusaeumClient.ask` and `AskBackend`/`RelayBackend` — testable with no UI. Slice 4 adds the pure `SectionText` builder and `AskCitations`, the `@Observable AskSession` (the phone's session state: verdict, rung, transcript), the Readium glue that extracts the current section's text, and the `AskSheet` view wired into the reader's chrome.

**Tech Stack:** Swift 6 (strict concurrency `complete`), SwiftUI, iOS 18, Readium Swift toolkit 3.11.0 (pinned, never patched), XcodeGen, XCTest, `URLSession.bytes`.

**Spec:** `docs/superpowers/specs/2026-10-13-phone-ask-design.md` in the Mac repo (D1, D3, D6; AC16–AC26). **This plan's code lives in `../musaeum-ios`**; every path below is relative to that repo unless it starts `../musaeum-macos`. The plan file is kept with the spec in the Mac repo, which owns the contract.

**Hard dependency — SATISFIED 2026-10-14.** The Mac half landed: `docs/superpowers/plans/2026-10-13-phone-ask-mac.md`'s seven tasks are merged on `main` from `aa50bbb` through `697e9c4`, with `npm test` at 100 files / 2230 passed / 0 failed / 0 skipped and the smoke script green on both branches. The contract you are coding against is therefore **present and current**: `docs/rest-api.md` names `POST /api/ai/ask`, the five `ask-*` payload blocks, the `ai` member on `GET /api/health` (`available`, `reason`, `isLocal`, `host`, `model` — never the key), and the additive-member rule that makes `health.ai` absent on an older Mac. `apiVersion` is **1**, and the document gained a run of repairs after its own whole-branch review — so vendor the fixtures from the document as it stands now, not from any copy made before 2026-10-14. Task 1's loud failure on a missing `ask-*` block is your check that this held.

**Two facts the Mac half measured that this plan was written before, and that cost real time to rediscover:** the route's body read is bounded by a **10 s total deadline** (`BODY_TIMEOUT_MS`), not reset by data — so a full 200,000-character section text over a slow tailnet link is refused as a `400 bad request` with no way to tell it from a malformed body; and the response's Content-Type is `text/event-stream; charset=utf-8`, the whole header, parameter and all, so a client comparing it for equality against the bare type fails on every response. Both are now named in `docs/rest-api.md`, which stays the authority — this note exists so the numbers do not arrive as a surprise mid-task, not to restate it.

## Global Constraints

- **The wire contract is the Mac repo's.** Never restate `docs/rest-api.md` here: models and fixtures derive from it by `scripts/vendor-contract-fixtures.sh`. A field you need that the document does not name is a change to the Mac repo, first.
- Always-present fields decode **strictly** through `StrictObject` (a missing key throws, an explicit `null` is `nil`). The one new exception is `health.ai` (absent on a Mac older than this feature) — documented as such in Task 1 and in `AGENTS.md` invariant 4.
- **"Characters" on this route are UTF-16 code units** (`String.utf16.count`), and text is cut at a Unicode-scalar boundary — never between the halves of a surrogate pair. The section text cap is **200,000**; an `ask` question at most 10,000; a selection at most 50,000.
- The bearer token appears in the `Authorization` header only (invariant 10): not in a log, an error, a request body or a probe line.
- The server is never a dependency (invariant 5): Ask being unavailable is an ordinary state with its own surface; reading a downloaded book works with the Mac off.
- No local cache (invariant 7): the transcript, the verdict and the rung live in the reader screen's view-model and die with it. Nothing is written to disk.
- The Readium dependency is never patched (invariant 8). Anything the toolkit cannot do lives in our code.
- `project.yml` is the source of truth; run `xcodegen generate` after adding any file, and commit the regenerated `Musaeum.xcodeproj` (invariant 9).
- **Gates**, every task: `xcodegen generate`, then build and test:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcrun simctl list devices available | grep -i iphone   # AGENTS.md's id was verified 2026-10-09 — pick a live one
DEV=<an available iPhone's id>
xcodebuild -project Musaeum.xcodeproj -scheme Musaeum -destination "id=$DEV" -derivedDataPath ./DD build
xcodebuild -project Musaeum.xcodeproj -scheme Musaeum -destination "id=$DEV" -derivedDataPath ./DD test
```
Single class: add `-only-testing:MusaeumTests/<ClassName>`. Record the baseline test count before Task 1 and report the delta after each task.
- Prose in `.md` files is not hard-wrapped. Every commit ends with the `Co-Authored-By` trailer from the session's attribution reminder; code commits are preceded by the `/verify` skill.
- Two consecutive failed repair attempts on the same test is an escalation: stop and hand back.

## Review Focus

1. **A stream that ends without a `done` or `error`** (the Mac quit, the tailnet dropped, the app was backgrounded) must surface as an error, never as a clean finish — Task 3.
2. **A partial event at the end of the byte stream** (cut mid-JSON) must never be decoded as if complete — Task 2.
3. **Emoji and astral characters in section text, a selection, or a question:** the cap and the offset are in UTF-16 units, no surrogate pair is split, and an offset past the cut becomes `nil` — Task 4.
4. **A section with no text** (an image-only page, a failed extraction) must not send a probe it cannot score against, must not lock the verdict, and must not crash the sheet — Tasks 4 and 5.
5. **A highlight that does not occur in the extracted text** (whitespace differences between Readium's text and the page): the offset falls back to the reader's progression, then to `nil`, and the request still goes — Task 4.
6. **Dismissing the sheet, closing the book, or asking again while an answer streams:** the stream is cancelled, a partial answer is kept as text and marked finished, and nothing keeps running — Task 5.
7. **A Mac too old to know about Ask** (`health.ai` absent), and a Mac with Ask but no model (`ai.available == false`): two different sentences, neither a crash — Tasks 1 and 5.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `scripts/vendor-contract-fixtures.sh` | also extracts `json request=` blocks | 1 |
| `Musaeum/Core/API/ContractModels.swift` | `Health.ai`, `HealthAI`, `StrictObject.objectIfPresent`, `AIUnavailablePayload` | 1 |
| `Musaeum/Core/API/AskContract.swift` (new) | `AskRequest`, `AskEvent` and its payload models, `RecallVerdict`, `AskDoneReason` | 1, 3 |
| `Musaeum/Core/API/MusaeumClient.swift` | `ClientError.aiUnavailable`, `mapStatus`, `ask` | 1, 3 |
| `Musaeum/Core/API/SSEParser.swift` (new) | line-oriented SSE framing | 2 |
| `Musaeum/Core/API/AskBackend.swift` (new) | `AskBackend`, `AskCapability`, `RelayBackend` | 3 |
| `Musaeum/Core/Reader/SectionText.swift` (new) | pure: pieces → bounded text + offset | 4 |
| `Musaeum/Core/Reader/AskCitations.swift` (new) | pure: which TOC entries an answer names | 4 |
| `Musaeum/Core/Reader/AskSession.swift` (new) | the session state machine | 5 |
| `Musaeum/Core/Reader/ReaderModel+Ask.swift` (new), `ReaderHost.swift` | Readium text extraction; `publication` kept on the model | 6 |
| `Musaeum/Features/Reader/AskSheet.swift` (new), `ReaderChrome.swift`, `ReaderScreen.swift` | the sheet and its entry | 6 |
| `Musaeum/Core/Support/Probe.swift`, `scripts/live-probe.sh`, `scripts/ask-stub.mjs` (new) | the non-interactive instrument | 6, 7 |
| `Tests/MusaeumTests/{AskContractTests,SSEParserTests,AskClientTests,SectionTextTests,AskCitationsTests,AskSessionTests}.swift`, `StubURLProtocol.swift` | the suite | 1–5 |

---

# Slice 3 — the client

### Task 1: Contract plumbing — the fixtures, `Health.ai`, the ask models

**Files:**
- Modify: `scripts/vendor-contract-fixtures.sh`
- Modify: `Musaeum/Core/API/ContractModels.swift` (`StrictObject`, `Health`, new `HealthAI`, `AIUnavailablePayload`)
- Create: `Musaeum/Core/API/AskContract.swift`
- Modify: `Musaeum/Core/API/MusaeumClient.swift` (`ClientError.aiUnavailable`, `mapStatus`)
- Test: `Tests/MusaeumTests/AskContractTests.swift`; modify `Tests/MusaeumTests/ClientTests.swift` (503 cases)

**Interfaces:**
- Produces:
  - `struct HealthAI: Decodable, Equatable, Sendable { let available: Bool; let reason: String?; let isLocal: Bool; let host: String; let model: String? }` with a memberwise `init(available:reason:isLocal:host:model:)`; `Health.ai: HealthAI?`.
  - `enum AskMode: String { case preview, probe, ask }`, `enum AskRung: String { case pointer, passage }`, `struct AskSection { var label: String?; var text: String?; var offset: Int?; var truncated: Bool }`, `struct AskRequest { bookId, mode, rung, section, fraction: Double?, selection: String?, question: String? }` with `func body() throws -> Data`.
  - `enum RecallVerdict: Equatable, Sendable { case strong, weak, unknown }`, `enum AskDoneReason: Equatable, Sendable { case stop, length, canceled, timeout, other(String) }`.
  - `struct AskDisclosure: Decodable, Equatable, Sendable { let text: String; let members: [String]; let rung: AskRung; let windowed: Bool; let truncated: [String]; let host: String; let isLocal: Bool; let model: String? }` with a memberwise init.
  - `enum AskEvent: Equatable, Sendable { case disclosure(AskDisclosure), verdict(RecallVerdict), delta(String), done(AskDoneReason), error(String) }` and `static func decode(name: String, data: Data) throws -> AskEvent?` (`nil` for an event name this app does not know).
  - `ClientError.aiUnavailable(String)` — a 503 `ai unavailable` with the Mac's own `reason`; not retryable.

- [ ] **Step 1: Baseline, and vendor the Mac's fixtures**

Record the passing test count (run the full test gate once). Then, with the Mac plan merged:

```bash
MUSAEUM_DOC=../musaeum-macos/docs/rest-api.md scripts/vendor-contract-fixtures.sh
ls Tests/Fixtures/contract
```
Expected after Step 2 below: `ask-delta.json ask-disclosure.json ask-done.json ask-error.json ask-verdict.json` appear, `health.json` now carries an `ai` member, and `request-ask.json` exists. If the `ask-*` files are absent, the Mac half has not landed — stop.

- [ ] **Step 2: Teach the script the `request=` blocks**

In `scripts/vendor-contract-fixtures.sh`, replace the `awk` program with:

```bash
awk -v out="$OUT" '
    /^```json payload=/ { name = substr($0, index($0, "payload=") + 8); inside = 1; next }
    /^```json request=/ { name = "request-" substr($0, index($0, "request=") + 8); inside = 1; next }
    /^```[[:space:]]*$/  { inside = 0; next }
    inside               { print >> (out "/" name ".json") }
' "$DOC"
```
and update the header comment to say it extracts `json request=<name>` blocks too, as `request-<name>.json`. Re-run Step 1's command.

- [ ] **Step 3: Write the failing tests**

`Tests/MusaeumTests/AskContractTests.swift`:

```swift
import XCTest

@testable import Musaeum

/// The ask route's models, decoded from the Mac's own `json payload=` blocks.
/// Nothing here restates a payload: the fixtures are the document.
final class AskContractTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let bundle = Bundle(for: AskContractTests.self)
        guard let url = bundle.url(forResource: name, withExtension: "json") else {
            throw XCTSkip("the contract fixture \(name).json is not in the test bundle — run scripts/vendor-contract-fixtures.sh")
        }
        return try Data(contentsOf: url)
    }

    /// One compact line, as the wire carries it.
    private func compact(_ name: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: fixture(name)))
    }

    private func keyPaths(_ value: Any, prefix: String = "") -> Set<String> {
        guard let object = value as? [String: Any] else { return prefix.isEmpty ? [] : [prefix] }
        return Set(object.flatMap { key, inner in
            keyPaths(inner, prefix: prefix.isEmpty ? key : "\(prefix).\(key)")
        })
    }

    // MARK: health.ai

    func testHealthCarriesTheAIMember() throws {
        let health = try JSONDecoder().decode(Health.self, from: fixture("health"))
        let ai = try XCTUnwrap(health.ai, "the document's health block names an ai member")
        XCTAssertFalse(ai.host.isEmpty)
    }

    /// A Mac older than this feature sends no `ai`; that is "no Ask here", never a decode failure.
    func testAHealthPayloadWithoutAIStillDecodes() throws {
        var object = try JSONSerialization.jsonObject(with: fixture("health")) as! [String: Any]
        object.removeValue(forKey: "ai")
        let health = try JSONDecoder().decode(Health.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(health.ai)
        object["ai"] = NSNull()
        let nulled = try JSONDecoder().decode(Health.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(nulled.ai)
    }

    /// Present means strict again — the exception is for absence only.
    func testAPresentButMalformedAIThrows() throws {
        var object = try JSONSerialization.jsonObject(with: fixture("health")) as! [String: Any]
        object["ai"] = ["available": "yes"]
        XCTAssertThrowsError(try JSONDecoder().decode(Health.self, from: JSONSerialization.data(withJSONObject: object)))
        object["ai"] = ["available": true]  // every other member absent
        XCTAssertThrowsError(try JSONDecoder().decode(Health.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    // MARK: the five events

    func testEveryEventFixtureDecodes() throws {
        XCTAssertNotNil(try AskEvent.decode(name: "disclosure", data: compact("ask-disclosure")))
        XCTAssertEqual(try AskEvent.decode(name: "verdict", data: compact("ask-verdict")), .verdict(.weak))
        XCTAssertNotNil(try AskEvent.decode(name: "delta", data: compact("ask-delta")))
        XCTAssertEqual(try AskEvent.decode(name: "done", data: compact("ask-done")), .done(.stop))
        XCTAssertNotNil(try AskEvent.decode(name: "error", data: compact("ask-error")))
    }

    func testTheDisclosureCarriesWhatTheDocumentNames() throws {
        guard case let .disclosure(disclosure)? = try AskEvent.decode(name: "disclosure", data: compact("ask-disclosure")) else {
            return XCTFail("not a disclosure")
        }
        XCTAssertTrue(disclosure.text.hasPrefix("Sends:"))
        XCTAssertFalse(disclosure.members.isEmpty)
        XCTAssertFalse(disclosure.host.isEmpty)
    }

    func testAnEventNameThisAppDoesNotKnowIsIgnoredNotAnError() throws {
        XCTAssertNil(try AskEvent.decode(name: "citation", data: Data("{\"section\":\"x\"}".utf8)))
    }

    func testAVerdictOrReasonThisAppDoesNotKnowDegradesSafely() throws {
        XCTAssertEqual(try AskEvent.decode(name: "verdict", data: Data("{\"value\":\"maybe\"}".utf8)), .verdict(.unknown))
        XCTAssertEqual(try AskEvent.decode(name: "done", data: Data("{\"reason\":\"filtered\"}".utf8)), .done(.other("filtered")))
    }

    func testAKnownEventMissingItsMemberThrows() {
        XCTAssertThrowsError(try AskEvent.decode(name: "delta", data: Data("{}".utf8)))
        XCTAssertThrowsError(try AskEvent.decode(name: "error", data: Data("{\"text\":\"x\"}".utf8)))
    }

    // MARK: the request

    /// Keys only — the document's example values are not restated here (invariant 1).
    func testTheRequestCarriesExactlyTheMembersTheDocumentNames() throws {
        let request = AskRequest(
            bookId: "b", mode: .ask, rung: .passage,
            section: AskSection(label: "L", text: "T", offset: 1, truncated: false),
            fraction: 0.5, selection: "S", question: "Q"
        )
        let sent = try JSONSerialization.jsonObject(with: request.body())
        let documented = try JSONSerialization.jsonObject(with: fixture("request-ask"))
        XCTAssertEqual(keyPaths(sent), keyPaths(documented))
    }

    func testAbsentMembersAreOmittedNotNull() throws {
        let request = AskRequest(
            bookId: "b", mode: .preview, rung: .pointer,
            section: .empty, fraction: nil, selection: nil, question: nil
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body()) as? [String: Any])
        XCTAssertNil(object["selection"])
        XCTAssertNil(object["question"])
        XCTAssertNil(object["fraction"])
        let section = try XCTUnwrap(object["section"] as? [String: Any])
        XCTAssertNil(section["text"])
        XCTAssertEqual(section["truncated"] as? Bool, false)
    }

    func testTheFractionIsClampedAndTheOffsetNeverNegative() throws {
        let request = AskRequest(
            bookId: "b", mode: .ask, rung: .pointer,
            section: AskSection(label: nil, text: "x", offset: -5, truncated: false),
            fraction: 60, selection: nil, question: "q"
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body()) as? [String: Any])
        XCTAssertEqual(object["fraction"] as? Double, 1)
        XCTAssertEqual((object["section"] as? [String: Any])?["offset"] as? Int, 0)
    }
}
```

Add to `ClientTests.swift`:

```swift
    func testA503AIUnavailableCarriesTheMacsReasonAndIsNotRetryable() throws {
        let http = HTTPURLResponse(url: base, statusCode: 503, httpVersion: nil, headerFields: [:])!
        let body = Data(#"{"error":"ai unavailable","reason":"No model set — add one in Settings."}"#.utf8)
        XCTAssertThrowsError(try MusaeumClient.mapStatus(http, body: body)) { error in
            XCTAssertEqual(error as? ClientError, .aiUnavailable("No model set — add one in Settings."))
            XCTAssertFalse((error as? ClientError)?.isRetryable ?? true)
        }
    }

    func testA503BusyStillMeansBusy() throws {
        let http = HTTPURLResponse(url: base, statusCode: 503, httpVersion: nil, headerFields: ["Retry-After": "1"])!
        XCTAssertThrowsError(try MusaeumClient.mapStatus(http, body: Data(#"{"error":"busy"}"#.utf8))) { error in
            XCTAssertEqual(error as? ClientError, .busy(retryAfter: 1))
        }
    }
```

- [ ] **Step 4: Run to verify they fail**

Run: `xcodegen generate` then the test gate with `-only-testing:MusaeumTests/AskContractTests`.
Expected: build FAILS — `HealthAI`, `AskRequest`, `AskEvent`, `ClientError.aiUnavailable` do not exist.

- [ ] **Step 5: Implement the models**

In `ContractModels.swift`, add to `StrictObject` (beside `objectOrDefault`):

```swift
    /// **The third deliberate exception to the always-present rule (invariant 4).**
    /// `health.ai` is absent from a Mac older than the ask route, and the connect check is the
    /// first thing every launch decodes — a required read would make the whole app refuse an
    /// older Mac over a capability it never offered. Absent and `null` both read as `nil`,
    /// which the Ask sheet reports as "this Mac cannot answer questions"; a *present* member
    /// is still strict.
    func objectIfPresent<T: Decodable>(_ key: String, as: T.Type = T.self) throws -> T? {
        let codingKey = AnyCodingKey(key)
        guard container.contains(codingKey) else { return nil }
        if (try? container.decodeNil(forKey: codingKey)) == true { return nil }
        return try value(key, as: T.self)
    }
```

Replace `Health`:

```swift
struct Health: Decodable, Equatable, Sendable {
    let apiVersion: Int
    let version: String
    let books: Int
    let library: LibraryState
    /// Whether the Mac can relay a question, and to what. `nil` on a Mac that predates the route.
    let ai: HealthAI?

    init(from decoder: any Decoder) throws {
        let o = StrictObject(container: try decoder.container(keyedBy: AnyCodingKey.self), path: "health")
        apiVersion = try o.int("apiVersion")
        version = try o.string("version")
        books = try o.int("books")
        let raw: String = try o.string("library")
        guard let state = LibraryState(rawValue: raw) else {
            throw ContractError.malformedField("library", at: "health", value: raw)
        }
        library = state
        ai = try o.objectIfPresent("ai", as: HealthAI.self)
    }
}

/// `health.ai` — never the key, and no `hasKey`: the phone has no use for either.
struct HealthAI: Decodable, Equatable, Sendable {
    let available: Bool
    /// Why Ask is off, in the Mac's own words. `nil` when it is on.
    let reason: String?
    /// The endpoint is loopback, so nothing sent to it leaves the Mac.
    let isLocal: Bool
    /// `host[:port]` of the Mac's model endpoint.
    let host: String
    let model: String?

    init(available: Bool, reason: String?, isLocal: Bool, host: String, model: String?) {
        self.available = available
        self.reason = reason
        self.isLocal = isLocal
        self.host = host
        self.model = model
    }

    init(from decoder: any Decoder) throws {
        let o = StrictObject(container: try decoder.container(keyedBy: AnyCodingKey.self), path: "health.ai")
        available = try o.bool("available")
        reason = try o.optionalString("reason")
        isLocal = try o.bool("isLocal")
        host = try o.string("host")
        model = try o.optionalString("model")
    }
}

/// 503 `ai unavailable`'s body: the error word and the Mac's own sentence.
struct AIUnavailablePayload: Decodable, Equatable, Sendable {
    let error: String
    let reason: String

    init(from decoder: any Decoder) throws {
        let o = StrictObject(container: try decoder.container(keyedBy: AnyCodingKey.self), path: "ai unavailable")
        error = try o.string("error")
        reason = try o.string("reason")
    }
}
```

Create `Musaeum/Core/API/AskContract.swift`:

```swift
import Foundation

/// The ask route's request and its five events — `POST /api/ai/ask` in the Mac's
/// `docs/rest-api.md`. Every shape here is read from that document's own blocks (the
/// fixtures `scripts/vendor-contract-fixtures.sh` extracts); nothing restates a payload.
///
/// **"Characters" on this route are UTF-16 code units**, the length JavaScript reports and
/// the unit the Mac measures every cap and offset in. `SectionText` is where the phone
/// counts them.

// MARK: - the request

enum AskMode: String, Equatable, Sendable {
    /// Assemble and disclose; the Mac calls no model.
    case preview
    /// Ask the model to place the book; the Mac answers a verdict, never the reply.
    case probe
    case ask
}

enum AskRung: String, Equatable, Sendable {
    case pointer
    case passage
}

struct AskSection: Equatable, Sendable {
    var label: String?
    /// The section **from its start** — never a window. The Mac scores a probe against the
    /// section's opening and windows the passage itself.
    var text: String?
    /// Where the reader is within `text`, in UTF-16 code units.
    var offset: Int?
    var truncated: Bool

    static let empty = AskSection(label: nil, text: nil, offset: nil, truncated: false)
}

struct AskRequest: Equatable, Sendable {
    var bookId: String
    var mode: AskMode
    var rung: AskRung
    var section: AskSection
    var fraction: Double?
    var selection: String?
    var question: String?

    /// The JSON body. Absent members are **omitted**, not `null`: the contract accepts both,
    /// and omission keeps a preview's request honest about what it does not carry.
    func body() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

extension AskRequest: Encodable {
    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)
        try container.encode(bookId, forKey: AnyCodingKey("bookId"))
        try container.encode(mode.rawValue, forKey: AnyCodingKey("mode"))
        try container.encode(rung.rawValue, forKey: AnyCodingKey("rung"))
        try container.encode(section, forKey: AnyCodingKey("section"))
        try container.encodeIfPresent(fraction.map { $0.clampedToUnit() }, forKey: AnyCodingKey("fraction"))
        try container.encodeIfPresent(selection, forKey: AnyCodingKey("selection"))
        try container.encodeIfPresent(question, forKey: AnyCodingKey("question"))
    }
}

extension AskSection: Encodable {
    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)
        try container.encodeIfPresent(label, forKey: AnyCodingKey("label"))
        try container.encodeIfPresent(text, forKey: AnyCodingKey("text"))
        try container.encodeIfPresent(offset.map { max(0, $0) }, forKey: AnyCodingKey("offset"))
        try container.encode(truncated, forKey: AnyCodingKey("truncated"))
    }
}

// MARK: - the events

enum RecallVerdict: Equatable, Sendable {
    case strong
    case weak
    case unknown
}

enum AskDoneReason: Equatable, Sendable {
    case stop
    case length
    case canceled
    case timeout
    /// A reason a newer Mac invented. It ends the stream all the same.
    case other(String)
}

/// What leaves the Mac for the model, and where — the Mac's own sentence, shown verbatim.
struct AskDisclosure: Decodable, Equatable, Sendable {
    let text: String
    let members: [String]
    let rung: AskRung
    let windowed: Bool
    let truncated: [String]
    let host: String
    let isLocal: Bool
    let model: String?

    init(
        text: String, members: [String], rung: AskRung, windowed: Bool, truncated: [String],
        host: String, isLocal: Bool, model: String?
    ) {
        self.text = text
        self.members = members
        self.rung = rung
        self.windowed = windowed
        self.truncated = truncated
        self.host = host
        self.isLocal = isLocal
        self.model = model
    }

    init(from decoder: any Decoder) throws {
        let o = StrictObject(container: try decoder.container(keyedBy: AnyCodingKey.self), path: "ask-disclosure")
        text = try o.string("text")
        members = try o.strings("members")
        let rawRung = try o.string("rung")
        guard let rung = AskRung(rawValue: rawRung) else {
            throw ContractError.malformedField("rung", at: "ask-disclosure", value: rawRung)
        }
        self.rung = rung
        windowed = try o.bool("windowed")
        truncated = try o.strings("truncated")
        let endpoint = try o.object("endpoint", as: Endpoint.self)
        host = endpoint.host
        isLocal = endpoint.isLocal
        model = try o.optionalString("model")
    }

    private struct Endpoint: Decodable {
        let host: String
        let isLocal: Bool

        init(from decoder: any Decoder) throws {
            let o = StrictObject(
                container: try decoder.container(keyedBy: AnyCodingKey.self), path: "ask-disclosure.endpoint")
            host = try o.string("host")
            isLocal = try o.bool("isLocal")
        }
    }
}

enum AskEvent: Equatable, Sendable {
    case disclosure(AskDisclosure)
    case verdict(RecallVerdict)
    case delta(String)
    case done(AskDoneReason)
    case error(String)

    /// One frame, decoded. **`nil` for a name this app does not know** — the contract says
    /// unknown events are ignored by both sides, which is how the route grows without a
    /// version bump. A *known* event whose payload breaks the contract throws.
    static func decode(name: String, data: Data) throws -> AskEvent? {
        let decoder = JSONDecoder()
        switch name {
        case "disclosure":
            return .disclosure(try decoder.decode(AskDisclosure.self, from: data))
        case "verdict":
            return .verdict(try decoder.decode(VerdictBody.self, from: data).verdict)
        case "delta":
            return .delta(try decoder.decode(DeltaBody.self, from: data).text)
        case "done":
            return .done(try decoder.decode(DoneBody.self, from: data).reason)
        case "error":
            return .error(try decoder.decode(ErrorBody.self, from: data).message)
        default:
            return nil
        }
    }

    private struct VerdictBody: Decodable {
        let verdict: RecallVerdict
        init(from decoder: any Decoder) throws {
            let o = StrictObject(container: try decoder.container(keyedBy: AnyCodingKey.self), path: "ask-verdict")
            // A value this app does not know is *unverified* — the safe reading, and the one that
            // widens nothing.
            switch try o.string("value") {
            case "strong": verdict = .strong
            case "weak": verdict = .weak
            default: verdict = .unknown
            }
        }
    }

    private struct DeltaBody: Decodable {
        let text: String
        init(from decoder: any Decoder) throws {
            let o = StrictObject(container: try decoder.container(keyedBy: AnyCodingKey.self), path: "ask-delta")
            text = try o.string("text")
        }
    }

    private struct DoneBody: Decodable {
        let reason: AskDoneReason
        init(from decoder: any Decoder) throws {
            let o = StrictObject(container: try decoder.container(keyedBy: AnyCodingKey.self), path: "ask-done")
            switch try o.string("reason") {
            case "stop": reason = .stop
            case "length": reason = .length
            case "canceled": reason = .canceled
            case "timeout": reason = .timeout
            case let other: reason = .other(other)
            }
        }
    }

    private struct ErrorBody: Decodable {
        let message: String
        init(from decoder: any Decoder) throws {
            let o = StrictObject(container: try decoder.container(keyedBy: AnyCodingKey.self), path: "ask-error")
            message = try o.string("message")
        }
    }
}
```

In `MusaeumClient.swift`, add to `ClientError` (after `cannotReflow`):

```swift
    /// 503 `ai unavailable` — the Mac has no model to relay to. Carries the Mac's own sentence.
    /// **Not retryable:** only the owner at the Mac can fix it, so a retry hears the same refusal.
    case aiUnavailable(String)
```
with `case let .aiUnavailable(reason): "the Mac cannot answer questions — \(reason)"` in `description`, and `.aiUnavailable` added to the non-retryable list in `isRetryable`. In `mapStatus`'s `503` arm, before the `busy` throw:

```swift
            if payload?.error == "ai unavailable" {
                let reason = body.flatMap { try? JSONDecoder().decode(AIUnavailablePayload.self, from: $0) }?.reason
                throw ClientError.aiUnavailable(reason ?? "no model is set on the Mac")
            }
```

- [ ] **Step 6: Run to verify they pass, then the whole suite**

Run: `xcodegen generate`, then `-only-testing:MusaeumTests/AskContractTests` and `-only-testing:MusaeumTests/ClientTests`, then the full test gate.
Expected: PASS; the full suite's count is the baseline plus the new cases, no pre-existing case red (`ContractDecodeTests` decodes the regenerated `health.json`, which now carries `ai`).

- [ ] **Step 7: Commit**

Run the `/verify` skill (code), then:

```bash
git add scripts/vendor-contract-fixtures.sh Musaeum Tests Musaeum.xcodeproj
git commit -m "feat(client): the ask route's models, health.ai, and the 503 ai-unavailable refusal"
```

---

### Task 2: The SSE parser

**Files:**
- Create: `Musaeum/Core/API/SSEParser.swift`
- Test: `Tests/MusaeumTests/SSEParserTests.swift`

**Interfaces:**
- Produces: `struct SSEFrame: Equatable, Sendable { let event: String; let data: String }` and `struct SSEParser: Sendable { init(); mutating func push(_ chunk: String) -> [SSEFrame] }`. Feed it any slice of text — a whole stream, one line, one character — and it returns the frames that slice completed. **A frame only exists once its terminating blank line has arrived**: there is deliberately no flush, so a stream cut mid-event yields nothing for the cut event.

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest

@testable import Musaeum

final class SSEParserTests: XCTestCase {
    func testReturnsNothingUntilAFrameIsComplete() {
        var parser = SSEParser()
        XCTAssertEqual(parser.push("event: delta\n"), [])
        XCTAssertEqual(parser.push("data: {\"text\":\"a\"}\n"), [])
        XCTAssertEqual(parser.push("\n"), [SSEFrame(event: "delta", data: "{\"text\":\"a\"}")])
    }

    func testSeveralFramesInOneChunk() {
        var parser = SSEParser()
        let frames = parser.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n")
        XCTAssertEqual(frames, [SSEFrame(event: "a", data: "1"), SSEFrame(event: "b", data: "2")])
    }

    func testAFrameSplitAtEveryByteBoundaryIsTheSameFrame() {
        let stream = "event: delta\ndata: {\"text\":\"héllo — 🙂\"}\n\n"
        var whole = SSEParser()
        let expected = whole.push(stream)
        XCTAssertEqual(expected.count, 1)

        var parser = SSEParser()
        var collected: [SSEFrame] = []
        for character in stream { collected += parser.push(String(character)) }
        XCTAssertEqual(collected, expected)
    }

    func testCommentLinesAreIgnored() {
        var parser = SSEParser()
        let frames = parser.push(": ping\n\n: ping\nevent: done\ndata: {\"reason\":\"stop\"}\n\n")
        XCTAssertEqual(frames, [SSEFrame(event: "done", data: "{\"reason\":\"stop\"}")])
    }

    func testCRLFIsAccepted() {
        var parser = SSEParser()
        XCTAssertEqual(parser.push("event: x\r\ndata: y\r\n\r\n"), [SSEFrame(event: "x", data: "y")])
    }

    func testMultiLineDataJoinsWithANewline() {
        var parser = SSEParser()
        XCTAssertEqual(parser.push("data: a\ndata: b\n\n"), [SSEFrame(event: "message", data: "a\nb")])
    }

    func testAnEventWithNoDataIsNotAFrame() {
        var parser = SSEParser()
        XCTAssertEqual(parser.push("event: lonely\n\n"), [])
        // …and does not leak its name into the next frame
        XCTAssertEqual(parser.push("data: x\n\n"), [SSEFrame(event: "message", data: "x")])
    }

    /// A stream cut in the middle of an event must not produce that event.
    func testATruncatedFinalEventIsNeverEmitted() {
        var parser = SSEParser()
        XCTAssertEqual(parser.push("event: delta\ndata: {\"text\":\"par"), [])
    }

    func testOnlyOneLeadingSpaceAfterTheColonIsStripped() {
        var parser = SSEParser()
        XCTAssertEqual(parser.push("data:  two spaces\n\n"), [SSEFrame(event: "message", data: " two spaces")])
        XCTAssertEqual(parser.push("data:none\n\n"), [SSEFrame(event: "message", data: "none")])
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `xcodegen generate` + `-only-testing:MusaeumTests/SSEParserTests`
Expected: build FAILS — `SSEParser` does not exist.

- [ ] **Step 3: Implement**

```swift
import Foundation

/// One server-sent event: its name and its `data` lines joined by newlines.
struct SSEFrame: Equatable, Sendable {
    let event: String
    let data: String
}

/// An incremental server-sent-events parser.
///
/// Chunk boundaries are not event boundaries — a read routinely ends mid-line — so this takes
/// whatever text a read happened to contain and returns the frames it completed. It works on
/// **Unicode scalars, not Characters**: Swift treats `"\r\n"` as a single Character, which would
/// make "split on newline" miss every CRLF-terminated line.
///
/// **A frame exists only once its blank line has arrived, and there is no flush.** The Mac always
/// terminates its events, so an event still open when the bytes stop was cut off — possibly in
/// the middle of its JSON — and decoding it as though it were complete is how a half-sentence
/// becomes an answer. `MusaeumClient.ask` treats a stream that ended without a terminal event
/// as the failure it is.
struct SSEParser: Sendable {
    private var line = String.UnicodeScalarView()
    private var event = "message"
    private var dataLines: [String] = []

    init() {}

    mutating func push(_ chunk: String) -> [SSEFrame] {
        var frames: [SSEFrame] = []
        for scalar in chunk.unicodeScalars {
            guard scalar == "\n" else {
                line.append(scalar)
                continue
            }
            if line.last == "\r" { line.removeLast() }
            if let frame = consume(String(line)) { frames.append(frame) }
            line.removeAll()
        }
        return frames
    }

    private mutating func consume(_ text: String) -> SSEFrame? {
        if text.isEmpty { return dispatch() }
        if text.hasPrefix(":") { return nil }  // a comment — the Mac's `: ping` heartbeat

        let name: String
        var value: String
        if let colon = text.firstIndex(of: ":") {
            name = String(text[..<colon])
            value = String(text[text.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            name = text
            value = ""
        }
        switch name {
        case "event": event = value
        case "data": dataLines.append(value)
        default: break  // `id:` and `retry:` mean nothing to this client
        }
        return nil
    }

    private mutating func dispatch() -> SSEFrame? {
        defer {
            event = "message"
            dataLines = []
        }
        guard !dataLines.isEmpty else { return nil }
        return SSEFrame(event: event, data: dataLines.joined(separator: "\n"))
    }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `-only-testing:MusaeumTests/SSEParserTests`
Expected: PASS. (`testAFrameSplitAtEveryByteBoundary…` feeds one Character at a time, including the multi-scalar emoji, which proves scalar-wise handling.)

- [ ] **Step 5: Gates and commit**

Run the full build and test gate.

```bash
git add Musaeum/Core/API/SSEParser.swift Tests/MusaeumTests/SSEParserTests.swift Musaeum.xcodeproj
git commit -m "feat(client): an incremental SSE parser that never emits a cut-off event"
```

---

### Task 3: The streaming client and the `AskBackend` seam

**Files:**
- Modify: `Musaeum/Core/API/MusaeumClient.swift` (`askRequest`, `ask`)
- Create: `Musaeum/Core/API/AskBackend.swift`
- Modify: `Tests/MusaeumTests/StubURLProtocol.swift` (`chunks`)
- Test: `Tests/MusaeumTests/AskClientTests.swift`

**Interfaces:**
- Consumes: `AskRequest`, `AskEvent`, `SSEParser`, `ClientError`, `Health`/`HealthAI` (Tasks 1–2).
- Produces:
  - `MusaeumClient.askRequest(base:token:request:) throws -> URLRequest` (POST `api/ai/ask`, JSON body, `Accept: text/event-stream`, a 45 s idle `timeoutInterval` — three heartbeats).
  - `MusaeumClient.ask(_ request: AskRequest) -> AsyncThrowingStream<AskEvent, Error>` — yields events, finishes after a `done` or `error` event, **throws `ClientError.unreachable` if the bytes end before either**, maps non-2xx through `mapStatus`, stops when the consuming task is cancelled.
  - `struct AskCapability: Equatable, Sendable { var available: Bool; var reason: String?; var isLocal: Bool; var host: String; var model: String? }` with `init(_ wire: HealthAI)` and a memberwise init.
  - `protocol AskBackend: Sendable { func capability() async throws -> AskCapability; func ask(_ request: AskRequest) -> AsyncThrowingStream<AskEvent, Error> }` and `struct RelayBackend: AskBackend { let client: MusaeumClient }`.

- [ ] **Step 1: Let the stub deliver a body in pieces**

In `StubURLProtocol.swift`, add `var chunks: [Data] = []` to `Response`, and replace the body-delivery lines in `startLoading` with:

```swift
            if !response.chunks.isEmpty {
                for chunk in response.chunks { self.client?.urlProtocol(self, didLoad: chunk) }
            } else if !response.body.isEmpty {
                self.client?.urlProtocol(self, didLoad: response.body)
            }
```

- [ ] **Step 2: Write the failing tests**

```swift
import XCTest

@testable import Musaeum

final class AskClientTests: XCTestCase {
    private let base = URL(string: "http://100.64.0.1:8788")!

    private func fixture(_ name: String) throws -> Data {
        let bundle = Bundle(for: AskClientTests.self)
        guard let url = bundle.url(forResource: name, withExtension: "json") else {
            throw XCTSkip("the contract fixture \(name).json is not in the test bundle — run scripts/vendor-contract-fixtures.sh")
        }
        return try Data(contentsOf: url)
    }

    /// A frame as the Mac writes it, built from the document's own payload block.
    private func frame(_ event: String, _ name: String) throws -> String {
        let line = try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: fixture(name)))
        return "event: \(event)\ndata: \(String(decoding: line, as: UTF8.self))\n\n"
    }

    private func client(_ handler: @escaping (URLRequest) -> StubURLProtocol.Response) -> MusaeumClient {
        StubURLProtocol.configure(handler)
        return MusaeumClient(base: base, token: "test-token", session: StubURLProtocol.session())
    }

    private let request = AskRequest(
        bookId: "b1", mode: .ask, rung: .pointer,
        section: AskSection(label: "Chapter 4", text: nil, offset: nil, truncated: false),
        fraction: 0.42, selection: nil, question: "What is this about?"
    )

    private func collect(_ stream: AsyncThrowingStream<AskEvent, Error>) async throws -> [AskEvent] {
        var events: [AskEvent] = []
        for try await event in stream { events.append(event) }
        return events
    }

    // MARK: the request

    func testTheRequestIsAPostWithTheBearerAndAJSONBodyAndNothingElseSecret() throws {
        let urlRequest = try MusaeumClient.askRequest(base: base, token: "test-token", request: request)
        XCTAssertEqual(urlRequest.httpMethod, "POST")
        XCTAssertEqual(urlRequest.url?.path, "/api/ai/ask")
        XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(urlRequest.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(urlRequest.timeoutInterval, 45)
        let body = String(decoding: try XCTUnwrap(urlRequest.httpBody), as: UTF8.self)
        XCTAssertFalse(body.contains("test-token"), "the token lives in the header and nowhere else (invariant 10)")
    }

    // MARK: the stream

    func testAStreamIsDecodedInOrderAndEndsAtDone() async throws {
        let text = try frame("disclosure", "ask-disclosure") + frame("delta", "ask-delta")
            + frame("delta", "ask-delta") + frame("done", "ask-done")
        let client = client { _ in
            StubURLProtocol.Response(status: 200, headers: ["Content-Type": "text/event-stream"], body: Data(text.utf8))
        }
        let events = try await collect(client.ask(request))

        XCTAssertEqual(events.count, 4)
        guard case .disclosure = events[0], case .delta = events[1], case .delta = events[2] else {
            return XCTFail("order lost: \(events)")
        }
        XCTAssertEqual(events[3], .done(.stop))
    }

    func testEventsArrivingInPiecesStillDecode() async throws {
        let text = try frame("delta", "ask-delta") + frame("done", "ask-done")
        let bytes = Array(text.utf8)
        // Cut into 7-byte reads — some will end inside a frame, some inside a multi-byte character
        let chunks = stride(from: 0, to: bytes.count, by: 7).map { Data(bytes[$0 ..< min($0 + 7, bytes.count)]) }
        let client = client { _ in StubURLProtocol.Response(status: 200, chunks: chunks) }

        let events = try await collect(client.ask(request))
        XCTAssertEqual(events.count, 2)
    }

    func testAHeartbeatAndAnUnknownEventAreIgnored() async throws {
        let text = ": ping\n\nevent: citation\ndata: {\"section\":\"x\"}\n\n" + (try frame("done", "ask-done"))
        let client = client { _ in StubURLProtocol.Response(status: 200, body: Data(text.utf8)) }
        XCTAssertEqual(try await collect(client.ask(request)), [.done(.stop)])
    }

    func testAnErrorEventEndsTheStreamAsAnOutcomeNotAThrow() async throws {
        let text = try frame("disclosure", "ask-disclosure") + frame("error", "ask-error")
        let client = client { _ in StubURLProtocol.Response(status: 200, body: Data(text.utf8)) }
        let events = try await collect(client.ask(request))
        guard case .error? = events.last else { return XCTFail("expected a trailing error event: \(events)") }
    }

    /// **The Review Focus case.** The Mac quit, the tailnet dropped, or the app was
    /// backgrounded mid-answer: the bytes just stop. That is a failure, and reporting it as
    /// a finished answer would present half a sentence as the whole of one.
    func testAStreamThatEndsWithoutATerminalEventThrows() async throws {
        let text = try frame("delta", "ask-delta")
        let client = client { _ in StubURLProtocol.Response(status: 200, body: Data(text.utf8)) }
        do {
            _ = try await collect(client.ask(request))
            XCTFail("a truncated stream finished cleanly")
        } catch let error as ClientError {
            guard case .unreachable = error else { return XCTFail("wrong error: \(error)") }
        }
    }

    func testAStreamCutMidEventDoesNotDecodeTheCutEvent() async throws {
        let whole = try frame("delta", "ask-delta")
        let cut = String(whole.dropLast(8))  // inside the JSON, before the blank line
        let client = client { _ in StubURLProtocol.Response(status: 200, body: Data(cut.utf8)) }
        do {
            _ = try await collect(client.ask(request))
            XCTFail("a cut stream finished cleanly")
        } catch let error as ClientError {
            guard case .unreachable = error else { return XCTFail("wrong error: \(error)") }
        }
    }

    func testAKnownEventWithABrokenPayloadThrowsADecodingError() async throws {
        let text = "event: delta\ndata: {\"nope\":1}\n\n"
        let client = client { _ in StubURLProtocol.Response(status: 200, body: Data(text.utf8)) }
        do {
            _ = try await collect(client.ask(request))
            XCTFail("a broken payload was accepted")
        } catch let error as ClientError {
            guard case .decoding = error else { return XCTFail("wrong error: \(error)") }
        }
    }

    // MARK: the refusals before the stream

    func testEachRefusalIsItsOwnState() async throws {
        let cases: [(Int, [String: String], String, ClientError)] = [
            (401, [:], #"{"error":"unauthorized"}"#, .unauthorized),
            (404, [:], #"{"error":"not found"}"#, .notFound),
            (400, [:], #"{"error":"bad request"}"#, .badRequest("bad request")),
            (503, ["Retry-After": "1"], #"{"error":"busy"}"#, .busy(retryAfter: 1)),
            (503, [:], #"{"error":"ai unavailable","reason":"No model set"}"#, .aiUnavailable("No model set")),
        ]
        for (status, headers, body, expected) in cases {
            let client = client { _ in StubURLProtocol.Response(status: status, headers: headers, body: Data(body.utf8)) }
            do {
                _ = try await collect(client.ask(request))
                XCTFail("\(status) was accepted")
            } catch let error as ClientError {
                XCTAssertEqual(error, expected, "status \(status)")
            }
        }
    }

    func testAnUnreachableMacIsAnOrdinaryState() async throws {
        // Port 1 on loopback refuses at once — a real connection, not the stub
        let client = MusaeumClient(base: URL(string: "http://127.0.0.1:1")!, token: "t")
        do {
            _ = try await collect(client.ask(request))
            XCTFail("an unreachable Mac produced events")
        } catch let error as ClientError {
            guard case .unreachable = error else { return XCTFail("wrong error: \(error)") }
        }
    }

    // MARK: the seam

    func testTheRelayReportsAnOlderMacAsUnavailableWithASentence() async throws {
        var object = try JSONSerialization.jsonObject(with: fixture("health")) as! [String: Any]
        object.removeValue(forKey: "ai")
        let body = try JSONSerialization.data(withJSONObject: object)
        let backend = RelayBackend(client: client { _ in StubURLProtocol.Response(status: 200, body: body) })

        let capability = try await backend.capability()
        XCTAssertFalse(capability.available)
        XCTAssertNotNil(capability.reason)
    }

    func testTheRelayPassesAMacsCapabilityThrough() async throws {
        let body = try fixture("health")
        let backend = RelayBackend(client: client { _ in StubURLProtocol.Response(status: 200, body: body) })

        let capability = try await backend.capability()
        let wire = try XCTUnwrap(JSONDecoder().decode(Health.self, from: body).ai)
        XCTAssertEqual(capability, AskCapability(wire))
    }
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `xcodegen generate` + `-only-testing:MusaeumTests/AskClientTests`
Expected: build FAILS — `askRequest`, `ask`, `AskBackend`, `AskCapability`, `RelayBackend` do not exist.

- [ ] **Step 4: Implement**

Add to `MusaeumClient` (beside `uploadRequest`):

```swift
    // MARK: Ask

    /// How long a stream may be silent before `URLSession` gives up on it. The Mac writes a
    /// `: ping` comment every 15 s while a model thinks, so three of them missed is a dead
    /// connection, not a slow model.
    static let askIdleTimeout: TimeInterval = 45

    /// The ask route's request, composed where a case can read it.
    static func askRequest(base: URL, token: String, request: AskRequest) throws -> URLRequest {
        var urlRequest = Self.request(
            base: base, token: token, path: "api/ai/ask", method: "POST", body: try request.body())
        urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        urlRequest.timeoutInterval = askIdleTimeout
        return urlRequest
    }

    /// `POST /api/ai/ask`, as a stream of events.
    ///
    /// **The stream finishes only after a terminal event.** A `done` or an `error` event is the
    /// Mac saying it is finished; bytes that simply stop are the Mac quitting, the tailnet
    /// dropping or the app being backgrounded, and report as `unreachable`. Cancelling the task
    /// that consumes the stream closes the connection, which the Mac reads as the reader leaving.
    ///
    /// The bytes are framed one **line** at a time rather than through `AsyncBytes.lines`, which
    /// drops blank lines — and a blank line is what ends an event.
    func ask(_ request: AskRequest) -> AsyncThrowingStream<AskEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let urlRequest = try Self.askRequest(base: base, token: token, request: request)
                    let (bytes, response) = try await session.bytes(for: urlRequest)
                    guard let http = response as? HTTPURLResponse else {
                        throw ClientError.unreachable("no HTTP response")
                    }
                    if !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await byte in bytes {
                            body.append(byte)
                            if body.count >= 4096 { break }
                        }
                        try Self.mapStatus(http, body: body)
                        throw ClientError.server
                    }

                    var parser = SSEParser()
                    var line = Data()
                    var terminal = false
                    for try await byte in bytes {
                        line.append(byte)
                        guard byte == 0x0A else { continue }
                        let text = String(decoding: line, as: UTF8.self)
                        line.removeAll(keepingCapacity: true)
                        for frame in parser.push(text) {
                            guard let event = try AskEvent.decode(name: frame.event, data: Data(frame.data.utf8))
                            else { continue }
                            continuation.yield(event)
                            switch event {
                            case .done, .error: terminal = true
                            default: break
                            }
                        }
                    }
                    guard terminal else {
                        throw ClientError.unreachable("the answer stopped arriving before the Mac finished it")
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: CancellationError())
                } catch let error as ClientError {
                    continuation.finish(throwing: error)
                } catch let error as ContractError {
                    continuation.finish(throwing: ClientError.decoding(error))
                } catch let error as DecodingError {
                    continuation.finish(throwing: ClientError.decoding(Self.contractError(from: error)))
                } catch {
                    continuation.finish(throwing: ClientError.unreachable((error as NSError).localizedDescription))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
```

`Musaeum/Core/API/AskBackend.swift`:

```swift
import Foundation

/// What the UI needs to know before it offers Ask: whether it works, why not, and where a
/// question would go. The wire's `health.ai` is one source of it; a future backend that talks
/// to a model directly would be another, which is why the UI reads *this* and not the wire type.
struct AskCapability: Equatable, Sendable {
    var available: Bool
    /// Why Ask is off, in words a reader can act on. `nil` when it is on.
    var reason: String?
    /// Nothing sent leaves the Mac (or, for a direct backend, the device).
    var isLocal: Bool
    var host: String
    var model: String?

    init(available: Bool, reason: String?, isLocal: Bool, host: String, model: String?) {
        self.available = available
        self.reason = reason
        self.isLocal = isLocal
        self.host = host
        self.model = model
    }

    init(_ wire: HealthAI) {
        self.init(
            available: wire.available, reason: wire.reason, isLocal: wire.isLocal,
            host: wire.host, model: wire.model)
    }
}

/// The seam between the reader's Ask sheet and wherever answers come from (design D1).
///
/// The sheet consumes `AskEvent`s and nothing else, so it does not know that the tokens came from
/// the Mac. `RelayBackend` is the only implementation: a `DirectBackend` — the phone calling an
/// OpenAI-compatible endpoint itself — would have to assemble prompts on the phone, which means a
/// Swift port of the Mac's `shared/ask` modules against shared golden fixtures. That is deliberately
/// not built; this protocol is what keeps it possible without the UI moving.
protocol AskBackend: Sendable {
    func capability() async throws -> AskCapability
    func ask(_ request: AskRequest) -> AsyncThrowingStream<AskEvent, Error>
}

/// Ask through the Mac: `GET /api/health` for the capability, `POST /api/ai/ask` for the answer.
struct RelayBackend: AskBackend {
    let client: MusaeumClient

    func capability() async throws -> AskCapability {
        let health = try await client.health()
        guard let ai = health.ai else {
            return AskCapability(
                available: false,
                reason: "This Mac's Musaeum is too old to answer questions — update it.",
                isLocal: true, host: "", model: nil)
        }
        return AskCapability(ai)
    }

    func ask(_ request: AskRequest) -> AsyncThrowingStream<AskEvent, Error> {
        client.ask(request)
    }
}
```

- [ ] **Step 5: Run to verify they pass, then the full suite**

Run: `xcodegen generate`, `-only-testing:MusaeumTests/AskClientTests`, then the full test gate.
Expected: PASS. If `testEventsArrivingInPiecesStillDecode` is flaky, the stub's chunk delivery is the suspect — report how many `didLoad` calls reached the client rather than loosening the assertion.

- [ ] **Step 6: Commit**

Run `/verify`, then:

```bash
git add Musaeum Tests Musaeum.xcodeproj
git commit -m "feat(client): stream POST /api/ai/ask, and put it behind an AskBackend"
```

---

# Slice 4 — the panel

### Task 4: `SectionText` and `AskCitations` — the two pure pieces

**Files:**
- Create: `Musaeum/Core/Reader/SectionText.swift`, `Musaeum/Core/Reader/AskCitations.swift`
- Test: `Tests/MusaeumTests/SectionTextTests.swift`, `Tests/MusaeumTests/AskCitationsTests.swift`

**Interfaces:**
- Produces:
  - `struct SectionText: Equatable, Sendable { let text: String?; let offset: Int?; let truncated: Bool; static let cap = 200_000; struct Piece: Equatable, Sendable { let text: String; let progression: Double? }; static func make(pieces: [Piece], readerProgression: Double?, highlight: String?) -> SectionText }`
  - `enum AskCitations { static func entries(in answer: String, toc: [ReaderTocEntry], limit: Int = 3) -> [ReaderTocEntry] }`

**Rules `SectionText.make` follows** (each is a test below):
1. Pieces with empty text are dropped; the rest are joined with `"\n"`. Nothing left → `text == nil`, `offset == nil`.
2. **The offset is in UTF-16 code units.** The highlight wins when it is found in the joined text (it is an exact anchor, and on the Mac the highlight is also the fallback anchor); otherwise the start of the first piece whose `progression` is at or past `readerProgression`; otherwise `nil`.
3. A text longer than `cap` UTF-16 units is cut **at a scalar boundary** so its UTF-16 length is at most `cap`; `truncated` is true; an offset at or past the cut becomes `nil` rather than pointing at text that was not sent.

- [ ] **Step 1: Write the failing tests**

`SectionTextTests.swift`:

```swift
import XCTest

@testable import Musaeum

final class SectionTextTests: XCTestCase {
    private func piece(_ text: String, _ progression: Double? = nil) -> SectionText.Piece {
        SectionText.Piece(text: text, progression: progression)
    }

    func testPiecesAreJoinedWithANewlineAndEmptyOnesDropped() {
        let section = SectionText.make(
            pieces: [piece("One."), piece(""), piece("Two.")], readerProgression: nil, highlight: nil)
        XCTAssertEqual(section.text, "One.\nTwo.")
        XCTAssertFalse(section.truncated)
    }

    func testNothingToExtractIsNilNotAnEmptyString() {
        let section = SectionText.make(pieces: [piece(""), piece("")], readerProgression: 0.5, highlight: "x")
        XCTAssertNil(section.text)
        XCTAssertNil(section.offset)
        XCTAssertEqual(SectionText.make(pieces: [], readerProgression: nil, highlight: nil).text, nil)
    }

    func testTheHighlightIsTheAnchorWhenItIsFound() {
        let section = SectionText.make(
            pieces: [piece("Alpha.", 0), piece("Beta gamma.", 0.5), piece("Delta.", 0.9)],
            readerProgression: 0.9, highlight: "gamma")
        XCTAssertEqual(section.offset, "Alpha.\nBeta ".utf16.count)
    }

    func testTheProgressionPicksThePieceWhenThereIsNoHighlight() {
        let section = SectionText.make(
            pieces: [piece("Alpha.", 0), piece("Beta.", 0.5), piece("Delta.", 0.9)],
            readerProgression: 0.5, highlight: nil)
        XCTAssertEqual(section.offset, "Alpha.\n".utf16.count)
    }

    /// Readium's text and the page can differ in whitespace; a highlight that cannot be found
    /// must fall back to the progression, not lose the offset or crash.
    func testAHighlightThatIsNotInTheTextFallsBackToProgression() {
        let section = SectionText.make(
            pieces: [piece("Alpha.", 0), piece("Beta.", 0.5)], readerProgression: 0.5,
            highlight: "words that are not here")
        XCTAssertEqual(section.offset, "Alpha.\n".utf16.count)
    }

    func testNoHighlightAndNoProgressionIsNoOffset() {
        let section = SectionText.make(pieces: [piece("Alpha.", 0)], readerProgression: nil, highlight: nil)
        XCTAssertNil(section.offset)
    }

    func testPiecesWithoutProgressionNeverAnchor() {
        let section = SectionText.make(
            pieces: [piece("Alpha."), piece("Beta.")], readerProgression: 0.5, highlight: nil)
        XCTAssertNil(section.offset)
    }

    // MARK: the cap, in UTF-16 units

    func testATextAtTheCapIsNotTruncatedAndOneUnitPastItIs() {
        let at = String(repeating: "a", count: SectionText.cap)
        let atSection = SectionText.make(pieces: [piece(at)], readerProgression: nil, highlight: nil)
        XCTAssertEqual(atSection.text?.utf16.count, SectionText.cap)
        XCTAssertFalse(atSection.truncated)

        let past = SectionText.make(pieces: [piece(at + "a")], readerProgression: nil, highlight: nil)
        XCTAssertEqual(past.text?.utf16.count, SectionText.cap)
        XCTAssertTrue(past.truncated)
    }

    /// An emoji is two UTF-16 units. Cutting between them would produce a lone surrogate, and
    /// counting Characters would let a text past the Mac's cap through.
    func testNeverSplitsASurrogatePairAndCountsInUTF16() {
        let body = String(repeating: "a", count: SectionText.cap - 1)
        let section = SectionText.make(pieces: [piece(body + "🙂🙂")], readerProgression: nil, highlight: nil)

        XCTAssertTrue(section.truncated)
        let text = section.text ?? ""
        XCTAssertLessThanOrEqual(text.utf16.count, SectionText.cap)
        XCTAssertEqual(text, body, "the emoji did not fit whole, so neither half is sent")
        XCTAssertNotNil(String(text).data(using: .utf8), "the cut text is valid Unicode")
    }

    func testAnEmojiHeavyTextIsCountedInUnitsNotCharacters() {
        // 120,000 emoji is 120,000 Characters but 240,000 UTF-16 units — past the cap
        let section = SectionText.make(
            pieces: [piece(String(repeating: "🙂", count: 120_000))], readerProgression: nil, highlight: nil)
        XCTAssertTrue(section.truncated)
        XCTAssertLessThanOrEqual(section.text?.utf16.count ?? .max, SectionText.cap)
    }

    func testAnOffsetPastTheCutBecomesNilBecauseThatTextWasNotSent() {
        let filler = String(repeating: "a", count: SectionText.cap)
        let section = SectionText.make(
            pieces: [piece(filler), piece("target text here", 0.9)], readerProgression: 0.9, highlight: "target")
        XCTAssertTrue(section.truncated)
        XCTAssertNil(section.offset)
    }

    func testAnOffsetInsideTheKeptTextSurvivesTruncation() {
        let filler = String(repeating: "a", count: SectionText.cap)
        let section = SectionText.make(
            pieces: [piece("target text", 0), piece(filler)], readerProgression: nil, highlight: "target")
        XCTAssertTrue(section.truncated)
        XCTAssertEqual(section.offset, 0)
    }

    func testTheOffsetIsInUTF16UnitsAfterAnEmoji() {
        let section = SectionText.make(
            pieces: [piece("🙂 hello world")], readerProgression: nil, highlight: "world")
        XCTAssertEqual(section.offset, "🙂 hello ".utf16.count)
    }
}
```

`AskCitationsTests.swift` (constructing `ReaderTocEntry` needs a Readium `Link`; the type's `init` is memberwise and internal — `import ReadiumShared` for `Link(href:)`):

```swift
import ReadiumShared
import XCTest

@testable import Musaeum

final class AskCitationsTests: XCTestCase {
    private func entry(_ id: Int, _ title: String) -> ReaderTocEntry {
        ReaderTocEntry(id: id, title: title, depth: 0, link: Link(href: "ch\(id).xhtml"))
    }

    private lazy var toc = [
        entry(0, "Introduction"), entry(1, "The Ledger of Small Debts"), entry(2, "Untitled"), entry(3, "Ch"),
    ]

    func testAnAnswerThatNamesASectionOffersItCaseInsensitively() {
        let found = AskCitations.entries(in: "See “the ledger of small debts” for the origin.", toc: toc)
        XCTAssertEqual(found.map(\.id), [1])
    }

    func testAnAnswerThatNamesNoSectionOffersNothing() {
        XCTAssertEqual(AskCitations.entries(in: "It is about frugality.", toc: toc), [])
    }

    func testUntitledAndVeryShortTitlesNeverMatch() {
        XCTAssertEqual(AskCitations.entries(in: "untitled ch ch ch", toc: toc), [])
    }

    func testDiacriticsAndRepeatedTitlesAreNormalised() {
        let toc = [entry(0, "Café Society"), entry(1, "Café Society")]
        XCTAssertEqual(AskCitations.entries(in: "As in cafe society, the point is…", toc: toc).map(\.id), [0])
    }

    func testTheListIsCapped() {
        let toc = (0..<6).map { entry($0, "Chapter number \($0)") }
        let answer = (0..<6).map { "Chapter number \($0)" }.joined(separator: ", ")
        XCTAssertEqual(AskCitations.entries(in: answer, toc: toc, limit: 3).count, 3)
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `xcodegen generate` + `-only-testing:MusaeumTests/SectionTextTests -only-testing:MusaeumTests/AskCitationsTests`
Expected: build FAILS — the types do not exist.

- [ ] **Step 3: Implement**

`SectionText.swift`:

```swift
import Foundation

/// The current section's text, shaped for `POST /api/ai/ask` (design D3, D6).
///
/// **Pure, and Readium-free on purpose**: the extraction (`ReaderModel+Ask`) hands this a list of
/// pieces, and everything the contract constrains — the join, the cap, the unit, the offset — is
/// decided here where a test can reach it without an EPUB.
///
/// Two rules from the Mac's contract shape it:
/// - **The text is a prefix of the section**, never a window. The Mac scores a probe against the
///   section's opening and cuts the passage window itself, so this cuts only at the *end*.
/// - **Characters are UTF-16 code units** — what JavaScript's `.length` reports and what the Mac
///   measures every cap and offset in. `String.count` counts grapheme clusters and would let an
///   emoji-heavy section sail past a cap the Mac then refuses with a 400.
struct SectionText: Equatable, Sendable {
    /// The most the Mac will accept (`ASK_SECTION_TEXT_MAX_CHARS`), in UTF-16 units.
    static let cap = 200_000

    /// One block of the section's text, with where Readium says it sits in the resource (0…1).
    struct Piece: Equatable, Sendable {
        let text: String
        let progression: Double?
    }

    /// `nil` when the section yielded no text at all — an image-only page, a failed extraction.
    let text: String?
    /// Where the reader is, in UTF-16 units into `text`. `nil` when unknown, or when it falls past the cut.
    let offset: Int?
    let truncated: Bool

    static func make(pieces: [Piece], readerProgression: Double?, highlight: String?) -> SectionText {
        let kept = pieces.filter { !$0.text.isEmpty }
        guard !kept.isEmpty else { return SectionText(text: nil, offset: nil, truncated: false) }

        // The start of each piece in the joined text, in UTF-16 units.
        var starts: [Int] = []
        var joined = ""
        var units = 0
        for (index, piece) in kept.enumerated() {
            if index > 0 {
                joined += "\n"
                units += 1
            }
            starts.append(units)
            joined += piece.text
            units += piece.text.utf16.count
        }

        var offset: Int?
        if let highlight = highlight?.trimmingCharacters(in: .whitespacesAndNewlines), !highlight.isEmpty,
            let range = joined.range(of: highlight)
        {
            // The highlight is an exact anchor — and the Mac's own fallback anchor.
            offset = joined.utf16.distance(from: joined.utf16.startIndex, to: range.lowerBound)
        } else if let progression = readerProgression {
            offset = kept.indices.first { (kept[$0].progression ?? -1) >= progression }.map { starts[$0] }
        }

        guard units > cap else { return SectionText(text: joined, offset: offset, truncated: false) }

        // Cut at the largest scalar boundary whose UTF-16 length is within the cap.
        var count = 0
        var cut = joined.unicodeScalars.startIndex
        for index in joined.unicodeScalars.indices {
            let width = joined.unicodeScalars[index].utf16.count
            if count + width > cap { break }
            count += width
            cut = joined.unicodeScalars.index(after: index)
        }
        let text = String(joined.unicodeScalars[..<cut])
        return SectionText(
            text: text, offset: offset.flatMap { $0 < count ? $0 : nil }, truncated: true)
    }
}
```

`AskCitations.swift`:

```swift
import Foundation

/// Which entries of the book's contents an answer names (design D7).
///
/// The only jump the panel offers is to a **section label that is in the table of contents the
/// reader already holds** — never a position the model invented. A match is a lookup and a miss
/// is visibly a miss. Known limit: a short, common title ("Notes") can match ordinary prose; the
/// jump is a convenience, a wrong offer costs one tap, and four characters is the floor.
enum AskCitations {
    static func entries(in answer: String, toc: [ReaderTocEntry], limit: Int = 3) -> [ReaderTocEntry] {
        let haystack = normalized(answer)
        var seen = Set<String>()
        var found: [ReaderTocEntry] = []
        for entry in toc {
            let title = normalized(entry.title)
            guard title.count >= 4, title != "untitled", haystack.contains(title),
                seen.insert(title).inserted
            else { continue }
            found.append(entry)
            if found.count == limit { break }
        }
        return found
    }

    private static func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: the two `-only-testing` classes.
Expected: PASS. If `testNeverSplitsASurrogatePair…` fails on `text == body`, the cut loop is admitting half a pair — each scalar's `utf16.count` is 1 or 2 and a scalar is never split, so check the `count + width > cap` comparison before touching anything else.

- [ ] **Step 5: Gates and commit**

Full build and test gate.

```bash
git add Musaeum/Core/Reader Tests/MusaeumTests Musaeum.xcodeproj
git commit -m "feat(reader): SectionText and AskCitations — the pure pieces of the Ask panel"
```

---

### Task 5: `AskSession` — the phone's session state

**Files:**
- Create: `Musaeum/Core/Reader/AskSession.swift`
- Test: `Tests/MusaeumTests/AskSessionTests.swift`

**Interfaces:**
- Consumes: `AskBackend`, `AskCapability`, `AskRequest`, `AskSection`, `AskEvent`, `AskDisclosure`, `RecallVerdict`, `AskRung`, `ClientError` (Tasks 1–3); `SectionText` (Task 4).
- Produces:
  - `struct AskReaderContext: Equatable, Sendable { var label: String?; var fraction: Double?; var selection: String?; var section: SectionText }`
  - `@MainActor protocol AskContextProviding: AnyObject { func askContext() async -> AskReaderContext? }`
  - `@MainActor @Observable final class AskSession` with: `init(bookId: String, backend: (any AskBackend)?, context: any AskContextProviding)`; `private(set) var availability: AskSession.Availability` (`.checking`, `.unavailable(String)`, `.ready(AskCapability)`); `private(set) var verdict: RecallVerdict?`; `private(set) var probing: Bool`; `private(set) var turns: [AskSession.Turn]` (`id`, `role: .reader | .model`, `text`, `streaming`); `private(set) var disclosure: AskDisclosure?`; `private(set) var failure: String?`; `private(set) var passageOverride: Bool`; `var rung: AskRung` (computed); `var isAnswering: Bool`; `func open() async`; `func refreshPreview() async`; `func setPassageOverride(_ on: Bool) async`; `func send(_ question: String) async`; `func ask(_ question: String)` (spawns and remembers the task); `func cancel()`; `static let previewPlaceholder = "your question"`.

**Rules this type keeps** (each is a test):
1. `open()` checks capability; if the Mac is unavailable, no probe and no preview go out.
2. **One probe per (book, session):** the second `open()` does not probe again.
3. **A probe sends the section text; an ask sends it only at the passage rung.** A probe is pointer-only: no selection, no question.
4. `weak` ⇒ rung `.passage` whatever the override says (the override cannot lower it); `strong`/`unknown`/`nil` ⇒ `.pointer` unless the override is on.
5. A probe that errors (an `error` event, a thrown error) leaves the verdict `unknown` and the sheet usable; `aiUnavailable` is the one error that makes the whole thing unavailable.
6. A preview request carries `previewPlaceholder` as its question and `mode == .preview`.
7. An answer streams into one model turn; a failure before the first token drops the empty turn and sets `failure`; a cancelled answer keeps its partial text and stops streaming.
8. A new `ask` cancels the one in flight.

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest

@testable import Musaeum

/// A free function, not a method: the fake backend's script is `@Sendable`, and a `@MainActor`
/// test method cannot be called from it.
private func makeDisclosure(_ text: String = "Sends: title, author") -> AskDisclosure {
    AskDisclosure(
        text: text, members: ["title"], rung: .pointer, windowed: false, truncated: [],
        host: "localhost:11434", isLocal: true, model: "m")
}

@MainActor
final class AskSessionTests: XCTestCase {
    // MARK: doubles

    /// A backend that records what it was asked and answers from a script.
    final class FakeBackend: AskBackend, @unchecked Sendable {
        private let lock = NSLock()
        private var _requests: [AskRequest] = []
        var capabilityResult: Result<AskCapability, Error> = .success(
            AskCapability(available: true, reason: nil, isLocal: true, host: "localhost:11434", model: "m"))
        var script: @Sendable (AskRequest) -> [AskEvent] = { _ in [.done(.stop)] }
        var thrown: Error?
        /// When set, an `ask` stream yields its script and then never finishes.
        var hangs = false

        var requests: [AskRequest] { lock.lock(); defer { lock.unlock() }; return _requests }
        func requests(_ mode: AskMode) -> [AskRequest] { requests.filter { $0.mode == mode } }

        func capability() async throws -> AskCapability { try capabilityResult.get() }

        func ask(_ request: AskRequest) -> AsyncThrowingStream<AskEvent, Error> {
            lock.lock()
            _requests.append(request)
            lock.unlock()
            let events = script(request)
            let thrown = thrown
            // Only the answer hangs: a probe or a preview that never finished would stall `open()`
            let hangs = hangs && request.mode == .ask
            return AsyncThrowingStream { continuation in
                for event in events { continuation.yield(event) }
                if let thrown { continuation.finish(throwing: thrown) } else if !hangs { continuation.finish() }
            }
        }
    }

    final class FakeContext: AskContextProviding {
        var context: AskReaderContext? = AskReaderContext(
            label: "Chapter 4", fraction: 0.4, selection: nil,
            section: SectionText(text: "It was the best of times.", offset: 3, truncated: false))
        func askContext() async -> AskReaderContext? { context }
    }

    private func make(
        _ backend: FakeBackend = FakeBackend(), context: FakeContext = FakeContext()
    ) -> (AskSession, FakeBackend, FakeContext) {
        (AskSession(bookId: "b1", backend: backend, context: context), backend, context)
    }

    private func waitUntil(_ what: String, timeout: Duration = .seconds(2), _ condition: () -> Bool) async {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !condition(), ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), "timed out waiting for \(what)")
    }

    // MARK: availability

    func testAnUnavailableMacSendsNothing() async {
        let (session, backend, _) = make()
        backend.capabilityResult = .success(
            AskCapability(available: false, reason: "No model set", isLocal: true, host: "h", model: nil))
        await session.open()
        XCTAssertEqual(session.availability, .unavailable("No model set"))
        XCTAssertTrue(backend.requests.isEmpty, "no probe, no preview")
    }

    func testAnUnreachableMacIsAnOrdinaryUnavailableState() async {
        let (session, backend, _) = make()
        backend.capabilityResult = .failure(ClientError.unreachable("timed out"))
        await session.open()
        guard case let .unavailable(reason) = session.availability else { return XCTFail("not unavailable") }
        XCTAssertTrue(reason.contains("not answering"))
    }

    func testNoBackendMeansNotConnected() async {
        let session = AskSession(bookId: "b", backend: nil, context: FakeContext())
        await session.open()
        guard case .unavailable = session.availability else { return XCTFail("not unavailable") }
    }

    // MARK: the probe

    func testOpeningProbesOnceAndSendsTheSectionTextButNothingElse() async {
        let (session, backend, _) = make()
        backend.script = { request in
            request.mode == .probe ? [.disclosure(makeDisclosure()), .verdict(.strong), .done(.stop)] : [.done(.stop)]
        }
        await session.open()

        let probes = backend.requests(.probe)
        XCTAssertEqual(probes.count, 1)
        XCTAssertEqual(probes[0].rung, .pointer)
        XCTAssertEqual(probes[0].section.text, "It was the best of times.")
        XCTAssertNil(probes[0].question)
        XCTAssertNil(probes[0].selection, "a probe is pointer-only: the highlight is the referent of a question")
        XCTAssertEqual(session.verdict, .strong)
    }

    func testASecondOpenDoesNotProbeAgain() async {
        let (session, backend, _) = make()
        backend.script = { $0.mode == .probe ? [.verdict(.strong), .done(.stop)] : [.done(.stop)] }
        await session.open()
        await session.open()
        XCTAssertEqual(backend.requests(.probe).count, 1)
    }

    func testAProbeErrorLeavesTheVerdictUnknownAndTheSheetUsable() async {
        let (session, backend, _) = make()
        backend.script = { $0.mode == .probe ? [.error("Nothing is listening")] : [.done(.stop)] }
        await session.open()
        XCTAssertEqual(session.verdict, .unknown)
        XCTAssertEqual(session.availability, .ready(try! backend.capabilityResult.get()))
    }

    func testAThrownProbeFailureIsAlsoNonFatal() async {
        let (session, backend, _) = make()
        backend.thrown = ClientError.unreachable("dropped")
        await session.open()
        XCTAssertEqual(session.verdict, .unknown)
        guard case .ready = session.availability else { return XCTFail("the sheet should stay usable") }
    }

    func testAnAIUnavailableDuringTheProbeEndsAvailability() async {
        let (session, backend, _) = make()
        backend.thrown = ClientError.aiUnavailable("No model set")
        await session.open()
        XCTAssertEqual(session.availability, .unavailable("No model set"))
    }

    /// The Mac panel waits for the section before it probes (`!section` returns early), and for the
    /// same reason: a probe is scored against the section's opening, so one sent without text can
    /// only come back `unknown` — a model call and an egress spent on nothing.
    func testNoSectionTextMeansNoProbeYetAndTheSheetStillOpens() async {
        let (session, backend, context) = make()
        context.context?.section = SectionText(text: nil, offset: nil, truncated: false)
        await session.open()

        XCTAssertTrue(backend.requests(.probe).isEmpty)
        XCTAssertNil(session.verdict, "not probed — the next open tries again")
        guard case .ready = session.availability else { return XCTFail("the sheet should still be usable") }
    }

    func testAReaderThatIsNotReadyDoesNotProbeAndDoesNotCrash() async {
        let (session, backend, context) = make()
        context.context = nil
        await session.open()
        XCTAssertNil(session.verdict, "not probed — it will be on the next open")
        XCTAssertTrue(backend.requests(.probe).isEmpty)
    }

    // MARK: the rung

    func testWeakSendsThePassageAndTheOverrideCannotLowerIt() async {
        let (session, backend, _) = make()
        backend.script = { $0.mode == .probe ? [.verdict(.weak), .done(.stop)] : [.done(.stop)] }
        await session.open()

        XCTAssertEqual(session.rung, .passage)
        await session.setPassageOverride(false)
        XCTAssertEqual(session.rung, .passage)

        await session.send("what is this?")
        let ask = backend.requests(.ask).last
        XCTAssertEqual(ask?.rung, .passage)
        XCTAssertEqual(ask?.section.text, "It was the best of times.")
    }

    func testStrongSendsNoSectionTextAtTheAskAndTheOverrideAddsItOnDemand() async {
        let (session, backend, _) = make()
        backend.script = { $0.mode == .probe ? [.verdict(.strong), .done(.stop)] : [.done(.stop)] }
        await session.open()

        await session.send("q1")
        XCTAssertEqual(backend.requests(.ask).last?.rung, .pointer)
        XCTAssertNil(backend.requests(.ask).last?.section.text, "L0 carries none of the section's text")

        await session.setPassageOverride(true)
        await session.send("q2")
        XCTAssertEqual(backend.requests(.ask).last?.rung, .passage)
        XCTAssertNotNil(backend.requests(.ask).last?.section.text)
    }

    func testTheHighlightTravelsWithAQuestion() async {
        let (session, backend, context) = make()
        context.context?.selection = "the age of wisdom"
        await session.open()
        await session.send("what does this mean?")
        XCTAssertEqual(backend.requests(.ask).last?.selection, "the age of wisdom")
    }

    // MARK: the preview

    func testThePreviewCarriesThePlaceholderQuestionAndStoresTheDisclosure() async {
        let (session, backend, _) = make()
        backend.script = { request in
            request.mode == .preview ? [.disclosure(makeDisclosure("Sends: title, your question")), .done(.stop)] : [.done(.stop)]
        }
        await session.open()

        let preview = backend.requests(.preview).last
        XCTAssertEqual(preview?.question, AskSession.previewPlaceholder)
        XCTAssertEqual(session.disclosure?.text, "Sends: title, your question")
    }

    // MARK: the answer

    func testAnAnswerStreamsIntoOneModelTurn() async {
        let (session, backend, _) = make()
        backend.script = { request in
            request.mode == .ask ? [.delta("A grand"), .delta(" contrast."), .done(.stop)] : [.done(.stop)]
        }
        await session.open()
        await session.send("what is the tone?")

        XCTAssertEqual(session.turns.map(\.text), ["what is the tone?", "A grand contrast."])
        XCTAssertEqual(session.turns.map(\.role), [.reader, .model])
        XCTAssertFalse(session.turns.last?.streaming ?? true)
        XCTAssertNil(session.failure)
    }

    func testAFailureBeforeTheFirstTokenDropsTheEmptyTurnAndSaysSo() async {
        let (session, backend, _) = make()
        backend.script = { request in
            request.mode == .ask ? [.error("the endpoint rejected the key")] : [.done(.stop)]
        }
        await session.open()
        await session.send("hello?")

        XCTAssertEqual(session.turns.map(\.role), [.reader], "no blank bubble")
        XCTAssertEqual(session.failure, "the endpoint rejected the key")
    }

    func testAnAnswerThatTimedOutKeepsWhatArrivedAndReportsIt() async {
        let (session, backend, _) = make()
        backend.script = { request in request.mode == .ask ? [.delta("Part"), .done(.timeout)] : [.done(.stop)] }
        await session.open()
        await session.send("q")
        XCTAssertEqual(session.turns.last?.text, "Part")
        XCTAssertNotNil(session.failure)
    }

    func testABlankQuestionSendsNothing() async {
        let (session, backend, _) = make()
        await session.open()
        await session.send("   \n ")
        XCTAssertTrue(backend.requests(.ask).isEmpty)
        XCTAssertTrue(session.turns.isEmpty)
    }

    // MARK: cancellation

    func testCancellingKeepsThePartialAnswerAndStopsStreaming() async {
        let (session, backend, _) = make()
        backend.script = { request in request.mode == .ask ? [.delta("partial")] : [.done(.stop)] }
        backend.hangs = true
        await session.open()

        session.ask("a long question")
        await waitUntil("the first token") { session.turns.last?.text == "partial" }
        XCTAssertTrue(session.isAnswering)

        session.cancel()
        await waitUntil("the stream to stop") { !session.isAnswering }
        XCTAssertEqual(session.turns.last?.text, "partial")
    }

    func testAskingAgainCancelsTheAnswerInFlight() async {
        let (session, backend, _) = make()
        backend.script = { request in request.mode == .ask ? [.delta("first")] : [.done(.stop)] }
        backend.hangs = true
        await session.open()

        session.ask("one")
        await waitUntil("the first answer to start") { session.turns.last?.text == "first" }
        let firstAnswer = session.turns.last!.id
        session.ask("two")
        await waitUntil("the second question to appear") { session.turns.filter { $0.role == .reader }.count == 2 }
        await waitUntil("the first answer to settle") {
            session.turns.first { $0.id == firstAnswer }?.streaming == false
        }

        XCTAssertEqual(session.turns.first { $0.id == firstAnswer }?.text, "first", "the partial answer is kept")
        XCTAssertEqual(
            session.turns.filter { $0.role == .model && $0.streaming }.count, 1,
            "at most one answer is ever in flight")
        session.cancel()
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `xcodegen generate` + `-only-testing:MusaeumTests/AskSessionTests`
Expected: build FAILS — `AskSession`, `AskReaderContext`, `AskContextProviding` do not exist.

- [ ] **Step 3: Implement**

```swift
import Foundation
import Observation

/// What the reader's Ask sheet needs from the open book, at the moment it asks.
struct AskReaderContext: Equatable, Sendable {
    /// The book's own contents label for the section — never a chapter number.
    var label: String?
    /// The reader's position in the book, 0–1.
    var fraction: Double?
    /// The highlighted text, verbatim, if any.
    var selection: String?
    var section: SectionText
}

/// The open book, seen by the Ask sheet. `ReaderModel` conforms; a test double can too.
@MainActor
protocol AskContextProviding: AnyObject {
    /// `nil` when the reader is not ready (the engine has not laid out yet).
    func askContext() async -> AskReaderContext?
}

/// The phone's side of a conversation about one book: the probe's verdict, the rung it sets, the
/// transcript, and what the Mac last said it would send.
///
/// **The Mac holds nothing between requests**, so this holds the session (design D3): the verdict
/// is cached here and the rung travels in every request. Everything is in memory and dies with
/// the reader screen — nothing is written to disk (design D8, iOS invariant 7).
///
/// What a prompt contains, and whether a model "knows" this book, are the Mac's decisions. This
/// type decides only *when* to ask for them: one probe per (book, session), a preview whenever
/// the rung changes, and which request carries the section's text.
@MainActor
@Observable
final class AskSession {
    enum Availability: Equatable {
        case checking
        case unavailable(String)
        case ready(AskCapability)
    }

    struct Turn: Identifiable, Equatable {
        enum Role: Equatable { case reader, model }
        let id = UUID()
        let role: Role
        var text: String
        var streaming: Bool
    }

    /// A preview has no question yet; the Mac assembles it as an ask when it sees one. The word is
    /// never sent to a model — a preview calls none.
    static let previewPlaceholder = "your question"

    private(set) var availability: Availability = .checking
    /// `nil` until the book has been probed.
    private(set) var verdict: RecallVerdict?
    private(set) var probing = false
    private(set) var turns: [Turn] = []
    /// The Mac's own line about what the next (or current) send contains and where it goes.
    private(set) var disclosure: AskDisclosure?
    private(set) var failure: String?
    private(set) var passageOverride = false

    // `@Observable` rewrites stored properties as tracked computed ones, which a `weak` reference
    // cannot be; none of these is something a view reads, so none is tracked.
    @ObservationIgnored private let bookId: String
    @ObservationIgnored private let backend: (any AskBackend)?
    @ObservationIgnored private weak var context: (any AskContextProviding)?
    @ObservationIgnored private var current: Task<Void, Never>?

    init(bookId: String, backend: (any AskBackend)?, context: any AskContextProviding) {
        self.bookId = bookId
        self.backend = backend
        self.context = context
    }

    /// `weak` forces the passage; the override can add it, never remove it (design D6).
    var rung: AskRung { verdict == .weak || passageOverride ? .passage : .pointer }

    var isAnswering: Bool { turns.last?.streaming == true }

    // MARK: opening

    func open() async {
        guard let backend else {
            availability = .unavailable("This app is not connected to a Mac.")
            return
        }
        if case .ready = availability, verdict != nil {
            await refreshPreview()
            return
        }
        availability = .checking
        do {
            let capability = try await backend.capability()
            guard capability.available else {
                availability = .unavailable(capability.reason ?? "The Mac cannot answer questions right now.")
                return
            }
            availability = .ready(capability)
        } catch {
            availability = .unavailable(Self.sentence(error))
            return
        }
        await probeIfNeeded()
        await refreshPreview()
    }

    /// One probe per (book, session). A probe that cannot run — the reader is not ready, or the section
    /// has yielded no text to score against — leaves the verdict `nil`, so the next open tries again; one that runs and fails lands `unknown`, which is
    /// what is actually known, and is not repeated.
    private func probeIfNeeded() async {
        guard verdict == nil, !probing, let backend, let reader = await context?.askContext(),
            reader.section.text != nil
        else { return }
        probing = true
        defer { probing = false }

        var landed = RecallVerdict.unknown
        do {
            for try await event in backend.ask(makeRequest(.probe, reader, question: nil)) {
                switch event {
                case let .disclosure(line): disclosure = line
                case let .verdict(value): landed = value
                case .delta, .done, .error: break
                }
            }
        } catch let error as ClientError {
            if case let .aiUnavailable(reason) = error { availability = .unavailable(reason) }
        } catch {
            // Cancelled or dropped: unverified, and the sheet stays usable.
        }
        verdict = landed
        Probe.log("ask verdict=\(landed)")
    }

    // MARK: the disclosure line

    func setPassageOverride(_ on: Bool) async {
        passageOverride = on
        await refreshPreview()
    }

    /// Ask the Mac what the next send would contain. A preview calls no model; a failed one is not
    /// something the reader can act on, and the send reports its own.
    func refreshPreview() async {
        guard case .ready = availability, let backend, let reader = await context?.askContext() else { return }
        do {
            for try await event in backend.ask(makeRequest(.preview, reader, question: Self.previewPlaceholder)) {
                if case let .disclosure(line) = event { disclosure = line }
            }
        } catch {
            Probe.log("ask preview failed: \(Self.sentence(error))")
        }
    }

    // MARK: asking

    /// The entry the sheet and the probe use: starts an answer and remembers it, cancelling any
    /// answer still in flight.
    func ask(_ question: String) {
        current?.cancel()
        current = Task { [weak self] in await self?.send(question) }
    }

    func cancel() {
        current?.cancel()
        current = nil
    }

    func send(_ question: String) async {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, case .ready = availability, let backend else { return }
        guard let reader = await context?.askContext() else {
            failure = "The book is still opening — try again in a moment."
            return
        }
        failure = nil
        turns.append(Turn(role: .reader, text: text, streaming: false))
        let answer = Turn(role: .model, text: "", streaming: true)
        turns.append(answer)
        defer { finish(answer.id) }

        do {
            for try await event in backend.ask(makeRequest(.ask, reader, question: text)) {
                switch event {
                case let .disclosure(line): disclosure = line
                case let .delta(piece): append(piece, to: answer.id)
                case let .error(message): failure = message
                case let .done(reason):
                    if reason == .timeout { failure = "The model stopped answering." }
                case .verdict: break
                }
            }
        } catch is CancellationError {
        } catch let error as ClientError {
            failure = Self.sentence(error)
            if case let .aiUnavailable(reason) = error { availability = .unavailable(reason) }
        } catch {
            failure = Self.sentence(error)
        }
        Probe.log("ask answered chars=\(turns.last(where: { $0.role == .model })?.text.count ?? 0) failure=\(failure ?? "none")")
    }

    // MARK: building a request

    /// **What leaves the phone.** The section's text goes to the Mac for a probe (to be scored) and
    /// for an ask at the passage rung (to be windowed and sent on); an ask at the pointer rung
    /// carries none of it — the Mac would ignore it, and there is no reason for it to travel.
    private func makeRequest(_ mode: AskMode, _ reader: AskReaderContext, question: String?) -> AskRequest {
        let effective: AskRung = mode == .probe ? .pointer : rung
        let carriesText = mode == .probe || effective == .passage
        return AskRequest(
            bookId: bookId,
            mode: mode,
            rung: effective,
            section: AskSection(
                label: reader.label,
                text: carriesText ? reader.section.text : nil,
                offset: carriesText ? reader.section.offset : nil,
                truncated: carriesText && reader.section.truncated),
            fraction: reader.fraction,
            selection: mode == .probe ? nil : reader.selection,
            question: question)
    }

    // MARK: turns

    private func append(_ piece: String, to id: UUID) {
        guard let index = turns.firstIndex(where: { $0.id == id }) else { return }
        turns[index].text += piece
    }

    /// Settle an answer. An empty one is dropped, so a failure before the first token reads as a
    /// sentence rather than a blank box.
    private func finish(_ id: UUID) {
        guard let index = turns.firstIndex(where: { $0.id == id }) else { return }
        if turns[index].text.isEmpty {
            turns.remove(at: index)
        } else {
            turns[index].streaming = false
        }
    }

    static func sentence(_ error: Error) -> String {
        (error as? ClientError)?.description ?? error.localizedDescription
    }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `-only-testing:MusaeumTests/AskSessionTests`
Expected: PASS. The two cancellation cases poll with `waitUntil`; if either flakes, increase nothing — find which state never arrived and report it.

- [ ] **Step 5: Full gates and commit**

Run the full build and test gate.

```bash
git add Musaeum/Core/Reader/AskSession.swift Tests/MusaeumTests/AskSessionTests.swift Musaeum.xcodeproj
git commit -m "feat(reader): AskSession — the probe once, the rung, the transcript, the cancel"
```

---

### Task 6: Readium glue, the sheet, and its entry

**Files:**
- Modify: `Musaeum/Core/Reader/ReaderHost.swift` (`publication` kept on `ReaderModel`)
- Create: `Musaeum/Core/Reader/ReaderModel+Ask.swift`
- Create: `Musaeum/Features/Reader/AskSheet.swift`
- Modify: `Musaeum/Features/Reader/ReaderChrome.swift` (an `onAsk` entry), `Musaeum/Features/Reader/ReaderScreen.swift`
- Modify: `Musaeum/Core/Support/Probe.swift`, `scripts/live-probe.sh`

**Interfaces:**
- Consumes: `AskSession`, `AskContextProviding`, `AskReaderContext`, `SectionText`, `AskCitations`, `RelayBackend`, `ReaderTocEntry`.
- Produces: `ReaderModel: AskContextProviding`; `ReaderChrome(… onAsk: (() -> Void)?)`; `Probe.ask: String?` (`MUSAEUM_PROBE_ASK`) and the `READER=ask` surface.

This task is **verified by build and by frames**, not by unit tests: Readium extraction needs a real EPUB and the sheet is a view. The pure logic it composes is already decided in Tasks 4–5. Task 7 is the live pass.

- [ ] **Step 1: Keep the publication on the model**

In `ReaderHost.swift`'s `ReaderModel`, beside `navigator`:

```swift
    /// The opened publication, kept so the Ask sheet can read the current section's text.
    private(set) var publication: Publication?
```
and in `load(...)`, immediately after the `let publication = try await opener.open(...).get()` line: `self.publication = publication`.

- [ ] **Step 2: The Readium extraction**

`Musaeum/Core/Reader/ReaderModel+Ask.swift`:

```swift
import ReadiumNavigator
import ReadiumShared

/// What the Ask sheet asks of the open book.
extension ReaderModel: AskContextProviding {
    func askContext() async -> AskReaderContext? {
        guard let navigator, let publication, let location = navigator.currentLocation else { return nil }

        let highlight = navigator.currentSelection?.locator.text.highlight?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let pieces = await Self.pieces(of: publication, resource: location)
        let section = SectionText.make(
            pieces: pieces,
            readerProgression: location.locations.progression,
            highlight: highlight)

        return AskReaderContext(
            label: chapterTitle,
            fraction: landingFraction,
            selection: (highlight?.isEmpty ?? true) ? nil : highlight,
            section: section)
    }

    /// The current resource's text blocks, in reading order, each with where Readium says it sits.
    ///
    /// Iteration starts at the top of the resource and **stops at the first element that belongs
    /// to the next one** — `content(from:)` runs on through the whole book otherwise. The pieces
    /// are `TextContentElement`s only: an image's alt text is not the section's prose, and the
    /// Mac's own extraction reads text nodes the same way.
    ///
    /// An element's `progression` is its index over the resource's element count (Readium's
    /// `HTMLResourceContentIterator`), not a character fraction — so it is a coarse anchor, and
    /// `SectionText` prefers the highlight when there is one. How coarse is measured on a real
    /// book in the live pass (design AC26), not assumed here.
    private static func pieces(of publication: Publication, resource location: Locator) async -> [SectionText.Piece] {
        let top = Locator(
            href: location.href, mediaType: location.mediaType,
            locations: Locator.Locations(progression: 0))
        guard let content = publication.content(from: top) else { return [] }

        var pieces: [SectionText.Piece] = []
        for await element in content.sequence() {
            if element.locator.href != location.href { break }
            guard let block = element as? TextContentElement, let text = block.text, !text.isEmpty else { continue }
            pieces.append(SectionText.Piece(text: text, progression: element.locator.locations.progression))
        }
        return pieces
    }
}
```

If the sequence turns out to be throwing, use `for try await` inside a `do`/`catch` that returns the pieces gathered so far — a section whose extraction fails partway still sends what it has. If `Locator(href:mediaType:locations:)` or `Locator.Locations(progression:)` does not match the pinned toolkit's initializers, read `DD/SourcePackages/checkouts/swift-toolkit/Sources/Shared/Publication/Locator.swift` and adapt the call — the toolkit is not patched (invariant 8), and the intent (a locator at progression 0 of the same resource) is the contract.

- [ ] **Step 3: The probe seam**

`Probe.swift`, beside `reader`:

```swift
    /// A question the run asks once the Ask sheet is up, so the answer path is decidable without a
    /// tap or a keyboard (`simctl` can drive neither). Used with `READER=ask`.
    static var ask: String? { value("MUSAEUM_PROBE_ASK") }
```
and extend its docs for `reader` to list `ask`. In `scripts/live-probe.sh`, beside the `READER` line add:

```bash
SIMCTL_CHILD_MUSAEUM_PROBE_ASK="${ASK:-}" \
```
and a usage line in the header: `#   TAG=ask READER=ask ASK='What is this book about?' BOOK=<id> ./scripts/live-probe.sh   # the Ask sheet (needs a Mac with a model set, or the stub in scripts/ask-stub.mjs)`.

- [ ] **Step 4: The chrome's entry**

`ReaderChrome` gains `let onAsk: (() -> Void)?` — a `let` optional closure gets no default in the memberwise initializer, so run `grep -rn "ReaderChrome(" Musaeum Tests` and pass `onAsk:` at every call site (today only `ReaderScreen`). The bottom strip becomes:

```swift
    private var bottomStrip: some View {
        HStack(spacing: 12) {
            Button(action: onContents) {
                Label(hasContents ? "Contents" : "No contents in this book", systemImage: "list.bullet")
                    .font(.subheadline)
            }
            .foregroundStyle(hasContents ? Palette.gold : Palette.muted)
            .disabled(!hasContents)
            if let onAsk {
                Button(action: onAsk) {
                    Label("Ask", systemImage: "questionmark.bubble").font(.subheadline)
                }
                .foregroundStyle(Palette.gold)
                .accessibilityLabel("Ask about this book")
            }
            Spacer(minLength: 8)
            progressLabel
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Palette.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            Rectangle().fill(Palette.hairline).frame(height: 1)
        }
    }
```

- [ ] **Step 5: The sheet**

`Musaeum/Features/Reader/AskSheet.swift`:

```swift
import SwiftUI

/// Ask about the book you are reading (design D6, AI-panel D4–D7 on the Mac).
///
/// Everything here is presentation. What a prompt contains, whether the model knows this book, and
/// the sentence about where a question goes are the Mac's and arrive as events; the session turns
/// them into state; this view draws it. In particular the disclosure line is **the Mac's string,
/// shown verbatim** — the phone does not compose a claim about what is sent.
struct AskSheet: View {
    let session: AskSession
    let toc: [ReaderTocEntry]
    let onGoTo: (ReaderTocEntry) -> Void

    @State private var draft = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                switch session.availability {
                case .checking:
                    Spacer()
                    ProgressView().tint(Palette.gold)
                    Spacer()
                case let .unavailable(reason):
                    unavailable(reason)
                case let .ready(capability):
                    transcript(capability)
                    composer(capability)
                }
            }
            .background(Palette.surface)
            .navigationTitle("Ask")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.surface, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Palette.surface)
        .task { await session.open() }
        // Leaving the sheet is leaving the question: the stream is cancelled, a partial answer stays.
        .onDisappear { session.cancel() }
    }

    // MARK: states

    private func unavailable(_ reason: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "questionmark.bubble").font(.largeTitle).foregroundStyle(Palette.muted)
            Text("Ask is not available").font(.display(18)).foregroundStyle(Palette.parchment)
            Text(reason).font(.subheadline).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }

    private func transcript(_ capability: AskCapability) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    notice
                    ForEach(session.turns) { turn in
                        bubble(turn)
                            .id(turn.id)
                        if turn.role == .model, !turn.streaming {
                            ForEach(AskCitations.entries(in: turn.text, toc: toc)) { entry in
                                Button { onGoTo(entry) } label: {
                                    Label("Go to “\(entry.title)”", systemImage: "arrow.turn.down.right")
                                        .font(.footnote)
                                }
                                .foregroundStyle(Palette.gold)
                            }
                        }
                    }
                    if let failure = session.failure {
                        Text(failure).font(.footnote).foregroundStyle(Palette.danger)
                    }
                }
                .padding(16)
            }
            .onChange(of: session.turns.last?.text) { _, _ in
                if let last = session.turns.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }

    /// What the probe found, in the Mac panel's own words (AI-panel D6).
    @ViewBuilder private var notice: some View {
        if session.probing {
            Text("Checking whether the model knows this book…").font(.footnote).foregroundStyle(Palette.muted)
        } else if session.verdict == .weak {
            Text("The model couldn't place this book — sending the passage for this session.")
                .font(.footnote).foregroundStyle(Palette.gold)
        } else if session.verdict == .unknown {
            Text("Unverified — answers about this book are reconstructed, not recalled.")
                .font(.footnote).foregroundStyle(Palette.muted)
        }
    }

    private func bubble(_ turn: AskSession.Turn) -> some View {
        Text(turn.text + (turn.streaming ? " ▍" : ""))
            .font(turn.role == .model ? .display(16) : .subheadline)
            .foregroundStyle(turn.role == .model ? Palette.parchment : Palette.gold)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    // MARK: the composer

    private func composer(_ capability: AskCapability) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let line = session.disclosure {
                Text(line.text).font(.caption).foregroundStyle(Palette.muted)
            }
            Text(
                capability.isLocal
                    ? "Local — nothing leaves your Mac."
                    : "Remote — \(capability.host) receives this."
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(capability.isLocal ? Palette.muted : Palette.gold)

            Toggle(
                "Send the passage too",
                isOn: Binding(
                    get: { session.rung == .passage },
                    set: { on in Task { await session.setPassageOverride(on) } })
            )
            .font(.footnote)
            .tint(Palette.gold)
            .disabled(session.verdict == .weak)

            HStack(spacing: 8) {
                TextField("Ask about this passage", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .padding(10)
                    .background(Palette.raised, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(Palette.parchment)
                Button {
                    let question = draft
                    draft = ""
                    session.ask(question)
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .foregroundStyle(Palette.gold)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.isAnswering)
                .accessibilityLabel("Send")
            }
        }
        .padding(16)
        .background(Palette.surface)
        .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }
}
```

- [ ] **Step 6: Wire it into the reader**

In `ReaderScreen`, add state beside `showingTypography`:

```swift
    @State private var showingAsk = false
    @State private var askSession: AskSession?
```
Pass to `ReaderChrome`: `onAsk: { openAsk() }`. Add the sheet beside the others:

```swift
        .sheet(isPresented: $showingAsk) {
            if let askSession {
                AskSheet(session: askSession, toc: model.toc) { entry in
                    showingAsk = false
                    Task { await model.jump(to: entry) }
                }
            }
        }
```
and the helper, beside `makeClient()`:

```swift
    /// The session is made on first use and kept for as long as the reader screen is: a
    /// conversation survives closing the sheet, and ends with the book (design D8).
    private func openAsk() {
        if askSession == nil {
            askSession = AskSession(
                bookId: request.book.id,
                backend: makeClient().map { RelayBackend(client: $0) },
                context: model)
        }
        showingAsk = true
    }
```
In `applyReaderProbe`'s `switch`, add:

```swift
        case "ask":
            openAsk()
            if let question = Probe.ask {
                // The sheet's `.task` probes and previews first; give them the wait they need
                try? await Task.sleep(for: .seconds(4))
                askSession?.ask(question)
            }
```

- [ ] **Step 7: Build, then the full suite**

Run: `xcodegen generate`, then the build and test gates.
Expected: builds clean under Swift 6 strict concurrency; the test count is unchanged by this task (no new unit tests — see the note at the top of the task). If strict concurrency flags the `weak var context` or `AskContextProviding` conformance, fix it in our types; do not weaken `SWIFT_STRICT_CONCURRENCY`.

- [ ] **Step 8: Commit**

Run `/verify`, then:

```bash
git add Musaeum Musaeum.xcodeproj scripts/live-probe.sh
git commit -m "feat(reader): the Ask sheet — a conversation about the page you are on"
```

---

### Task 7: The live pass, the stub, and the records

**Files:**
- Create: `scripts/ask-stub.mjs`
- Modify: `AGENTS.md` (invariant 4's exceptions), `README.md` (a feature row), `docs/what-works-today.md`, `tasks.md`
- Create: `docs/evidence/ask/` (frames and the probe log from this pass)

**Interfaces:** consumes the whole feature. Produces the evidence for AC20–AC26 and the records that make the next session's re-run one command.

- [ ] **Step 1: A stand-in model**

`scripts/ask-stub.mjs` — an OpenAI-compatible `/v1/chat/completions` that streams a canned answer, answers the recall probe per an environment switch, and logs every request it receives (so "what actually reached the model" is read from its log, not from the phone):

```js
#!/usr/bin/env node
// A stand-in for a model: OpenAI-compatible, streaming, and honest about what it was sent.
//
//   node scripts/ask-stub.mjs [port=8799] [log=/tmp/ask-stub.log]
//   STUB_RECALL=weak|unknown|strong   what the recall probe is told (default weak)
//   STUB_OPENING='…'                  the section opening a `strong` reply quotes
//
// Point the Mac at it: ai_base_url = http://127.0.0.1:8799/v1, ai_model = stub.
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const [port = '8799', log = '/tmp/ask-stub.log'] = process.argv.slice(2)
const recall = process.env.STUB_RECALL ?? 'weak'
const opening = process.env.STUB_OPENING ?? ''

const frame = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`

createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {}
    const messages = body.messages ?? []
    const isProbe = messages.some((m) => /RECALL:/.test(m.content ?? ''))
    appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), isProbe, messages }) + '\n')

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const reply = isProbe
      ? recall === 'strong'
        ? `RECALL: yes\nOPENING: ${opening}\n`
        : recall === 'unknown'
          ? 'Certainly! Here is a lovely summary of the book.'
          : 'RECALL: no\nOPENING:\n'
      : 'This passage sets up a contrast that the rest of the section develops. See “Introduction” for the setup.'
    let i = 0
    const timer = setInterval(() => {
      if (i >= reply.length) {
        clearInterval(timer)
        res.end('data: [DONE]\n\n')
        return
      }
      res.write(frame(reply.slice(i, i + 6)))
      i += 6
    }, 60)
    req.on('close', () => clearInterval(timer))
  })
}).listen(Number(port), '127.0.0.1', () => console.log(`ask stub on :${port}, logging to ${log}`))
```

- [ ] **Step 2: Bring up the isolated Mac and the stub**

Follow `scripts/live-probe.sh`'s header and the Mac repo's `verify` skill: `bash scripts/seed-probe-profile.sh` (port 8789, never the real library), then in the profile's `app_config` set `ai_base_url = http://127.0.0.1:8799/v1` and `ai_model = stub`. Start the stub (`STUB_RECALL=weak node scripts/ask-stub.mjs`) and the Mac (`env -u ELECTRON_RUN_AS_NODE MUSAEUM_USER_DATA=… npm run dev`). Record the Mac's HEAD and this repo's HEAD in the evidence notes.

- [ ] **Step 3: Run the probes and read the evidence**

For each, run `TAG=<tag> READER=ask ASK='…' BOOK=<id> ./scripts/live-probe.sh` and keep the frame and the probe log under `docs/evidence/ask/`:

| Probe | Setup | Decides |
| --- | --- | --- |
| `ask-weak` | `STUB_RECALL=weak` | AC20, AC21: the sheet shows the Mac's disclosure line before any send; `ask verdict=weak` in the log; the stub's log shows the **passage** in the ask request and the notice is on the frame |
| `ask-unknown` | `STUB_RECALL=unknown` | the *unverified* notice; the stub's log shows **no section text** in the ask request (AC22) |
| `ask-strong` | `STUB_RECALL=strong`, `STUB_OPENING` = the book's first words | `ask verdict=strong`; no notice; pointer-only |
| `ask-off` | the Mac with no `ai_model` | "Ask is not available" with the Mac's reason; reading is unaffected |
| `ask-old` | a Mac build from before the Mac plan (or a health block with `ai` removed behind a proxy) | the "too old" sentence, no crash |
| `ask-offline` | stop the Mac, `TAG=offline` | the downloaded book reads; Ask says why it is unavailable (AC25) |

Then, **in the stub's log**, check what reached the model — not the phone's opinion of it: at the pointer rung no request contains the section's text; at the passage rung the request contains text around the reader's position; no request contains the bearer token.

- [ ] **Step 4: Measure the two numbers the spec left open (AC26)**

(a) **The offset mapping.** With a book downloaded, a highlight-free page, and the passage rung forced (`STUB_RECALL=weak`), compare the offset the phone sent (log it from `AskSession` at `Probe.log` level for the run) against the position of the page's first words in the extracted text, over at least five positions in one book and report the error in characters. The Mac's window leads the anchor by 1,000 characters, so an error under ~1,000 is absorbed; report the figure, and if it exceeds that, say so rather than shipping it quietly. (b) **The cap.** Count how many sections of the test book exceed 200,000 UTF-16 units (expected: none), and record it.

- [ ] **Step 5: The records**

- `AGENTS.md` invariant 4: add *"The third deliberate exception is `health.ai` — absent on a Mac older than the ask route; a present member is strict."* beside the two it already names.
- `README.md`: a feature row — *Ask* — "Ask about the page you're on; the Mac's model answers, and the sheet says what leaves the Mac before you send."
- `docs/what-works-today.md`: what works, what the pass measured (the offset error, the cap count), and what was not verified (a real model; a real tap on the send button — `simctl` can drive neither).
- `tasks.md`: the open tails — an Ask entry point from the book detail screen; the direct backend (design D1, revived only by Ask being wanted with the Mac off); persisting a transcript (AI-panel D8, same condition as the Mac's).

- [ ] **Step 6: Commit**

```bash
git add scripts/ask-stub.mjs AGENTS.md README.md docs tasks.md
git commit -m "docs(ask): the live pass, its evidence, and what it left open"
```

---

## Self-review (run against the spec)

- **Spec coverage:** D1 → Task 3 (`AskBackend`, `RelayBackend`, `AskCapability`). D3's client half → Tasks 1–3 (the request, the five events, the refusals, the heartbeat tolerance, cancel-as-disconnect, ignore-unknown). D6 → Tasks 4 and 6 (Readium text, offset, selection, label, "Go to"). AC16 → Task 1; AC17 → Tasks 2–3; AC18 → Tasks 1 and 3; AC19 → Task 3's token assertion; AC20–AC21 → Tasks 5–7; AC22 → Task 7 (the stub's log); AC23 → Task 4 (`AskCitations`) + Task 7; AC24 → Tasks 5–6 (`cancel`, `onDisappear`, no disk writes); AC25 → Task 7 (`ask-offline`, `ask-off`); AC26 → Task 7 Step 4.
- **Placeholder scan:** no step defers content; the one hedge ("adapt the call if the toolkit's initializer differs") names the file to read and the intent that must hold.
- **Type consistency:** `AskRequest`/`AskSection` (Task 1) are built in `AskSession.makeRequest` (Task 5); `AskEvent` cases match across `decode` (Task 1), the stream (Task 3), the session's `switch` statements (Task 5) and the fake backend (Task 5 tests); `AskCapability` (Task 3) is what `AskSession.Availability.ready` carries and `AskSheet` reads; `SectionText` (Task 4) is `AskReaderContext.section` (Task 5) and is produced by `ReaderModel.askContext` (Task 6).
- **Known limits to say aloud:** the Readium extraction and the sheet are verified by frames and a live pass, not by unit tests (no EPUB fixture in the suite); element `progression` is an element-index fraction, so the no-highlight offset is coarse by construction (measured in Task 7, not assumed); `AsyncBytes` is read one byte at a time, which is fine for a text stream and would not be for a download; a backgrounded app ends its stream, which surfaces as `unreachable`.
