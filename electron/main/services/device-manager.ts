import { promises as fs } from 'fs'
import { join } from 'path'
import type { Device } from '@shared/device.types'
import { broadcast } from './events'

const POLL_INTERVAL_MS = 5_000
const VOLUMES = '/Volumes'

const devices = new Map<string, Device>()
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
      broadcast('deviceConnected', device)
    }
  }

  for (const [id, device] of devices) {
    if (!seen.has(id)) {
      try {
        await fs.access(device.mountPath)
        seen.add(id) // still mounted; volume just wasn't re-validated
      } catch {
        devices.delete(id)
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
