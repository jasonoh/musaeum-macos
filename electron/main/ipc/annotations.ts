import type { ReaderFormat } from '@shared/book.types'
import type { NewAnnotationInput } from '@shared/annotation.types'
import * as annotations from '../services/annotations'
import { handle } from './handle'

/**
 * A book's highlights and notes (`docs/superpowers/specs/2026-10-13-annotations-design.md`,
 * slice 1). Thin by rule (invariant 8): the queue, the re-read, the refusals and the
 * artifact comparison are all `services/annotations.ts`'s, and a refusal reaches the
 * renderer as the envelope's `error` — the sentence main composed.
 *
 * Every channel carries the `format` the reader has open, because the artifact a stored
 * `cfi` points into is resolved per call (spec D6): the same book read as its own `mobi` and
 * as its reflowed EPUB are two different documents, and only the caller knows which one is
 * on screen. It is typed as the bridge's `ReaderFormat` rather than `string`, so the contract
 * is the union at the door as well as in `src/types/api.types.ts` — and a value that is not
 * one of them needs no guard here: it can only make an annotation read stale, which is
 * listed and never drawn.
 */
export function registerAnnotationHandlers(): void {
  handle('annotations:list', (bookId: string, format: ReaderFormat) =>
    annotations.list(bookId, format)
  )
  handle('annotations:create', (input: NewAnnotationInput) => annotations.create(input))
  handle(
    'annotations:update',
    (bookId: string, id: string, note: string | null, format: ReaderFormat) =>
      annotations.update(bookId, id, note, format)
  )
  handle('annotations:remove', (bookId: string, id: string, format: ReaderFormat) =>
    annotations.remove(bookId, id, format)
  )
}
