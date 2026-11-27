import type { InstallProgress, InstallQueueEntry } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store subscribes at import time: capture its listeners so the tests can play main's events.
const { listeners, api } = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const api = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    }),
    getInstallQueue: vi.fn(),
    removeFromInstallQueue: vi.fn(),
    moveInInstallQueue: vi.fn(),
    pauseInstall: vi.fn(),
    resumeInstall: vi.fn()
  }
  return { listeners, api }
})
vi.mock('../api/client', () => ({ api }))

const {
  isInstalledHere,
  queueAllPaused,
  queuePaused,
  queuePausedText,
  queueSummary,
  queueMoveFocusPart,
  queueWaitingFor,
  romDownloadToastText,
  queuePlaceText,
  queuePosition,
  queueStarting,
  queuedToastText,
  queueBusyWithOther,
  useInstallQueueStore
} = await import('./installQueue')
const { installStalled, useInstallsStore } = await import('./installs')
const { useUiStore } = await import('./ui')

const entry = (
  gameId: string,
  state: InstallQueueEntry['state'],
  kind: InstallQueueEntry['kind'] = 'store'
): InstallQueueEntry => ({
  gameId,
  title: gameId.toUpperCase(),
  kind,
  source: kind === 'store' ? 'steam' : 'host',
  from: kind === 'store' ? 'Steam' : 'Living Room PC',
  state,
  addedAt: '2026-11-13T00:00:00.000Z'
})

const toasts = (): string[] => useUiStore.getState().toasts.map((t) => `${t.kind}:${t.text}`)

beforeEach(() => {
  vi.clearAllMocks()
  useInstallQueueStore.setState({ entries: [] })
  useUiStore.setState({ toasts: [] })
})

describe('install queue store', () => {
  it('mirrors getInstallQueue and every installs:queue event', async () => {
    api.getInstallQueue.mockResolvedValue([entry('a', 'active')])
    await useInstallQueueStore.getState().refresh()
    expect(useInstallQueueStore.getState().entries.map((e) => e.gameId)).toEqual(['a'])
    listeners.get('installs:queue')!([entry('b', 'active'), entry('c', 'waiting')])
    expect(useInstallQueueStore.getState().entries.map((e) => e.gameId)).toEqual(['b', 'c'])
  })

  it('numbers the places: 0 for the active game, 1 for the next, null when not queued', () => {
    const entries = [entry('a', 'active'), entry('b', 'waiting'), entry('c', 'waiting')]
    expect(queuePosition(entries, 'a')).toBe(0)
    expect(queuePosition(entries, 'b')).toBe(1)
    expect(queuePosition(entries, 'c')).toBe(2)
    expect(queuePosition(entries, 'x')).toBeNull()
    // A game installed on this PC is never queued, whatever the queue still says: it keeps Play.
    expect(queuePosition(entries, 'a', true)).toBeNull()
    expect(queuePosition(entries, 'b', true)).toBeNull()
    expect(isInstalledHere({ installed: true })).toBe(true)
    expect(isInstalledHere({ installed: true, remote: { hostId: 'h' } })).toBe(false)
    expect(isInstalledHere({ installed: false })).toBe(false)
    expect(isInstalledHere(undefined)).toBe(false)
    // Between two downloads nothing is active yet: the first waiting game is still next.
    expect(queuePosition([entry('b', 'waiting')], 'b')).toBe(1)
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(queuePlaceText)).toEqual([
      'Next in line',
      '2nd in line',
      '3rd in line',
      '4th in line',
      '11th in line',
      '12th in line',
      '13th in line',
      '21st in line',
      '22nd in line'
    ])
  })

  it('names the download a queued game waits for', () => {
    useInstallQueueStore.setState({ entries: [entry('a', 'active'), entry('b', 'waiting')] })
    expect(queuedToastText('B', 'b')).toBe('B is queued; it starts after A')
    expect(queueBusyWithOther('b')).toBe(true)
    expect(queueBusyWithOther('a')).toBe(false)
    useInstallQueueStore.setState({ entries: [] })
    expect(queueBusyWithOther('b')).toBe(false)
  })

  it('stopping the active store install forgets its progress and says the store may keep going', async () => {
    api.removeFromInstallQueue.mockResolvedValue(undefined)
    useInstallQueueStore.setState({ entries: [entry('a', 'active'), entry('b', 'waiting')] })
    useInstallsStore.setState({
      installs: new Map([['a', { gameId: 'a', state: 'downloading' } as InstallProgress]])
    })

    await useInstallQueueStore.getState().remove('b')
    expect(api.removeFromInstallQueue).toHaveBeenCalledWith('b')
    expect(toasts()).toEqual([])

    await useInstallQueueStore.getState().remove('a')
    expect(useInstallsStore.getState().installs.has('a')).toBe(false)
    expect(toasts()).toEqual([
      'info:Stopped tracking the install of A. Steam keeps downloading it.'
    ])
  })

  it('says the store keeps downloading even when the queue event dropped the bar before the answer', async () => {
    // Main sends 'installs:queue' before removeFromInstallQueue resolves; its listener drops the running bar.
    api.removeFromInstallQueue.mockImplementation(async () => {
      listeners.get('installs:queue')!([])
    })
    useInstallQueueStore.setState({ entries: [entry('a', 'active')] })
    useInstallsStore.setState({
      installs: new Map([['a', { gameId: 'a', state: 'downloading' } as InstallProgress]])
    })
    await useInstallQueueStore.getState().remove('a')
    expect(useInstallsStore.getState().installs.has('a')).toBe(false)
    expect(toasts()).toEqual([
      'info:Stopped tracking the install of A. Steam keeps downloading it.'
    ])
  })

  it('reads why a waiting game is held back, and toasts a ROM download from the queue it left', () => {
    const held: InstallQueueEntry = {
      ...entry('r', 'waiting', 'host-rom'),
      waitingFor: 'Waiting for Living Room PC to come back online'
    }
    useInstallQueueStore.setState({ entries: [entry('a', 'active'), held] })
    expect(queueWaitingFor(useInstallQueueStore.getState().entries, 'r')).toBe(held.waitingFor)
    expect(queueWaitingFor(useInstallQueueStore.getState().entries, 'a')).toBeUndefined()
    expect(romDownloadToastText('R', 'r', 'Living Room PC')).toBe(held.waitingFor)

    useInstallQueueStore.setState({
      entries: [entry('a', 'active'), entry('r', 'waiting', 'host-rom')]
    })
    expect(romDownloadToastText('R', 'r', 'Living Room PC')).toBe('R is queued; it starts after A')

    useInstallQueueStore.setState({ entries: [entry('r', 'active', 'host-rom')] })
    expect(romDownloadToastText('R', 'r', 'Living Room PC')).toBe(
      'Downloading R from Living Room PC…'
    )
    // Not listed (it ended at once): read as started.
    useInstallQueueStore.setState({ entries: [] })
    expect(romDownloadToastText('R', 'r')).toBe('Downloading R…')
  })

  it('removing a store install that never reported progress ("Starting…") says it was cancelled', async () => {
    api.removeFromInstallQueue.mockResolvedValue(undefined)
    useInstallQueueStore.setState({ entries: [entry('a', 'active')] })
    useInstallsStore.setState({ installs: new Map() })
    await useInstallQueueStore.getState().remove('a')
    expect(toasts()).toEqual(['info:Cancelled the install of A'])

    // An earlier attempt that failed counts as no progress too.
    useUiStore.setState({ toasts: [] })
    useInstallQueueStore.setState({ entries: [entry('b', 'active')] })
    useInstallsStore.setState({
      installs: new Map([['b', { gameId: 'b', state: 'failed' } as InstallProgress]])
    })
    await useInstallQueueStore.getState().remove('b')
    expect(toasts()).toEqual(['info:Cancelled the install of B'])
  })

  it('drops the bar of a store install stopped from the other window, keeps a finished one', () => {
    const progress = (gameId: string, state: InstallProgress['state']): InstallProgress =>
      ({ gameId, state }) as InstallProgress
    useInstallQueueStore.setState({ entries: [entry('a', 'active'), entry('b', 'waiting')] })
    useInstallsStore.setState({ installs: new Map([['a', progress('a', 'downloading')]]) })
    listeners.get('installs:queue')!([entry('b', 'active')])
    expect(useInstallsStore.getState().installs.has('a')).toBe(false)

    // Ended on its own: 'done' arrived first and stays for the panel.
    useInstallsStore.setState({ installs: new Map([['b', progress('b', 'done')]]) })
    listeners.get('installs:queue')!([])
    expect(useInstallsStore.getState().installs.get('b')?.state).toBe('done')
  })

  it('toasts a failed change instead of throwing', async () => {
    api.moveInInstallQueue.mockRejectedValue(new Error('nope'))
    await useInstallQueueStore.getState().move('b', -1)
    expect(api.moveInInstallQueue).toHaveBeenCalledWith('b', -1)
    expect(toasts()).toEqual(['error:nope'])
  })
})

describe('pausing', () => {
  const paused = (e: InstallQueueEntry): InstallQueueEntry => ({ ...e, paused: true })

  it('pauses one game or all; only an active store install that was not paused yet toasts where to pause it', async () => {
    api.pauseInstall.mockResolvedValue(undefined)
    useInstallQueueStore.setState({
      entries: [entry('a', 'active'), entry('b', 'waiting'), entry('r', 'waiting', 'host-rom')]
    })
    await useInstallQueueStore.getState().pause('b')
    expect(api.pauseInstall).toHaveBeenCalledWith('b')
    expect(toasts()).toEqual([])
    await useInstallQueueStore.getState().pause(null)
    expect(api.pauseInstall).toHaveBeenLastCalledWith(null)
    expect(toasts()).toEqual(['info:Steam keeps downloading A until you pause it there too'])
    // Already paused: no second toast.
    useInstallQueueStore.setState({ entries: [paused(entry('a', 'active'))] })
    await useInstallQueueStore.getState().pause('a')
    expect(toasts()).toHaveLength(1)
  })

  it('resumes one game or all, and toasts a failed call instead of throwing', async () => {
    api.resumeInstall.mockResolvedValue(undefined)
    await useInstallQueueStore.getState().resume(null)
    expect(api.resumeInstall).toHaveBeenCalledWith(null)
    api.pauseInstall.mockRejectedValue(new Error('boom'))
    api.resumeInstall.mockRejectedValue(new Error('boom'))
    useInstallQueueStore.setState({ entries: [entry('a', 'active')] })
    await useInstallQueueStore.getState().pause('a')
    await useInstallQueueStore.getState().resume('a')
    expect(toasts().every((t) => t.startsWith('error:'))).toBe(true)
    expect(toasts()).toHaveLength(2)
  })

  it('reads paused games, all paused, and the paused note', () => {
    const entries = [entry('a', 'active'), paused(entry('b', 'waiting'))]
    expect(queuePaused(entries, 'b')).toBe(true)
    expect(queuePaused(entries, 'a')).toBe(false)
    expect(queuePaused(entries, 'x')).toBe(false)
    expect(queueAllPaused(entries)).toBe(false)
    expect(queueAllPaused(entries.map(paused))).toBe(true)
    expect(queueAllPaused([])).toBe(false)
    expect(queuePausedText(entry('r', 'waiting', 'host-rom'), 41.6)).toBe('Paused at 42%')
    expect(queuePausedText(entry('b', 'waiting'))).toBe('Paused')
    expect(queuePausedText(entry('a', 'active'), null)).toBe('Paused · also pause it in Steam')
    expect(queuePausedText(entry('a', 'active'), 30)).toBe('Paused · also pause it in Steam')
  })

  it('summarizes the queue for the system bar: no percent once the active (or, with none, every) game is paused', () => {
    expect(queueSummary([entry('a', 'active'), entry('b', 'waiting')], 41.6)).toEqual({
      text: '42%',
      label: 'Downloading A (42%), 1 waiting',
      paused: false
    })
    expect(queueSummary([paused(entry('a', 'active')), entry('b', 'waiting')], 41.6)).toEqual({
      text: undefined,
      label: 'A paused, 1 waiting',
      paused: true
    })
    expect(queueSummary([paused(entry('r', 'waiting', 'host-rom'))], null)).toEqual({
      text: undefined,
      label: 'Downloads paused, 1 waiting',
      paused: true
    })
    // Nothing active but a game not paused (held back, about to start): not paused.
    expect(queueSummary([paused(entry('r', 'waiting')), entry('b', 'waiting')], null)).toEqual({
      text: undefined,
      label: 'Downloads, 2 waiting',
      paused: false
    })
  })
})

describe('queueMoveFocusPart', () => {
  const queue = [
    entry('a', 'active'),
    entry('b', 'waiting'),
    entry('c', 'waiting'),
    entry('d', 'waiting')
  ]

  it('keeps the pressed arrow while it is still enabled', () => {
    expect(queueMoveFocusPart(queue, 'c', 'up')).toBe('up')
    expect(queueMoveFocusPart(queue, 'c', 'down')).toBe('down')
  })

  it('moves to the other arrow once the pressed one turned disabled at the top or the bottom', () => {
    // Moved up to first place: Move up is disabled now.
    expect(queueMoveFocusPart(queue, 'b', 'up')).toBe('down')
    // Moved down to the last place: Move down is disabled now.
    expect(queueMoveFocusPart(queue, 'd', 'down')).toBe('up')
  })

  it('falls back to Remove when both arrows are disabled (the only waiting game)', () => {
    const lone = [entry('a', 'active'), entry('b', 'waiting')]
    expect(queueMoveFocusPart(lone, 'b', 'up')).toBe('remove')
    expect(queueMoveFocusPart(lone, 'b', 'down')).toBe('remove')
  })

  it('is null once the game is no longer waiting', () => {
    expect(queueMoveFocusPart(queue, 'a', 'up')).toBeNull()
    expect(queueMoveFocusPart(queue, 'x', 'down')).toBeNull()
  })
})

describe('queueStarting', () => {
  it('is the active game (place 0) before any progress, never a waiting or unqueued one', () => {
    expect(queueStarting(0, undefined)).toBe(true)
    expect(queueStarting(0, null)).toBe(true)
    expect(queueStarting(1, undefined)).toBe(false)
    expect(queueStarting(null, undefined)).toBe(false)
    expect(queueStarting(undefined, undefined)).toBe(false)
  })

  it('treats ended progress (failed, cancelled) as none, running or done progress as progress', () => {
    expect(queueStarting(0, { state: 'failed' })).toBe(true)
    expect(queueStarting(0, { state: 'cancelled' })).toBe(true)
    expect(queueStarting(0, { state: 'downloading' })).toBe(false)
    expect(queueStarting(0, { state: 'starting' })).toBe(false)
    expect(queueStarting(0, { state: 'done' })).toBe(false)
  })

  it('reads a resumed ROM download (its turn came, last event paused) as starting; a paused waiting one is not', () => {
    expect(queueStarting(0, { state: 'paused' })).toBe(true)
    expect(queueStarting(1, { state: 'paused' })).toBe(false)
  })
})

describe('installStalled', () => {
  it('is true for a running install main flagged stalled, whatever language its message is in', () => {
    expect(installStalled({ state: 'downloading', stalled: true })).toBe(true)
    expect(installStalled({ state: 'downloading' })).toBe(false)
    expect(installStalled({ state: 'failed', stalled: true })).toBe(false)
    expect(installStalled({ state: 'done', stalled: true })).toBe(false)
    expect(installStalled(undefined)).toBe(false)
  })
})
