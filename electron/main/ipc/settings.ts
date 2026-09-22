import { dialog } from 'electron'
import type { EditableSettings, ExecutableKind } from '@shared/settings.types'
import { getPythonEnvState } from '../services/python-env'
import * as settings from '../services/settings'
import { handle } from './handle'

/** Where each executable picker starts, and what it calls the thing it wants. */
const PICKERS: Record<ExecutableKind, { title: string; defaultPath: string }> = {
  python: { title: 'Choose Python Interpreter', defaultPath: '/usr/local/bin' },
  ebookConvert: {
    title: 'Choose ebook-convert',
    defaultPath: '/Applications/calibre.app/Contents/MacOS'
  }
}

export function registerSettingsHandlers(): void {
  handle('settings:get', () => settings.getSettings())
  // `saveSettingsAndApply`, not `saveSettings`: the dialog's save also has to
  // make the API's listener agree with what was written (the listen-time keys
  // are captured when the socket is created), and it answers with the view the
  // dialog should now show. Both live in `services/settings.ts` — this handler
  // stays a one-line wrapper (invariant 8).
  handle('settings:save', (updates: Partial<EditableSettings>) =>
    settings.saveSettingsAndApply(updates)
  )
  handle('settings:getPythonEnv', () => getPythonEnvState())

  handle('settings:chooseExecutable', async (kind: ExecutableKind) => {
    const picker = PICKERS[kind]
    if (!picker) throw new Error(`Unknown executable: ${kind}`)
    const result = await dialog.showOpenDialog({
      title: picker.title,
      defaultPath: picker.defaultPath,
      // Interpreters live in dot-directories (sidecar/.venv/bin/python)
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })
}
