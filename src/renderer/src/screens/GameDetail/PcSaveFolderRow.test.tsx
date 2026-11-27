// @vitest-environment jsdom
import type { MetadataLayers } from '@shared/metadata-edit'
import type { PcSaveView } from '@shared/pc-saves'
import type { Game } from '@shared/types'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Edit sheet's Save folder row (PC Saves): shown for a game the user added only, with its folder or Not set, the
 * last copy, and the two answers when a question is open; Choose checks the folder's size first (above 100 MB it asks).
 */

const game = {
  id: 'manual:hk',
  title: 'Hollow Knight',
  source: 'manual',
  hidden: false,
  launch: { kind: 'exec', file: 'C:\\Games\\HK\\hollow_knight.exe', args: [] },
  user: {},
  media: {},
  metadata: {}
} as unknown as Game

const layers: MetadataLayers = {
  key: 'manual-hk',
  scraped: { title: 'Hollow Knight' },
  cloud: null,
  local: {}
}

const view = (patch: Partial<PcSaveView> = {}): PcSaveView => ({
  gameId: game.id,
  featureOn: true,
  folder: null,
  copyDir: null,
  syncedAt: null,
  copyMachine: null,
  pending: false,
  error: null,
  conflict: null,
  confirm: null,
  running: false,
  ...patch
})

const api = vi.hoisted(() => ({
  on: () => () => undefined,
  getMetadataLayers: vi.fn(),
  getSystems: vi.fn(async () => []),
  getPcSaves: vi.fn(),
  chooseFolder: vi.fn(),
  inspectPcSaveFolder: vi.fn(),
  setPcSaveFolder: vi.fn(),
  syncPcSaves: vi.fn(),
  resolvePcSaveConflict: vi.fn(),
  answerPcSaveCopy: vi.fn()
}))

vi.mock('../../api/client', () => ({ api, isMock: false }))

const { initFocus } = await import('../../input/focus')
const { PcSaveFolderRow } = await import('./PcSaveFolderRow')
const { GameEditSheet } = await import('./GameEditSheet')
const { useUiStore } = await import('../../state/ui')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

beforeEach(() => {
  for (const fn of Object.values(api))
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset()
  api.getSystems.mockResolvedValue([])
  api.getMetadataLayers.mockResolvedValue(layers)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useUiStore.setState({ modals: [], toasts: [] })
})

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      for (let j = 0; j < 10; j++) await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
}

const text = (): string => document.body.textContent ?? ''
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label
  )
async function click(el: Element | undefined): Promise<void> {
  if (!el) throw new Error('no such button')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

async function renderRow(v: PcSaveView): Promise<void> {
  api.getPcSaves.mockResolvedValue(v)
  act(() => root.render(<PcSaveFolderRow game={game} focusKey={(n) => `t:${n}`} />))
  await settle()
}

describe('PcSaveFolderRow', () => {
  it('shows Not set, with Copy now and Clear off', async () => {
    await renderRow(view())
    expect(text()).toContain('Save folder')
    expect(text()).toContain('Not set')
    expect(button('Copy the saves now')?.disabled).toBe(true)
    expect(button('Clear the save folder')?.disabled).toBe(true)
  })

  it('shows the folder and its last copy, and copies now', async () => {
    await renderRow(
      view({ folder: 'C:\\Saves\\HK', syncedAt: '2026-11-20T10:00:00Z', copyMachine: 'DESK' })
    )
    expect(text()).toContain('C:\\Saves\\HK')
    expect(text()).toMatch(/Last copied .*DESK/)
    api.syncPcSaves.mockResolvedValue(
      view({ folder: 'C:\\Saves\\HK', syncedAt: '2026-11-26T10:00:00Z' })
    )
    await click(button('Copy the saves now'))
    expect(api.syncPcSaves).toHaveBeenCalledWith(game.id)
  })

  it('offers the two answers of a conflict and of another PC’s copy', async () => {
    await renderRow(
      view({
        folder: 'C:\\Saves\\HK',
        conflict: {
          localAt: '2026-11-20T10:00:00Z',
          cloudAt: '2026-11-21T10:00:00Z',
          cloudDevice: 'DESK'
        }
      })
    )
    expect(text()).toMatch(/pick which to keep/)
    api.resolvePcSaveConflict.mockResolvedValue(view({ folder: 'C:\\Saves\\HK' }))
    await click(button("Keep the Emulation folder's copy"))
    expect(api.resolvePcSaveConflict).toHaveBeenCalledWith(game.id, 'cloud')
    act(() => root.unmount())
    root = createRoot(host)
    await renderRow(
      view({ folder: 'C:\\Saves\\HK', confirm: { machine: 'DESK', title: 'Hollow Knight' } })
    )
    api.answerPcSaveCopy.mockResolvedValue(view({ folder: 'C:\\Saves\\HK' }))
    await click(button('Use that copy'))
    expect(api.answerPcSaveCopy).toHaveBeenCalledWith(game.id, true)
  })

  it('Choose checks the folder first: a small one is set at once, a large one is asked about', async () => {
    await renderRow(view())
    api.chooseFolder.mockResolvedValue('C:\\Saves\\HK')
    api.inspectPcSaveFolder.mockResolvedValue({
      path: 'C:\\Saves\\HK',
      bytes: 2048,
      files: 2,
      large: false
    })
    api.setPcSaveFolder.mockResolvedValue(view({ folder: 'C:\\Saves\\HK' }))
    await click(button('Choose the save folder'))
    expect(api.setPcSaveFolder).toHaveBeenCalledWith(game.id, 'C:\\Saves\\HK')

    api.setPcSaveFolder.mockClear()
    api.inspectPcSaveFolder.mockResolvedValue({
      path: 'C:\\Saves\\Big',
      bytes: 150 * 1024 * 1024,
      files: 300,
      large: true
    })
    await click(button('Choose the save folder'))
    expect(api.setPcSaveFolder).not.toHaveBeenCalled()
    const modal = useUiStore.getState().modals.at(-1) as unknown as {
      type: string
      onConfirm: () => void
    }
    expect(modal?.type).toBe('confirm')
    act(() => modal!.onConfirm())
    await settle()
    expect(api.setPcSaveFolder).toHaveBeenCalledWith(game.id, 'C:\\Saves\\Big')
  })

  it('a refused folder shows main’s reason', async () => {
    await renderRow(view())
    api.chooseFolder.mockResolvedValue('C:\\')
    api.inspectPcSaveFolder.mockRejectedValue(
      new Error(
        "Error invoking remote method 'playout:inspectPcSaveFolder': Error: That folder is too broad."
      )
    )
    await click(button('Choose the save folder'))
    expect(api.setPcSaveFolder).not.toHaveBeenCalled()
    expect(useUiStore.getState().toasts.at(-1)).toMatchObject({
      text: 'That folder is too broad.',
      kind: 'error'
    })
  })
})

describe('the Edit sheet', () => {
  it('has the Save folder row for a game the user added, not for a host’s game', async () => {
    api.getPcSaves.mockResolvedValue(view())
    act(() => root.render(<GameEditSheet game={game} onClose={() => undefined} />))
    await settle()
    expect(text()).toContain('Save folder')
    act(() => root.unmount())
    root = createRoot(host)
    const remote = { ...game, remote: { hostId: 'h', hostName: 'Desk' } } as unknown as Game
    act(() => root.render(<GameEditSheet game={remote} onClose={() => undefined} />))
    await settle()
    expect(text()).not.toContain('Save folder')
  })
})
