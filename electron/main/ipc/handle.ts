import { ipcMain } from 'electron'
import type { IPCResult } from '@shared/api.types'

/**
 * Register an IPC handler that never throws across the process boundary:
 * results are wrapped as { success, data } | { success, error }.
 */
export function handle<Args extends unknown[], T>(
  channel: string,
  fn: (...args: Args) => T | Promise<T>
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IPCResult<T>> => {
    try {
      const data = await fn(...(args as Args))
      return { success: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ipc] ${channel} failed:`, message)
      return { success: false, error: message }
    }
  })
}
