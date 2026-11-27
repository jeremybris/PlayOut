// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/** The missing-cover placeholder's sign-in notice: only without a cover and without any sign-in art source. */

vi.mock('../api/client', () => ({
  api: { on: () => () => undefined },
  isMock: false
}))

const { initFocus } = await import('../input/focus')
const { GameCard } = await import('./GameCard')
const { useSettingsStore } = await import('../state/settings')
const { defaultSettings } = await import('@shared/defaults')

import type { Game, Settings } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

function game(patch: Partial<Game> = {}): Game {
  return {
    id: 'rom:snes:x',
    source: 'rom',
    externalId: 'snes/x.sfc',
    platformId: 'snes',
    title: 'Obscure Game',
    sortTitle: 'obscure game',
    installed: true,
    launch: { kind: 'emulator', systemId: 'snes', romPath: 'D:/roms/x.sfc' },
    tracking: { mode: 'spawned' },
    hidden: false,
    favorite: false,
    addedAt: '2026-11-01T00:00:00.000Z',
    metadataStatus: 'done',
    metadata: {},
    media: {},
    user: {},
    ...patch
  } as Game
}

function render(g: Game, settings: Settings | null): HTMLElement {
  useSettingsStore.setState({ settings })
  const host = document.createElement('div')
  root = createRoot(host)
  act(() => root!.render(<GameCard game={g} rowId="test" />))
  return host
}

const noKeys = (): Settings => defaultSettings()
const withKey = (): Settings => {
  const s = defaultSettings()
  s.scrapers.steamgriddb.apiKey = 'fake-key'
  return s
}

describe('GameCard cover sign-in notice', () => {
  it('shows on a cover-less card when no art source is set up', () => {
    const host = render(game(), noKeys())
    const notice = host.querySelector('[data-testid="cover-sign-in"]')
    expect(notice?.textContent).toBe('Sign in for covers · Settings › Metadata')
    expect(notice?.getAttribute('title')).toBe(
      'Sign in to SteamGridDB in Settings › Metadata to get this cover'
    )
    // The title stays on the placeholder.
    expect(host.querySelector('.card__placeholder-title')?.textContent).toBe('Obscure Game')
  })

  it('is absent when an art source is set up', () => {
    expect(render(game(), withKey()).querySelector('[data-testid="cover-sign-in"]')).toBeNull()
  })

  it('is absent when the game has a cover', () => {
    const host = render(game({ media: { cover: 'media://cache/x/cover.jpg' } }), noKeys())
    expect(host.querySelector('[data-testid="cover-sign-in"]')).toBeNull()
  })

  it('is absent for a paired host game and before the settings load', () => {
    const remote = game({ remote: { hostId: 'h', hostName: 'Host' } as Game['remote'] })
    expect(render(remote, noKeys()).querySelector('[data-testid="cover-sign-in"]')).toBeNull()
    act(() => root?.unmount())
    expect(render(game(), null).querySelector('[data-testid="cover-sign-in"]')).toBeNull()
  })
})
