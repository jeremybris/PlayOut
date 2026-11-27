import type { RecompHeldImage, RecompImageOffer } from '@shared/recomp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store subscribes to main's events at import time.
vi.mock('../api/client', () => ({ api: { on: vi.fn(() => () => undefined) } }))

const {
  deleteToSend,
  dismissRecompHeld,
  dismissRecompImageOffer,
  heldAskKey,
  nextRecompHeld,
  recompHeldMessage,
  useRecompHeldStore,
  initialDeleteChoice,
  nextRecompImageOffer,
  originalImageLines,
  recompDeleteOptions,
  recompImageMessage,
  setRecompImageAsking,
  undismissRecompImageOffer,
  useRecompImageStore,
  wantedDeleteChoice
} = await import('./recompImage')

function offer(patch: Partial<RecompImageOffer> = {}): RecompImageOffer {
  return {
    key: 'github:shipa-2/xerenge|d:\\roms\\burnout revenge (usa).iso',
    recompId: 'github:shipa-2/xerenge',
    recompName: 'Xerenge',
    gameId: 'rom:xbox360:x',
    gameTitle: 'Burnout Revenge',
    fileName: 'Burnout Revenge (USA).iso',
    files: ['Burnout Revenge (USA).iso'],
    totalBytes: 7_000_000_000,
    folder: null,
    at: '2026-11-18T10:00:00.000Z',
    ...patch
  }
}

describe('recomp image questions', () => {
  beforeEach(() =>
    useRecompImageStore.setState({ offers: [], dismissed: [], choices: {}, asking: {} })
  )

  it('asks the oldest question not dismissed this session', () => {
    const a = offer({ key: 'a', at: '2026-11-18T11:00:00.000Z' })
    const b = offer({ key: 'b', at: '2026-11-18T09:00:00.000Z' })
    expect(nextRecompImageOffer([a, b], [])).toBe(b)
    expect(nextRecompImageOffer([a, b], ['b'])).toBe(a)
    expect(nextRecompImageOffer([a, b], ['a', 'b'])).toBeNull()
  })

  it('dismisses for the session and brings a question back', () => {
    dismissRecompImageOffer('a')
    dismissRecompImageOffer('a')
    expect(useRecompImageStore.getState().dismissed).toEqual(['a'])
    undismissRecompImageOffer('a')
    expect(useRecompImageStore.getState().dismissed).toEqual([])
  })

  it('says what goes, its size, and that the game stays', () => {
    expect(recompImageMessage(offer(), '6.5 GB')).toBe(
      'Xerenge is ready. Delete the original Burnout Revenge (USA).iso (6.5 GB)? It goes to the Recycle Bin; Burnout Revenge stays in your library and starts the recompilation.'
    )
    expect(
      recompImageMessage(
        offer({
          fileName: 'Game.cue',
          files: ['Game.cue', 'Game (Track 1).bin', 'Game (Track 2).bin']
        }),
        null
      )
    ).toMatch(/^Xerenge is ready\. Delete the original Game\.cue and 2 more files of it\? /)
  })

  it('brings a question back with the choice the page picked', () => {
    undismissRecompImageOffer('a', 'delete-folder')
    expect(useRecompImageStore.getState().choices).toEqual({ a: 'delete-folder' })
  })

  it('opens a question sent before the ask replies with the choice the page picked', () => {
    const o = offer({ key: 'a' })
    undismissRecompImageOffer('a', 'delete')
    setRecompImageAsking(o.recompId, 'delete-folder')
    // The question arrives before the reply: the page's new choice wins over an older one.
    expect(wantedDeleteChoice(useRecompImageStore.getState(), o)).toBe('delete-folder')
    undismissRecompImageOffer('a', 'delete-folder')
    setRecompImageAsking(o.recompId, null)
    expect(useRecompImageStore.getState().asking).toEqual({})
    expect(wantedDeleteChoice(useRecompImageStore.getState(), o)).toBe('delete-folder')
    expect(wantedDeleteChoice(useRecompImageStore.getState(), offer({ key: 'b' }))).toBeUndefined()
  })

  it('sends only the choice the player picked while the question still offers it', () => {
    const both = recompDeleteOptions({ fileName: 'BR.iso', folder })
    const folderOnly = recompDeleteOptions({ fileName: null, folder })
    expect(deleteToSend(both, 'delete')).toBe('delete')
    // The image part went while the dialog was open: Delete must not turn into deleting the folder.
    expect(deleteToSend(folderOnly, 'delete')).toBeNull()
    expect(deleteToSend(folderOnly, 'delete-both')).toBeNull()
    expect(deleteToSend(folderOnly, 'delete-folder')).toBe('delete-folder')
  })

  const folder = { path: 'C:/Users/me/Games/Burnout Revenge/game', totalBytes: 7e9, kept: false }

  it('offers the dropdown entries for what may go, the disc image first', () => {
    expect(recompDeleteOptions({ fileName: 'BR.iso', folder: null }).map((o) => o.value)).toEqual([
      'delete'
    ])
    expect(recompDeleteOptions({ fileName: null, folder }).map((o) => o.value)).toEqual([
      'delete-folder'
    ])
    const both = recompDeleteOptions({ fileName: 'BR.iso', folder })
    expect(both.map((o) => o.label)).toEqual([
      'Delete the disc image',
      'Delete the unpacked game folder',
      'Delete both'
    ])
    expect(initialDeleteChoice(both)).toBe('delete')
    expect(initialDeleteChoice(both, 'delete-both')).toBe('delete-both')
    expect(initialDeleteChoice(recompDeleteOptions({ fileName: null, folder }), 'delete')).toBe(
      'delete-folder'
    )
  })

  it('names the unpacked folder, its size, and what a reinstall needs', () => {
    expect(
      recompImageMessage(offer({ folder }), '6.5 GB', '6.5 GB').endsWith(
        'starts the recompilation. The copy PlayOut unpacked for the setup program, C:/Users/me/Games/Burnout Revenge/game (6.5 GB), is no longer used either: pick what to delete.'
      )
    ).toBe(true)
    expect(
      recompImageMessage(
        offer({ fileName: null, files: [], totalBytes: null, folder }),
        null,
        '6.5 GB'
      )
    ).toBe(
      'Xerenge no longer uses the copy of Burnout Revenge PlayOut unpacked for its setup program: C:/Users/me/Games/Burnout Revenge/game (6.5 GB). Delete it? It goes to the Recycle Bin; installing the game again with the setup unpacks it again from the disc image.'
    )
  })

  it('describes what the Delete… of the page and Settings lets go, and a keep answered before', () => {
    const folder = { path: 'C:/Games/Burnout Revenge/game', totalBytes: 3, kept: true }
    const lines = originalImageLines(
      'Xerenge',
      { recompId: 'x', fileName: 'Burnout Revenge (USA).iso', kept: false, folder },
      '3 B'
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(
      'Xerenge no longer needs Burnout Revenge (USA).iso. You can move it to the Recycle Bin; the game stays in your library and starts the recompilation.'
    )
    expect(lines[1]).toContain('C:/Games/Burnout Revenge/game (3 B).')
    expect(lines[1]).toMatch(/You chose to keep it before\.$/)
    expect(
      originalImageLines('Xerenge', { recompId: 'x', fileName: 'a.iso', kept: true }, null)
    ).toEqual([expect.stringMatching(/a\.iso\..*You chose to keep it before\.$/)])
  })
})

describe('the test run after Delete: held images', () => {
  const item = (patch: Partial<RecompHeldImage> = {}): RecompHeldImage => ({
    holdId: 'm3x9k2-4f7a1c',
    recompId: 'github:shipa-2/xerenge',
    recompName: 'Xerenge',
    gameId: 'rom:xbox360:x',
    gameTitle: 'Burnout Revenge',
    fileName: 'Burnout Revenge (USA).iso',
    files: ['Burnout Revenge (USA).iso'],
    folder: null,
    state: 'crashed',
    reason: 'Xerenge closed 3 s after it started (exit code 3221225477)',
    at: '2026-11-18T10:00:00.000Z',
    decidedAt: '2026-11-18T10:00:03.000Z',
    ...patch
  })

  beforeEach(() => useRecompHeldStore.setState({ items: [], dismissed: [] }))

  it('asks the oldest verdict, never one still testing, and Not now only until the next verdict', () => {
    const testing = item({
      holdId: 'aaaaaa-000001',
      state: 'testing',
      at: '2026-11-18T09:00:00.000Z'
    })
    const crashed = item()
    expect(nextRecompHeld([testing, crashed], [])).toBe(crashed)
    dismissRecompHeld(crashed)
    const { dismissed } = useRecompHeldStore.getState()
    expect(dismissed).toEqual([heldAskKey(crashed)])
    expect(nextRecompHeld([testing, crashed], dismissed)).toBeNull()
    // Test again gave a new verdict: asked again.
    const again = item({ state: 'not-tested', decidedAt: '2026-11-18T11:00:00.000Z' })
    expect(nextRecompHeld([again], dismissed)).toBe(again)
  })

  it('says a crash was detected and that the recompilation may need the image', () => {
    const { title, message } = recompHeldMessage(item())
    expect(title).toBe('Restore the disc image?')
    expect(message).toBe(
      'Xerenge closed 3 s after it started (exit code 3221225477). A crash was detected: Xerenge may need the original Burnout Revenge (USA).iso. Restore it? It goes back where it was and Burnout Revenge is an ordinary game card again. Delete anyway moves it to the Recycle Bin.'
    )
  })

  it('words a start refused for another reason, and an unfinished check, neutrally', () => {
    const refused = recompHeldMessage(
      item({ state: 'not-tested', reason: 'Xerenge is already running.' })
    )
    expect(refused.title).toBe('Could not check the disc image')
    expect(refused.message).toContain('could not start Xerenge')
    expect(refused.message).toContain('Xerenge is already running. It is kept aside')
    expect(refused.message).not.toContain('crash')
    const interrupted = recompHeldMessage(item({ state: 'interrupted', reason: null }))
    expect(interrupted.title).toBe('Finish checking the disc image?')
    expect(interrupted.message).toContain('did not finish (PlayOut closed)')
    const folder = recompHeldMessage(
      item({ fileName: null, folder: 'C:\\Games\\Burnout Revenge\\game', files: ['game'] })
    )
    expect(folder.title).toBe('Restore the game folder?')
    expect(folder.message).not.toContain('game card')
  })
})
