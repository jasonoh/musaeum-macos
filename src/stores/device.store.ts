import { create } from 'zustand'
import type { Device, TransferJob } from '@shared/device.types'

interface DeviceState {
  devices: Device[]
  transfers: Record<string, TransferJob>

  refresh(): Promise<void>
  addDevice(device: Device): void
  removeDevice(deviceId: string): void
  upsertTransfer(job: TransferJob): void
  removeTransfer(jobId: string): void
  sendToDevice(bookId: string, deviceId: string): Promise<void>
}

export const useDeviceStore = create<DeviceState>((set) => ({
  devices: [],
  transfers: {},

  async refresh() {
    try {
      set({ devices: await window.Musaeum.devices.getConnectedDevices() })
    } catch (err) {
      console.error('device refresh failed:', err)
    }
  },

  addDevice: (device) =>
    set((s) => ({ devices: [...s.devices.filter((d) => d.id !== device.id), device] })),

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
  }
}))
