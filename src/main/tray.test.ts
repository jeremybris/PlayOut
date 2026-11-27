import { describe, expect, it, vi } from 'vitest'
import { createCloseToTray, type TrayActions, type TrayWindow } from './tray'

type Listener = (event?: { preventDefault(): void }) => void

function fakeWindow(): TrayWindow & {
  emit(event: string): { prevented: boolean }
  visible: boolean
  hide: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
} {
  const listeners = new Map<string, Listener[]>()
  const w = {
    visible: true,
    minimized: false,
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return w
    },
    hide: vi.fn(() => {
      w.visible = false
    }),
    show: vi.fn(() => {
      w.visible = true
      for (const l of listeners.get('show') ?? []) l()
    }),
    focus: vi.fn(),
    restore: vi.fn(() => {
      w.minimized = false
    }),
    isMinimized: () => w.minimized,
    isDestroyed: () => false,
    emit(event: string) {
      let prevented = false
      for (const l of listeners.get(event) ?? [])
        l({
          preventDefault: () => {
            prevented = true
          }
        })
      return { prevented }
    }
  }
  return w as never
}

function setup(enabled = true): {
  state: { enabled: boolean }
  trays: { destroy: ReturnType<typeof vi.fn>; actions: TrayActions }[]
  quit: ReturnType<typeof vi.fn>
  controller: ReturnType<typeof createCloseToTray>
  win: ReturnType<typeof fakeWindow>
} {
  const state = { enabled }
  const trays: { destroy: ReturnType<typeof vi.fn>; actions: TrayActions }[] = []
  const quit = vi.fn()
  const controller = createCloseToTray({
    enabled: () => state.enabled,
    createTray: (actions) => {
      const tray = { destroy: vi.fn(), actions }
      trays.push(tray)
      return tray
    },
    quit
  })
  const win = fakeWindow()
  controller.attach(win)
  return { state, trays, quit, controller, win }
}

describe('createCloseToTray', () => {
  it('with the setting off, closing and Exit behave as before and no tray icon exists', () => {
    const { win, controller, quit, trays } = setup(false)
    expect(win.emit('close').prevented).toBe(false)
    expect(win.hide).not.toHaveBeenCalled()
    controller.exit()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(trays).toHaveLength(0)
  })

  it('with the setting on, closing (X, Alt+F4) hides the window to the tray instead', () => {
    const { win, controller, trays } = setup()
    expect(trays).toHaveLength(1)
    expect(win.emit('close').prevented).toBe(true)
    expect(win.hide).toHaveBeenCalled()
    expect(controller.isHidden()).toBe(true)
  })

  it("the app's own Exit hides to the tray while the setting is on", () => {
    const { win, controller, quit } = setup()
    controller.exit()
    expect(quit).not.toHaveBeenCalled()
    expect(win.visible).toBe(false)
  })

  it('a tray click or "Open PlayOut" brings the window back', () => {
    const { win, controller, trays } = setup()
    win.emit('close')
    trays[0]!.actions.open()
    expect(win.visible).toBe(true)
    expect(win.focus).toHaveBeenCalled()
    expect(controller.isHidden()).toBe(false)
  })

  it('the tray "Quit" quits for real, and the close that follows is not stopped', () => {
    const { win, trays, quit } = setup()
    win.emit('close')
    trays[0]!.actions.quit()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(win.emit('close').prevented).toBe(false)
  })

  it('a quit from anywhere else (update install, before-quit) lets the window close', () => {
    const { win, controller } = setup()
    controller.markQuitting()
    expect(win.emit('close').prevented).toBe(false)
  })

  it('Windows shutting down or signing out lets the window close', () => {
    for (const event of ['query-session-end', 'session-end']) {
      const { win } = setup()
      win.emit(event)
      expect(win.emit('close').prevented, event).toBe(false)
    }
  })

  it('turning the setting off while hidden removes the tray icon and shows the window', () => {
    const { win, controller, trays, state } = setup()
    win.emit('close')
    state.enabled = false
    controller.sync()
    expect(trays[0]!.destroy).toHaveBeenCalled()
    expect(win.visible).toBe(true)
    expect(controller.isHidden()).toBe(false)
    expect(win.emit('close').prevented).toBe(false)
  })

  it('turning the setting on adds the tray icon once', () => {
    const { controller, trays, state } = setup(false)
    state.enabled = true
    controller.sync()
    controller.sync()
    expect(trays).toHaveLength(1)
  })

  it('quits instead of hiding when the tray icon cannot be created', () => {
    const quit = vi.fn()
    const controller = createCloseToTray({
      enabled: () => true,
      createTray: () => {
        throw new Error('no tray')
      },
      quit
    })
    const win = fakeWindow()
    controller.attach(win)
    expect(win.emit('close').prevented).toBe(false)
    controller.exit()
    expect(quit).toHaveBeenCalled()
    expect(win.hide).not.toHaveBeenCalled()
  })
})
