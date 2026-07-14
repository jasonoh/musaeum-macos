import type { BookFormat } from './book.types'

export type DeviceKind = 'kindle' | 'boox'

export interface Device {
  id: string
  kind: DeviceKind
  name: string
  /** Mount point on disk, e.g. /Volumes/Kindle */
  mountPath: string
  /** Free space in bytes, if known */
  freeBytes: number | null
}

export type TransferStatus =
  | 'queued'
  | 'converting'
  | 'copying'
  | 'done'
  | 'error'

export interface TransferJob {
  jobId: string
  bookId: string
  bookTitle: string
  deviceId: string
  deviceName: string
  format: BookFormat | null
  status: TransferStatus
  /** 0–1 copy progress, when copying */
  progress: number
  error?: string
}

export type TransferProgress = TransferJob
