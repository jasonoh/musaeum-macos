import { useUIStore } from '@/stores/ui.store'

/**
 * The session's memory of what it has already said about shelves.
 *
 * Slice 1's third handoff note: every mutation that finds `shelves.json`
 * unreadable rejects with the *same* sentence, and the spec wants it surfaced
 * once per session rather than once per click. The toast's own de-duplication
 * (`ui.store.notify` drops an identical message+detail pair) only covers a toast
 * that is still on screen — 12 s later the next click would say it again.
 *
 * The identity is the **sentence**, not the error or the call site: two
 * different failures carrying the same words are the same news, and that
 * sentence is the whole of what a person can act on.
 *
 * A factory rather than a module-level Set with a test-only reset: the memory is
 * the behaviour, so a case holds its own session and the app's instance is one
 * exported line.
 */
export function createShelfFailureReporter(say: (message: string) => void): (err: unknown) => void {
  const said = new Set<string>()
  return (err) => {
    const message = err instanceof Error ? err.message : String(err)
    if (said.has(message)) return
    said.add(message)
    say(message)
  }
}

/**
 * The app's one reporter, for every shelf path: create, rename, delete, add,
 * remove, restore, and the reads behind the sidebar.
 *
 * It renders the error's own text and never a rewording of it — the sentence
 * comes from main, and `src/lib/storage-copy-scan.test.ts` fails the build if a
 * renderer writes its own version of one.
 */
export const reportShelfFailure = createShelfFailureReporter((message) =>
  useUIStore.getState().notify({ kind: 'error', message })
)
