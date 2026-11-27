import type { Game, LocalDeletePlan } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({
  api: {
    on: vi.fn(() => () => undefined),
    getLocalDeletePlan: vi.fn(),
    deleteGameLocally: vi.fn(),
    removeGame: vi.fn()
  }
}))
vi.mock('../api/client', () => ({ api }))

const { canDeleteLocally, localDeleteMessage, startLocalDelete } = await import('./localDelete')
const { useUiStore } = await import('./ui')
const { useLibraryStore } = await import('./library')

const game = { id: 'rom:a', installed: true, title: 'Game A', user: {} } as unknown as Game

describe('canDeleteLocally', () => {
  it('offers it only for an installed game of this PC that nothing runs or downloads', () => {
    expect(canDeleteLocally(game)).toBe(true)
    expect(canDeleteLocally({ ...game, installed: false })).toBe(false)
    expect(canDeleteLocally({ ...game, id: 'remote:h:rom:a' })).toBe(false)
    expect(canDeleteLocally({ ...game, remote: {} as never })).toBe(false)
    expect(canDeleteLocally(game, { runningId: 'rom:a' })).toBe(false)
    expect(canDeleteLocally(game, { runningId: 'rom:b' })).toBe(true)
    expect(canDeleteLocally(game, { queued: true })).toBe(false)
    expect(canDeleteLocally(undefined)).toBe(false)
  })
})

describe('localDeleteMessage', () => {
  it('names the files, their size and what stays', () => {
    const plan: LocalDeletePlan = {
      gameId: 'rom:a',
      kind: 'files',
      paths: ['D:\\roms\\psx\\A.cue', 'D:\\roms\\psx\\A.bin'],
      totalBytes: 2048,
      kept: ['D:\\roms\\psx\\Shared.bin']
    }
    const text = localDeleteMessage(plan, 'Game A', [
      { hostName: 'Den PC', downloadable: true, streamable: true }
    ])
    expect(text).toContain('Recycle Bin')
    expect(text).toContain('D:\\roms\\psx\\A.bin')
    expect(text).toContain('2 files')
    expect(text).toContain('Shared.bin')
    expect(text).toMatch(/saves are not touched/)
    expect(text).toContain('Den PC keeps its copy; it shows as Download here.')
  })

  it('says the store asks and the account is not affected', () => {
    const text = localDeleteMessage(
      { gameId: 'steam:1', kind: 'store', paths: [], storeName: 'Steam' },
      'Portal'
    )
    expect(text).toContain('Steam will ask to uninstall Portal')
    expect(text).toMatch(/store account/)
  })

  it('says only Windows Settings opens for an Xbox game', () => {
    const text = localDeleteMessage(
      { gameId: 'xbox:a', kind: 'store', paths: [], storeName: 'Xbox', opens: 'settings' },
      'Halo'
    )
    expect(text).toContain('Windows Settings opens on Apps: uninstall Halo from Apps there')
    expect(text).not.toMatch(/will ask to uninstall/)
  })

  it('offers streaming, not Download here, when the host copy cannot be downloaded', () => {
    const text = localDeleteMessage(
      { gameId: 'manual:a', kind: 'uninstaller', paths: ['D:/A/unins000.exe'] },
      'Game A',
      [{ hostName: 'Den PC', downloadable: false, streamable: true }]
    )
    expect(text).toContain('You can still stream it from Den PC.')
    expect(text).not.toMatch(/Download here/)
    expect(text).toMatch(/leaves your library once it is uninstalled/)
  })

  it("says a manual game's folder goes whole, saves included", () => {
    const text = localDeleteMessage(
      { gameId: 'manual:a', kind: 'files', paths: ['D:/Games/A'], folder: true },
      'Game A'
    )
    expect(text).toMatch(/saves included, goes to the Recycle Bin/)
    expect(text).not.toMatch(/saves are not touched/)
  })

  it('lists the updates and DLC with their size', () => {
    const update = 'E:\\Emulation\\Updates and DLC\\PS3\\dev_hdd0\\game\\BLUS30443'
    const text = localDeleteMessage(
      {
        gameId: 'rom:a',
        kind: 'files',
        paths: ['D:\\roms\\ps3\\A.ps3'],
        totalBytes: 10,
        updatesDlc: { paths: [update, `${update}DATA`], totalBytes: 3 * 1024 ** 3 }
      },
      'Game A'
    )
    expect(text).toContain(`Its updates and DLC (3.0 GB):\n${update}\n${update}DATA`)
    // Unknown size: no size; more than six: the rest counted.
    const many = Array.from({ length: 8 }, (_, i) => `E:\\U\\${i}.nsp`)
    const long = localDeleteMessage(
      { gameId: 'rom:a', kind: 'files', paths: ['D:\\roms\\A.nsp'], updatesDlc: { paths: many } },
      'Game A'
    )
    expect(long).toContain('Its updates and DLC:\nE:\\U\\0.nsp')
    expect(long).toContain('E:\\U\\5.nsp\n… and 2 more')
    expect(long).not.toContain('E:\\U\\6.nsp')
    // None: not mentioned.
    expect(
      localDeleteMessage({ gameId: 'rom:a', kind: 'files', paths: ['D:\\roms\\A.nsp'] }, 'Game A')
    ).not.toMatch(/updates and DLC/)
  })
})

describe('startLocalDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUiStore.setState({ modals: [], toasts: [] })
  })

  it("shows main's refusal as an error toast and opens nothing", async () => {
    api.getLocalDeletePlan.mockResolvedValue({
      gameId: 'rom:a',
      kind: 'refused',
      reason: 'Game A is running. Quit it first.',
      paths: []
    })
    await startLocalDelete(game)
    expect(useUiStore.getState().modals).toHaveLength(0)
    expect(useUiStore.getState().toasts[0]).toMatchObject({
      text: 'Game A is running. Quit it first.',
      kind: 'error'
    })
  })

  it('deletes on confirm, drops the record and closes the panel', async () => {
    api.getLocalDeletePlan.mockResolvedValue({
      gameId: 'rom:a',
      kind: 'files',
      paths: ['D:\\roms\\A.iso'],
      totalBytes: 1
    })
    api.deleteGameLocally.mockResolvedValue({
      ok: true,
      kind: 'files',
      removed: true,
      message: 'Moved Game A to the Recycle Bin'
    })
    const removeGame = vi.spyOn(useLibraryStore.getState(), 'removeGame')
    const onRemoved = vi.fn()
    await startLocalDelete(game, onRemoved)
    const modal = useUiStore.getState().modals.at(-1) as unknown as {
      type: string
      danger: boolean
      onConfirm: (optionChecked: boolean) => void
      option?: unknown
    }
    expect(modal).toMatchObject({ type: 'confirm', danger: true })
    // No updates and DLC: no switch, and none deleted whatever the dialog passes.
    expect(modal.option).toBeUndefined()
    modal.onConfirm(true)
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalled())
    expect(api.deleteGameLocally).toHaveBeenCalledWith('rom:a', { updatesDlc: false })
    expect(removeGame).toHaveBeenCalledWith('rom:a')
  })

  it("offers to delete the game's updates and DLC, ticked, and passes the choice on", async () => {
    api.getLocalDeletePlan.mockResolvedValue({
      gameId: 'rom:a',
      kind: 'files',
      paths: ['D:\\roms\\A.ps3'],
      totalBytes: 1,
      updatesDlc: { paths: ['E:\\Emulation\\Updates and DLC\\PS3\\dev_hdd0\\game\\BLUS30443'] }
    })
    api.deleteGameLocally.mockResolvedValue({
      ok: true,
      kind: 'files',
      removed: true,
      message: 'Moved Game A and its updates and DLC to the Recycle Bin'
    })
    const modalOf = (): {
      onConfirm: (optionChecked: boolean) => void
      option?: { label: string; checked: boolean }
      message: string
    } => useUiStore.getState().modals.at(-1) as never
    await startLocalDelete(game)
    expect(modalOf().option).toMatchObject({
      label: 'Also delete its updates and DLC',
      checked: true
    })
    expect(modalOf().message).toContain('Its updates and DLC')
    modalOf().onConfirm(true)
    await vi.waitFor(() =>
      expect(api.deleteGameLocally).toHaveBeenCalledWith('rom:a', { updatesDlc: true })
    )

    api.deleteGameLocally.mockClear()
    useUiStore.setState({ modals: [] })
    await startLocalDelete(game)
    modalOf().onConfirm(false)
    await vi.waitFor(() =>
      expect(api.deleteGameLocally).toHaveBeenCalledWith('rom:a', { updatesDlc: false })
    )
  })

  it('names the Settings button for Xbox and keeps the record after the uninstaller opens', async () => {
    api.getLocalDeletePlan.mockResolvedValue({
      gameId: 'xbox:a',
      kind: 'store',
      paths: [],
      storeName: 'Xbox',
      opens: 'settings'
    })
    await startLocalDelete(game)
    expect(useUiStore.getState().modals.at(-1)).toMatchObject({
      confirmLabel: 'Open Windows Settings'
    })
    api.getLocalDeletePlan.mockResolvedValue({
      gameId: 'rom:a',
      kind: 'uninstaller',
      paths: ['D:/A/unins000.exe']
    })
    api.deleteGameLocally.mockResolvedValue({
      ok: true,
      kind: 'uninstaller',
      removed: false,
      message: "Game A's uninstaller is open"
    })
    const removeGame = vi.spyOn(useLibraryStore.getState(), 'removeGame')
    const onRemoved = vi.fn()
    await startLocalDelete(game, onRemoved)
    const modal = useUiStore.getState().modals.at(-1) as unknown as { onConfirm: () => void }
    modal.onConfirm()
    await vi.waitFor(() =>
      expect(useUiStore.getState().toasts.at(-1)).toMatchObject({
        text: "Game A's uninstaller is open"
      })
    )
    expect(removeGame).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('offers only Remove from library when nothing can be deleted safely', async () => {
    api.getLocalDeletePlan.mockResolvedValue({
      gameId: 'manual:a',
      kind: 'remove-only',
      reason: 'The game is at the top of a drive',
      paths: []
    })
    await startLocalDelete(game)
    const modal = useUiStore.getState().modals.at(-1) as unknown as {
      title: string
      message: string
    }
    expect(modal.title).toBe('Remove from library')
    expect(modal.message).toContain('top of a drive')
    expect(api.deleteGameLocally).not.toHaveBeenCalled()
  })
})
