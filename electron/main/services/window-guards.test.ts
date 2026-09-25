import { describe, expect, it } from 'vitest'
import { isExternalUrlAllowed, isInAppNavigation } from './window-guards'

describe('isExternalUrlAllowed', () => {
  it.each(['https://openlibrary.org/x', 'http://example.com', 'mailto:a@b.c'])('allows %s', (u) =>
    expect(isExternalUrlAllowed(u)).toBe(true)
  )
  it.each([
    'file:///etc/passwd',
    'musaeum://book/x',
    'javascript:alert(1)',
    'smb://nas/x',
    'not a url',
    ''
  ])('refuses %s', (u) => expect(isExternalUrlAllowed(u)).toBe(false))
})

describe('isInAppNavigation', () => {
  it('allows the dev server reloading itself', () =>
    expect(isInAppNavigation('http://localhost:5173/#/x', 'http://localhost:5173/')).toBe(true))
  it('allows file: to file: (the packaged renderer)', () =>
    expect(isInAppNavigation('file:///A/index.html', 'file:///A/index.html#x')).toBe(true))
  it('refuses a remote origin', () =>
    expect(isInAppNavigation('https://evil.example/', 'http://localhost:5173/')).toBe(false))
  it('refuses a remote page from a packaged window', () =>
    expect(isInAppNavigation('https://evil.example/', 'file:///A/index.html')).toBe(false))
  it('refuses garbage', () => expect(isInAppNavigation('::::', 'file:///A/index.html')).toBe(false))
})
