import type { BulkHydrateProgress, HydratedField, HydrateOutcome } from '@shared/metadata.types'
import { HYDRATED_FIELD_LABELS } from '@shared/metadata.types'

/**
 * The words for "what just happened to this book's metadata".
 *
 * Pure and separate from the components that raise it, for two reasons: a
 * refresh can finish long after the panel it started from is gone, so the
 * message has to be composed from the result alone; and these are the sentences
 * a user reads to decide whether to trust the button, which makes them worth
 * testing without a DOM.
 */
export interface ToastContent {
  kind: 'success' | 'info' | 'error'
  message: string
  detail?: string
  /** Rendered as a button on the toast, for a follow-up the message implies. */
  actionLabel?: string
}

/** Display order is the order the labels are written in — most noticed first. */
const FIELD_ORDER = Object.keys(HYDRATED_FIELD_LABELS) as HydratedField[]

const MAX_NAMED_FIELDS = 3
const MAX_DETAIL = 180

function truncate(text: string, max = MAX_DETAIL): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** "Cover, series and description"; four or more becomes "and 2 more". */
export function fieldSummary(fields: HydratedField[]): string {
  const named = FIELD_ORDER.filter((f) => fields.includes(f))
  const labels = named.map((f, i) =>
    // Only the first keeps its capital: "Cover, series and published date"
    i === 0 ? HYDRATED_FIELD_LABELS[f] : HYDRATED_FIELD_LABELS[f].toLowerCase()
  )
  if (labels.length > MAX_NAMED_FIELDS) {
    const rest = labels.length - (MAX_NAMED_FIELDS - 1)
    return `${labels.slice(0, MAX_NAMED_FIELDS - 1).join(', ')} and ${rest} more`
  }
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

function fieldsNeedingReview(count: number): string {
  return `${count} field${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} review`
}

/**
 * What to say after one book was re-fetched.
 *
 * The no-change case is the one that matters most: a refresh that finds
 * nothing new used to look exactly like a refresh that did nothing at all,
 * and "already up to date" is the answer to the question the button asks.
 */
export function describeHydrate(outcome: HydrateOutcome, bookTitle: string): ToastContent {
  if (!outcome.ok) {
    return {
      kind: 'error',
      message: 'Metadata refresh failed',
      detail: `${bookTitle} · ${truncate(outcome.error)}`
    }
  }

  const review = outcome.conflicts > 0
  if (outcome.changed.length === 0) {
    return review
      ? {
          kind: 'info',
          message: fieldsNeedingReview(outcome.conflicts),
          detail: `${bookTitle} · sources disagree, nothing was rewritten`,
          actionLabel: 'Review'
        }
      : {
          kind: 'info',
          message: 'No new metadata found',
          detail: `${bookTitle} already has the latest details`
        }
  }

  return {
    kind: 'success',
    message: 'Metadata updated',
    detail: review
      ? `${fieldSummary(outcome.changed)} · ${outcome.conflicts} to review`
      : fieldSummary(outcome.changed),
    actionLabel: review ? 'Review' : undefined
  }
}

/**
 * What to say when a bulk refresh ends. It is the job's only report: the status
 * bar counter is gone by the time the answer is interesting, and the reason it
 * stopped early (cancelled, or the share dropped under it) is not something the
 * user can infer from a count that stopped moving.
 */
export function describeBulkHydrate(p: BulkHydrateProgress): ToastContent | null {
  if (p.total === 0) return null

  const changed = `${p.updated} updated`
  // Skipped books (nothing to hydrate from) are neither updated nor current
  const unchanged = p.completed - p.updated - p.skipped
  const parts = [changed]
  if (unchanged > 0) parts.push(`${unchanged} already up to date`)
  if (p.skipped > 0) parts.push(`${p.skipped} skipped`)

  if (p.stopped === 'offline') {
    return {
      kind: 'error',
      message: 'Refresh stopped — the library went offline',
      detail: `${p.completed} of ${p.total} refreshed · ${changed}`
    }
  }
  if (p.stopped === 'cancelled') {
    return {
      kind: 'info',
      message: 'Refresh stopped',
      detail: `${p.completed} of ${p.total} refreshed · ${changed}`
    }
  }
  if (p.failed > 0) {
    return {
      kind: 'error',
      message: `Refresh failed for ${p.failed} of ${p.total} books`,
      detail: p.lastError ? truncate(p.lastError) : undefined
    }
  }
  if (p.updated === 0) {
    return {
      kind: 'info',
      message: 'No new metadata found',
      detail: `All ${p.total} books already have the latest details`
    }
  }
  return {
    kind: 'success',
    message: `Refreshed ${p.completed} book${p.completed === 1 ? '' : 's'}`,
    detail: parts.join(' · ')
  }
}
