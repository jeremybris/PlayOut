import type {
  CoopTwoPlayerLayout,
  CoopDevice,
  CoopHandlerEntry,
  CoopLayout,
  CoopScreen,
  CoopSetup
} from '@shared/types'
import { tMain } from '../i18n'

/**
 * Co-Op's automatic setup (pure): how many players, which device each, which screen layout and where each player's
 * window goes. The user's choices (Co-Op setup, GameUserData.coop) override any part.
 *
 * - Players: one per connected controller. The keyboard and mouse count only when the user allows it (Settings >
 *   Library) and the handler supports them. At most the handler's MaxPlayers.
 * - Devices: controllers in XInput slot order, then DirectInput ones, then the keyboard and mouse.
 * - Layout: two players stacked top and bottom (Nucleus DualHorizontal) when the monitor is tall enough for two
 *   windows of at least MIN_STACKED_HEIGHT pixels each, else side by side (DualVertical); side by side always when
 *   the user prefers it (Settings > Library); 3-4 players 2×2, then 2×3,
 *   2×4, 4×4.
 * - Monitors: with two or more, players are spread evenly over all of them, the main monitor first, each monitor
 *   split as above for its share (one player: full screen). With one, or when the handler takes fewer players per
 *   monitor than there are players, see planSession.
 */

/** A stacked window shorter than this is too squat to play in: side by side instead. */
export const MIN_STACKED_HEIGHT = 540
/** Nucleus's upper bound on one monitor (SixteenPlayers). */
const MAX_PER_SCREEN = 16

/** How many players a layout holds. */
export function layoutCapacity(layout: CoopLayout): number {
  switch (layout) {
    case 'FullScreen':
      return 1
    case 'DualHorizontal':
    case 'DualVertical':
      return 2
    case 'FourPlayers':
      return 4
    case 'SixPlayers':
      return 6
    case 'EightPlayers':
      return 8
    case 'SixteenPlayers':
      return 16
  }
}

/** Rows × columns of a layout (Nucleus UserScreen.UpdateSubBounds). */
export function layoutGrid(layout: CoopLayout): { rows: number; cols: number } {
  switch (layout) {
    case 'FullScreen':
      return { rows: 1, cols: 1 }
    case 'DualHorizontal':
      return { rows: 2, cols: 1 }
    case 'DualVertical':
      return { rows: 1, cols: 2 }
    case 'FourPlayers':
      return { rows: 2, cols: 2 }
    case 'SixPlayers':
      return { rows: 2, cols: 3 }
    case 'EightPlayers':
      return { rows: 2, cols: 4 }
    case 'SixteenPlayers':
      return { rows: 4, cols: 4 }
  }
}

/** The smallest layout for `players` on one monitor (two players: stacked when it fits, else side by side). */
export function autoLayout(
  players: number,
  screen: CoopScreen | undefined,
  twoPlayer: CoopTwoPlayerLayout = 'stacked'
): CoopLayout {
  if (players <= 1) return 'FullScreen'
  if (players === 2) {
    if (twoPlayer === 'sideBySide') return 'DualVertical'
    const height = screen?.bounds.height ?? 1080
    return height / 2 >= MIN_STACKED_HEIGHT ? 'DualHorizontal' : 'DualVertical'
  }
  if (players <= 4) return 'FourPlayers'
  if (players <= 6) return 'SixPlayers'
  if (players <= 8) return 'EightPlayers'
  return 'SixteenPlayers'
}

/** The devices Co-Op may use, in assignment order (the keyboard and mouse last, and only when allowed). */
export function usableDevices(
  devices: readonly CoopDevice[],
  keyboardAllowed: boolean
): CoopDevice[] {
  const pads = devices
    .filter((d) => d.kind !== 'keyboard')
    .sort(
      (a, b) =>
        Number(a.kind !== 'xinput') - Number(b.kind !== 'xinput') ||
        (a.index ?? 99) - (b.index ?? 99) ||
        a.id.localeCompare(b.id)
    )
  const keyboard = keyboardAllowed ? devices.filter((d) => d.kind === 'keyboard').slice(0, 1) : []
  return [...pads, ...keyboard]
}

export interface PlanInput {
  handler: Pick<
    CoopHandlerEntry,
    'maxPlayers' | 'maxPlayersOneMonitor' | 'supportsKeyboard' | 'supportsMultipleKeyboardsAndMice'
  >
  devices: readonly CoopDevice[]
  screens: readonly CoopScreen[]
  /** Settings > Library: the keyboard and mouse may be a player. */
  keyboardAllowed: boolean
  /** Settings > Library: two players top and bottom (default) or left and right. */
  twoPlayerLayout?: CoopTwoPlayerLayout
  setup?: CoopSetup
}

export interface PlayerSlot {
  nickname: string
  device: CoopDevice
  screen: number
  slot: number
}

export interface PlannedSession {
  players: PlayerSlot[]
  /** The layout per monitor index used. */
  screens: { index: number; layout: CoopLayout }[]
  /** The first monitor's layout (what the setup shows). */
  layout: CoopLayout
  maxPlayers: number
  available: CoopDevice[]
  problem: string | null
}

export function planSession(input: PlanInput): PlannedSession {
  const { handler, setup } = input
  const keyboardOk =
    input.keyboardAllowed && (handler.supportsKeyboard || handler.supportsMultipleKeyboardsAndMice)
  const available = usableDevices(input.devices, keyboardOk)
  const maxPlayers = Math.max(1, Math.min(handler.maxPlayers ?? 4, 64))

  // The user's device order first (those still connected), then the rest in automatic order.
  const byId = new Map(available.map((d) => [d.id, d]))
  const chosen = (setup?.devices ?? []).map((id) => byId.get(id)).filter(Boolean) as CoopDevice[]
  const ordered = [...chosen, ...available.filter((d) => !chosen.includes(d))]
  const screens = [...input.screens].sort(
    (a, b) => Number(b.primary) - Number(a.primary) || a.index - b.index
  )
  const primary = screens[0]
  const monitors = Math.max(1, screens.length)
  const wanted = setup?.players ?? ordered.length
  // A layout picked in Co-Op setup is each monitor's layout. It counts while the monitors can hold every player with
  // it; one that no longer can (another controller was connected, or the player count was raised) is left out, as if
  // automatic, rather than leaving players out.
  const picked =
    setup?.layout &&
    layoutCapacity(setup.layout) * monitors >=
      Math.min(
        wanted,
        ordered.length,
        maxPlayers,
        Math.min(handler.maxPlayersOneMonitor ?? maxPlayers, MAX_PER_SCREEN) * monitors
      )
      ? setup.layout
      : undefined
  // Players one monitor takes: the handler's limit, and the picked layout's size.
  const perScreen = Math.max(
    1,
    Math.min(
      handler.maxPlayersOneMonitor ?? maxPlayers,
      MAX_PER_SCREEN,
      picked ? layoutCapacity(picked) : MAX_PER_SCREEN
    )
  )
  const count = Math.max(0, Math.min(wanted, ordered.length, maxPlayers, perScreen * monitors))
  const devices = ordered.slice(0, count)

  // Players per monitor. With more than one monitor (and no layout picked in Co-Op setup) every monitor is used:
  // players are spread evenly, the main monitor first (3 players on 2 monitors: 2 on the main one, 1 on the other),
  // so each monitor is one player's full screen or split like a single monitor would be. On one monitor, or with a
  // picked layout, all on the main one while it holds them, else spread the same way (never above perScreen).
  const spread = monitors > 1 && !picked
  const groups: number[] = []
  if (!spread && count <= perScreen) groups.push(count)
  else {
    let left = count
    for (let i = 0; i < monitors && left > 0; i++) {
      const share = Math.min(perScreen, Math.ceil(left / (monitors - i)))
      groups.push(share)
      left -= share
    }
  }

  const players: PlayerSlot[] = []
  const used: { index: number; layout: CoopLayout }[] = []
  let next = 0
  groups.forEach((size, i) => {
    const screen = screens[i] ?? primary
    // A monitor with one player is that player's full screen, picked layout or not.
    const layout =
      picked && size > 1 && layoutCapacity(picked) >= size
        ? picked
        : autoLayout(size, screen, input.twoPlayerLayout)
    used.push({ index: screen?.index ?? 0, layout })
    for (let slot = 0; slot < size; slot++, next++)
      players.push({
        nickname: `Player${next + 1}`,
        device: devices[next]!,
        screen: screen?.index ?? 0,
        slot
      })
  })

  let problem: string | null = null
  if (available.length === 0)
    problem = keyboardOk ? tMain('mainCoop.plan.noDevices') : tMain('mainCoop.plan.noControllers')
  else if (count < 2 && perScreen * monitors < 2) problem = tMain('mainCoop.plan.monitors')
  else if (count < 2)
    problem =
      available.length < 2
        ? coopOnePlayer(
            available[0]?.kind === 'keyboard',
            !keyboardOk && (handler.supportsKeyboard || handler.supportsMultipleKeyboardsAndMice)
          )
        : tMain('mainCoop.plan.twoPlayers')

  return {
    players,
    screens: used,
    layout: used[0]?.layout ?? 'FullScreen',
    maxPlayers,
    available,
    problem
  }
}

/**
 * Why one device is not enough, in one sentence: what was found (the keyboard and mouse, or one controller), and
 * whether allowing the keyboard and mouse as a player would help.
 */
function coopOnePlayer(keyboardFound: boolean, keyboardWouldHelp: boolean): string {
  if (keyboardFound)
    return keyboardWouldHelp
      ? tMain('mainCoop.plan.onlyKeyboardAllow')
      : tMain('mainCoop.plan.onlyKeyboard')
  return keyboardWouldHelp
    ? tMain('mainCoop.plan.oneControllerAllow')
    : tMain('mainCoop.plan.oneController')
}
