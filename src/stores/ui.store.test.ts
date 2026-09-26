import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { persistedUIState, useUIStore } from './ui.store'

/**
 * The cover picker's slot, and the one rule about the whole store that the
 * picker could break: what outlives a session.
 *
 * The alternative deciders were tried first and each decides something else —
 * `.persist` is not reachable in a `node` environment with no `localStorage`,
 * and asserting a dialog's flag *directly* is not the question: the question is
 * whether it is still there after a launch, which is exactly
 * `persistedUIState`'s output.
 */

beforeEach(() => {
  useUIStore.setState({ coverPickerBookId: null, contextMenu: null, editingBookId: null })
})

describe('the cover picker slot', () => {
  it('opens for a book, and closes on null', () => {
    useUIStore.getState().requestCoverPicker('book-1')
    expect(useUIStore.getState().coverPickerBookId).toBe('book-1')

    useUIStore.getState().requestCoverPicker(null)
    expect(useUIStore.getState().coverPickerBookId).toBeNull()
  })

  it('dismisses the context menu that opened it, like every dialog request', () => {
    // The context menu is the picker's second entry point, and it is rendered
    // above the modal: leaving it up would put a menu over the dialog it just
    // opened (the same rule `requestEdit`/`requestDelete` follow)
    useUIStore.getState().openContextMenu({ bookId: 'book-1', x: 10, y: 10 })
    useUIStore.getState().requestCoverPicker('book-1')

    expect(useUIStore.getState().contextMenu).toBeNull()
  })
})

describe('persistedUIState', () => {
  it('is the function the store actually persists through', () => {
    // A source walk, because neither of the behavioural instruments can decide
    // this one: the local `.persist` API zustand attaches is `undefined` in
    // this environment (no `localStorage` in the `node` test env — measured,
    // `useUIStore.persist.getOptions()` is a TypeError), so a case that calls
    // `persistedUIState` decides the *rule* and nothing about its use. Without
    // this, a whole-state `partialize` written inline at the option would leave
    // every case green.
    //
    // Its limit, stated: it proves the wiring sentence, not that zustand calls
    // it — which is why the rule's own case above checks the *output* as a set.
    const source = readFileSync(join(process.cwd(), 'src', 'stores', 'ui.store.ts'), 'utf8')
    expect(source).toMatch(/partialize:\s*persistedUIState\b/)
  })

  it('keeps the view choice and nothing else, whatever is open', () => {
    const ui = useUIStore.getState()
    ui.setViewMode('list')
    ui.requestEdit('book-1')
    ui.requestCoverPicker('book-2')
    ui.requestDelete('book-3')
    ui.openModal('settings')

    const persisted = persistedUIState(useUIStore.getState())

    // By set, not by name: four assertions naming four fields pass while a
    // fifth is written beside them, and a dialog flag that lands here reopens
    // itself on the next launch
    expect(Object.keys(persisted).sort()).toEqual(['viewMode'])
    expect(persisted.viewMode).toBe('list')
  })
})
