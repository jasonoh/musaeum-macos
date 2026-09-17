import { create } from 'zustand'
import type { Device, TransferJob } from '@shared/device.types'

/** The device with this id, restated in place, or appended — keyed by id. */
function withDevice(devices: Device[], device: Device): Device[] {
  return [...devices.filter((d) => d.id !== device.id), device]
}

interface DeviceState {
  devices: Device[]
  transfers: Record<string, TransferJob>
  onDevice: Record<string, string[]>

  refresh(): Promise<void>
  addDevice(device: Device): void
  /** A known device, restated — its details moved, its contents did not. */
  updateDevice(device: Device): void
  removeDevice(deviceId: string): void
  upsertTransfer(job: TransferJob): void
  removeTransfer(jobId: string): void
  sendToDevice(bookId: string, deviceId: string): Promise<void>
  sendBooksToDevice(bookIds: string[], deviceId: string): Promise<void>
  removeFromDevice(bookId: string, deviceId: string): Promise<void>
  setOnDevice(deviceId: string, bookIds: string[]): void
  refreshDeviceContents(deviceId: string): Promise<void>
}

export const useDeviceStore = create<DeviceState>((set, get) => ({
  devices: [],
  transfers: {},
  onDevice: {},

  async refresh() {
    try {
      const devices = await window.Musaeum.devices.getConnectedDevices()
      set({ devices })
      await Promise.all(devices.map((d) => get().refreshDeviceContents(d.id)))
    } catch (err) {
      console.error('device refresh failed:', err)
    }
  },

  addDevice: (device) => {
    set((s) => ({ devices: withDevice(s.devices, device) }))
    void get().refreshDeviceContents(device.id)
  },

  /**
   * Deliberately not `addDevice`: that one also re-asks for the contents, and
   * nothing about a free-space reading changes which books are on the device.
   */
  updateDevice: (device) => set((s) => ({ devices: withDevice(s.devices, device) })),

  removeDevice: (deviceId) => set((s) => ({ devices: s.devices.filter((d) => d.id !== deviceId) })),

  upsertTransfer: (job) => set((s) => ({ transfers: { ...s.transfers, [job.jobId]: job } })),

  removeTransfer: (jobId) =>
    set((s) => {
      const transfers = { ...s.transfers }
      delete transfers[jobId]
      return { transfers }
    }),

  async sendToDevice(bookId, deviceId) {
    const job = await window.Musaeum.devices.sendToDevice(bookId, deviceId)
    set((s) => ({ transfers: { ...s.transfers, [job.jobId]: job } }))
  },

  /**
   * Send many books. A plain loop over the single-book call is correct here:
   * `sendToDevice` returns as soon as the job is enqueued, and the main
   * process's transfer queue is already serial, so this adds N jobs to one
   * queue rather than N concurrent copies. StatusBar counts them for free.
   */
  async sendBooksToDevice(bookIds, deviceId) {
    const already = new Set(get().onDevice[deviceId] ?? [])
    for (const bookId of bookIds.filter((id) => !already.has(id))) {
      try {
        await get().sendToDevice(bookId, deviceId)
      } catch (err) {
        // The queue logs per-book failures to device_history; one book that
        // can't be queued must not stop the rest
        console.error(`send to device failed for ${bookId}:`, err)
      }
    }
  },

  async removeFromDevice(bookId, deviceId) {
    await window.Musaeum.devices.removeFromDevice(bookId, deviceId)
    // The main process re-scans and broadcasts deviceContentsChanged, but that
    // round-trip is a frame or two behind the click — drop the book now so the
    // button can't sit on "On Kindle" after a successful removal
    set((s) => ({
      onDevice: {
        ...s.onDevice,
        [deviceId]: (s.onDevice[deviceId] ?? []).filter((id) => id !== bookId)
      }
    }))
  },

  setOnDevice: (deviceId, bookIds) =>
    set((s) => ({ onDevice: { ...s.onDevice, [deviceId]: bookIds } })),

  async refreshDeviceContents(deviceId) {
    try {
      const bookIds = await window.Musaeum.devices.getOnDeviceBookIds(deviceId)
      get().setOnDevice(deviceId, bookIds)
    } catch (err) {
      console.error('device contents refresh failed:', err)
    }
  }
}))

/** Names of connected devices that currently have this book on them. */
export function bookOnDevices(state: DeviceState, bookId: string): string[] {
  return state.devices.filter((d) => state.onDevice[d.id]?.includes(bookId)).map((d) => d.name)
}
