import { create } from 'zustand'
import type { NASStatus } from '@shared/metadata.types'

interface NASState {
  status: NASStatus | null
  reconnecting: boolean

  refresh(): Promise<void>
  reconnect(): Promise<void>
  setStatus(status: NASStatus): void
}

export const useNASStore = create<NASState>((set) => ({
  status: null,
  reconnecting: false,

  async refresh() {
    try {
      set({ status: await window.Musaeum.nas.getStatus() })
    } catch (err) {
      console.error('nas status failed:', err)
    }
  },

  async reconnect() {
    set({ reconnecting: true })
    try {
      await window.Musaeum.nas.reconnect()
      set({ status: await window.Musaeum.nas.getStatus() })
    } finally {
      set({ reconnecting: false })
    }
  },

  setStatus: (status) => set({ status })
}))
