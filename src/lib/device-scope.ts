import type { Book } from '@shared/book.types'

/**
 * The books of a read that are on one device, in the read's own order.
 *
 * Presence is not in SQLite — the device store holds it, scanned in the
 * background — so a device scope narrows a loaded result rather than adding a
 * clause to the read. With no device open the list is returned as is (same
 * array, so nothing re-renders for a scope nobody is in). A device whose scan
 * has not landed yet has no entry and shows nothing, which is the same list a
 * scan that found nothing would show; `deviceScanned` tells them apart.
 */
export function scopeToDevice(
  books: Book[],
  deviceId: string | null,
  onDevice: Record<string, string[]>
): Book[] {
  if (!deviceId) return books
  const present = new Set(onDevice[deviceId] ?? [])
  return books.filter((b) => present.has(b.id))
}

/** Whether the device's first scan has landed (an empty answer counts). */
export function deviceScanned(deviceId: string, onDevice: Record<string, string[]>): boolean {
  return onDevice[deviceId] !== undefined
}
