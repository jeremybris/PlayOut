// @vitest-environment jsdom
import { readFileSync } from 'fs'
import { join } from 'path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/defaults'
import type { SettingsPatch } from '@shared/types'

/**
 * Settings › Convert holds the two "new games" switches: Trim Games (moved from Settings › Library, same setting) and
 * Compress games automatically right under it (off by default).
 */

vi.mock('../../../api/client', () => {
  const known: Record<string, unknown> = {
    on: () => () => undefined,
    getConvertStatus: () => new Promise(() => undefined),
    getSystems: () => Promise.resolve([]),
    checkConvert: () => Promise.resolve([])
  }
  // Anything else Settings › Library asks for (sources, Co-Op, tabs...) never answers.
  const api = new Proxy(known, {
    get: (target, name: string) => target[name] ?? (() => new Promise(() => undefined))
  })
  return { api, isMock: false }
})

const { initFocus, doesFocusableExist, setFocus, focusedKey } = await import('../../../input/focus')
const { ConvertSection } = await import('./Convert')
const { LibrarySection } = await import('./Library')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(patch: (p: SettingsPatch) => void = () => undefined, trim = false): void {
  const settings = defaultSettings()
  settings.library.trimGames = trim
  act(() => root.render(<ConvertSection settings={settings} patch={patch} />))
}

describe('Settings › Convert new-games switches', () => {
  it('shows Trim Games, then Compress games automatically right under it, both off by default', () => {
    render()
    const switches = [...host.querySelectorAll('[role="switch"]')]
    const labels = switches.map((s) => s.getAttribute('aria-label') ?? '')
    const trim = labels.findIndex((l) => l.includes('Trim Games'))
    const compress = labels.findIndex((l) => l.includes('Compress games automatically'))
    expect(trim).toBeGreaterThanOrEqual(0)
    expect(compress).toBe(trim + 1)
    expect(switches[trim]!.getAttribute('aria-checked')).toBe('false')
    expect(switches[compress]!.getAttribute('aria-checked')).toBe('false')
  })

  it('the switches write library.trimGames and library.autoCompressGames', () => {
    const patches: SettingsPatch[] = []
    render((p) => patches.push(p), true)
    const switches = [...host.querySelectorAll<HTMLElement>('[role="switch"]')]
    expect(switches[0]!.getAttribute('aria-checked')).toBe('true')
    act(() => switches[0]!.click())
    act(() => switches[1]!.click())
    expect(patches).toEqual([
      { library: { trimGames: false } },
      { library: { autoCompressGames: true } }
    ])
  })

  it('Trim Games left Settings › Library', () => {
    const source = readFileSync(join(__dirname, 'Library.tsx'), 'utf8')
    expect(source).not.toMatch(/trimGames|autoCompressGames/)
    act(() => root.render(<LibrarySection settings={defaultSettings()} patch={() => undefined} />))
    const labels = [...host.querySelectorAll('[role="switch"]')].map(
      (s) => s.getAttribute('aria-label') ?? ''
    )
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.some((l) => /Trim Games|Compress games automatically/.test(l))).toBe(false)
    expect(doesFocusableExist('settings:library:trimGames')).toBe(false)
  })

  it('the controller reaches both switches by their Settings › Convert focus keys', () => {
    render()
    expect(doesFocusableExist('settings:convert:trimGames')).toBe(true)
    expect(doesFocusableExist('settings:convert:autoCompressGames')).toBe(true)
    act(() => setFocus('settings:convert:autoCompressGames'))
    expect(focusedKey()).toBe('settings:convert:autoCompressGames')
  })
})
