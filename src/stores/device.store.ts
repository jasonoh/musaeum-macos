import { create } from 'zustand'
import type { Device, TransferJob } from '@shared/device.types'

interface DeviceState {
  devices: Device[]
  transfers: Record<string, TransferJob>
  onDevice: Record<string, string[]>

  refresh(): Promise<void>
  addDevice(device: Device): void
  removeDevice(deviceId: string): void
  upsertTransfer(job: TransferJob): void
  removeTransfer(jobId: string): void
  sendToDevice(bookId: string, deviceId: string): Promise<void>
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
    set((s) => ({ devices: [...s.devices.filter((d) => d.id !== device.id), device] }))
    void get().refreshDeviceContents(device.id)
  },

  removeDevice: (deviceId) =>
    set((s) => ({ devices: s.devices.filter((d) => d.id !== deviceId) })),

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
  return state.devices
    .filter((d) => state.onDevice[d.id]?.includes(bookId))
    .map((d) => d.name)
}
