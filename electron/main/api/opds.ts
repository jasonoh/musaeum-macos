// A minimal stub so `services/settings.ts` can import the OPDS listener's
// lifecycle. Task 4 replaces this file with the real server, keeping these
// names (and adding options parameters; callers here pass none).

export type OpdsStatus = {
  state: 'disabled' | 'starting' | 'listening' | 'failed'
  address: string | null
  port: number | null
  reason: string | null
  at: string | null
}

const DISABLED: OpdsStatus = {
  state: 'disabled',
  address: null,
  port: null,
  reason: null,
  at: null
}

export function getOpdsStatus(): OpdsStatus {
  return { ...DISABLED }
}

export async function startOpdsIfEnabled(): Promise<OpdsStatus> {
  return { ...DISABLED }
}

export async function stopOpds(): Promise<OpdsStatus> {
  return { ...DISABLED }
}
