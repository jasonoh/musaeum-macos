import { useEffect } from 'react'
import { useReaderStore } from '@/stores/reader.store'

/**
 * Wire the ask stream into the reader store. Mount once at app root.
 *
 * **Once, not per request.** The three channels carry an id and nothing else
 * about who is listening, so a subscription per question would work — and would
 * be the third place in the app to re-invent "clean up when the stream ends",
 * with a leaked listener as the failure mode in an app that budgets 500MB. The
 * store routes each event by `requestId` instead (`aiChunk`/`aiDone`/`aiError`),
 * which is the same information with none of the bookkeeping: an event for a
 * request nobody is waiting on is dropped by the reducer, not by a missing
 * listener.
 */
export function useAi(): void {
  const aiChunk = useReaderStore((s) => s.aiChunk)
  const aiDone = useReaderStore((s) => s.aiDone)
  const aiError = useReaderStore((s) => s.aiError)

  useEffect(() => {
    const unsubs = [
      window.Musaeum.on.aiChunk(aiChunk),
      window.Musaeum.on.aiDone(aiDone),
      window.Musaeum.on.aiError(aiError)
    ]
    return () => unsubs.forEach((u) => u())
  }, [aiChunk, aiDone, aiError])
}
