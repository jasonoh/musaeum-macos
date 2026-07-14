import type { MusaeumAPI } from './api.types'

declare global {
  interface Window {
    Musaeum: MusaeumAPI
  }
}

export {}
