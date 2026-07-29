import { promises as fs } from 'fs'
import { join } from 'path'
import type { Device } from '@shared/device.types'
import * as db from './db'
import { broadcast } from './events'
import { sanitizeTitle } from './sanitize'

const POLL_INTERVAL_MS = 5_000
const VOLUMES = '/Volumes'
const MAX_SCAN_DEPTH = 2

const devices = new Map<string, Device>()
const deviceContents = new Map<string, Set<string>>()
let pollTimer: NodeJS.Timeout | null = null

export function getConnectedDevices(): Device[] {
  return [...devices.values()]
}

export function getDevice(id: string): Device | null {
  return devices.get(id) ?? null
}

/**
 * A mounted volume is treated as a Kindle when its name says so, or when it
 * has the Kindle filesystem signature (documents/ + system/ directories).
 */
async function looksLikeKindle(mountPath: string, name: string): Promise<boolean> {
  if (/kindle/i.test(name)) return true
  try {
    const [docs, system] = await Promise.all([
      fs.stat(join(mountPath, 'documents')),
      fs.stat(join(mountPath, 'system'))
    ])
    return docs.isDirectory() && system.isDirectory()
  } catch {
    return false
  }
}

async function freeBytes(mountPath: string): Promise<number | null> {
  try {
    const s = await fs.statfs(mountPath)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

/**
 * Recursively walk {mountPath}/documents/ (max depth 2) and collect the
 * lowercased, extension-stripped basename of every file — used to determine
 * which books are physically present on the device.
 */
async function scanDocuments(mountPath: string): Promise<Set<string>> {
  const stems = new Set<string>()
  const documentsDir = join(mountPath, 'documents')

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) await walk(full, depth + 1)
      } else if (entry.isFile()) {
        const stem = entry.name.replace(/\.[^.]+$/, '')
        stems.add(stem.toLowerCase())
      }
    }
  }

  try {
    await walk(documentsDir, 1)
  } catch {
    return new Set()
  }
  return stems
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/** Re-scan a connected device's documents/ folder and broadcast the change. */
export async function refreshDeviceContents(deviceId: string): Promise<void> {
  const device = getDevice(deviceId)
  if (!device) return
  deviceContents.set(deviceId, await scanDocuments(device.mountPath))
  broadcast('deviceContentsChanged', deviceId)
}

/** Book IDs whose sanitized title matches a file present on the device. */
export function getOnDeviceBookIds(deviceId: string): string[] {
  const stems = deviceContents.get(deviceId)
  if (!stems || stems.size === 0) return []
  const books = db.getBooks()
  const ids: string[] = []
  for (const book of books) {
    if (stems.has(sanitizeTitle(book.title).toLowerCase())) ids.push(book.id)
  }
  return ids
}

async function scan(): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(VOLUMES)
  } catch {
    return
  }

  const seen = new Set<string>()
  for (const name of names) {
    const mountPath = join(VOLUMES, name)
    const id = `kindle:${name}`
    if (devices.has(id)) {
      seen.add(id)
      // Re-scan so presence self-heals: books added/removed on the device
      // outside Musaeum, or a first scan that ran before the volume settled.
      const next = await scanDocuments(mountPath)
      const prev = deviceContents.get(id)
      if (!prev || !setsEqual(prev, next)) {
        deviceContents.set(id, next)
        broadcast('deviceContentsChanged', id)
      }
      continue
    }
    if (await looksLikeKindle(mountPath, name)) {
      const device: Device = {
        id,
        kind: 'kindle',
        name,
        mountPath,
        freeBytes: await freeBytes(mountPath)
      }
      devices.set(id, device)
      seen.add(id)
      deviceContents.set(id, await scanDocuments(mountPath))
      broadcast('deviceConnected', device)
      broadcast('deviceContentsChanged', id)
    }
  }

  for (const [id, device] of devices) {
    if (!seen.has(id)) {
      try {
        await fs.access(device.mountPath)
        seen.add(id) // still mounted; volume just wasn't re-validated
      } catch {
        devices.delete(id)
        deviceContents.delete(id)
        broadcast('deviceDisconnected', id)
      }
    }
  }
}

export function startDeviceDetection(): void {
  if (pollTimer) return
  void scan()
  pollTimer = setInterval(() => void scan(), POLL_INTERVAL_MS)
}

export function stopDeviceDetection(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
