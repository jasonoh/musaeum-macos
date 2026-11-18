/**
 * The position body's grammar: `{ "to": "top" | "bottom" }`, and nothing else.
 *
 * **`docs/superpowers/specs/2026-11-18-reading-queue-design.md` D6 is the
 * authority.** It pins the body to exactly one member, `to`, whose value is one
 * of two strings — and makes anything else a **400**, after the route has
 * already refused an offline share, an unknown shelf or book, and a manual
 * shelf. The wire carries no third shape and no per-book position.
 *
 * **This is deliberately *not* `services/shelves.ts`'s `isPlacement`.** That
 * function is the *Mac's* grammar for the same write, and it is wider on
 * purpose: a drag names an anchor, so `{ before: id }` and `{ after: id }` are
 * shapes `moveBooks` accepts and performs (`shelves.ts:299-307`). The wire
 * refuses both, because a phone's two menu items are *top* and *end* and an
 * anchor id would be a second, unversioned way to address a queue's order.
 * Delegating to `isPlacement` here would answer 200 to a body the contract
 * refuses — which is exactly why the parser exists rather than being reused.
 * If the wire ever grows `before`/`after`, this function grows with it and the
 * service's does not change; the two are separate grammars for separate
 * clients, and R3 records that choice.
 *
 * **Refuses rather than repairs**, like the reading report's parse
 * (`api/reading.ts`): `'Top'` is not `'top'`, `1` is not a coercion target, and
 * a body with a second member is not "the member I know plus noise". A client's
 * typo is answered with a 400 it can see, not with a move it did not ask for.
 *
 * Pure: a JSON value in, a decision out. No fs, no db, no URL, no Electron.
 */

/** The two places D6 lets a client put a book. */
export type PositionTarget = 'top' | 'bottom'

export type ParsedPosition = { ok: true; to: PositionTarget } | { ok: false }

/** A body this route cannot read: answered 400, never defaulted. */
const INVALID_POSITION: { ok: false } = { ok: false }

/**
 * A parsed body, or a refusal.
 *
 * Two rules, and both are refusals rather than defaults:
 *
 * - the body is **one JSON object** — not an array (`[]` and `['top']` both land
 *   here), not a bare string or number, not `null`, and not the empty object;
 * - its **only own key is `to`, and its value is exactly `'top'` or
 *   `'bottom'`** — case-sensitively, with no trimming, and with no coercion of
 *   a number or a null to anything.
 *
 * "Own" is load-bearing and is what `Object.keys` gives: it lists own
 * enumerable keys only, so a `to` inherited from a prototype does not count as
 * the body's member — the same reading of "one key" `isPlacement` uses. There
 * is no `in` test here, which is why an inherited `to` cannot smuggle itself
 * past the single-key rule.
 */
export function parsePositionBody(raw: unknown): ParsedPosition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return INVALID_POSITION

  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'to') return INVALID_POSITION

  const { to } = raw as { to?: unknown }
  if (to !== 'top' && to !== 'bottom') return INVALID_POSITION

  return { ok: true, to }
}
