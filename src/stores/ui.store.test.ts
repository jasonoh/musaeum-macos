import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { persistedUIState, useUIStore } from './ui.store'
import { EMPTY_SELECTION, applyClick, selectedId, type Selection } from '@/lib/selection'

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

const PLAIN = { toggle: false, range: false }
const TOGGLE = { toggle: true, range: false }
const ORDER = ['book-1', 'book-2', 'book-7']

/** A two-book selection — the scope the menu's bulk items apply to. */
function twoBooks(): Selection {
  return applyClick(applyClick(EMPTY_SELECTION, 'book-1', PLAIN, ORDER), 'book-2', TOGGLE, ORDER)
}

/**
 * A right-click opens the menu and does nothing else.
 *
 * The mechanism of the owner's report (2026-09-25, the grid): the action used
 * to make the clicked book the selection first, and `BookDetail` renders from
 * the derived single selection — so a right-click opened the details panel
 * *beside* the menu. What the menu then offers for the click is
 * `contextMenuScope`'s, decided in `src/lib/selection.test.ts`.
 */
describe('the context menu', () => {
  it('opens for the clicked book without selecting it', () => {
    useUIStore.setState({ selection: EMPTY_SELECTION })
    useUIStore.getState().openContextMenu({ bookId: 'book-7', x: 10, y: 10 })

    const s = useUIStore.getState()
    expect(s.contextMenu?.bookId).toBe('book-7')
    // Both readings of "it selected something": the set, and the derived single
    // selection the details panel is mounted from
    expect([...s.selection.ids]).toEqual([])
    expect(selectedId(s.selection)).toBeNull()
  })

  it('leaves a selection the click landed outside of untouched', () => {
    const selection = twoBooks()
    useUIStore.setState({ selection })

    useUIStore.getState().openContextMenu({ bookId: 'book-7', x: 10, y: 10 })

    // The same object, so nothing downstream of the selection re-rendered —
    // the grid does not even re-flow
    expect(useUIStore.getState().selection).toBe(selection)
    expect([...selection.ids].sort()).toEqual(['book-1', 'book-2'])
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
