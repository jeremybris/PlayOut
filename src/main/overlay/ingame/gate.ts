import { basename } from 'path'
import {
  isXbox360BackwardCompatible,
  peerPartyBlockTags,
  peerPartyKernelAntiCheat
} from '../../../shared/peerparty'
import { recompOnlyKey } from '../../../shared/recomp-play'
import type { Game, Settings } from '../../../shared/types'
import type { Logger } from '../../logger'
import { scanAntiCheat, type AntiCheatScan } from '../../upgrades/anticheat'
import { antiCheatRunning, type ForegroundWindow, type OverlayTarget } from '../overlay-logic'
import type { IngameHelper, ProbeResult } from './helper'

/**
 * Whether the in-game overlay may be injected into the game under the overlay (docs/home-overlay.md, "In-game
 * overlay"). The rule is the PeerParty one (peerparty/eligibility.ts): never a game with anti-cheat, and anything not
 * known counts as anti-cheat. The game must be an installed PC game of the library, with no anti-cheat known by its
 * title, its tags, Steam's listing (a Steam game needs Steam's answer: no Valve Anti-Cheat) or its folder; at the
 * moment of the press no anti-cheat service may run, and the helper's probe of the process must find an x64,
 * ordinary (not elevated, protected or AppContainer) Direct3D 11 / DXGI process with no anti-cheat driver or module.
 * The cheap checks come first.
 */

export type GateReason =
  | 'off'
  | 'no-exe'
  | 'unknown-game'
  | 'never'
  | 'remote'
  | 'rom'
  | 'recomp'
  | 'not-installed'
  | 'no-folder'
  | 'xbox360'
  | 'windowsapps'
  | 'kernel-anti-cheat'
  | 'tags'
  | 'competitive'
  | 'vac'
  | 'vac-unknown'
  | 'scan-pending'
  | 'anti-cheat'
  | 'anti-cheat-unknown'
  | 'running-unknown'
  | 'anti-cheat-running'
  | 'helper-missing'
  | 'probe-failed'
  | 'arch'
  | 'elevated'
  | 'protected'
  | 'app-container'
  | 'anti-cheat-loaded'
  | 'graphics'

export type GateResult =
  | { ok: true; game: Game; probe: Extract<ProbeResult, { ok: true }> }
  | { ok: false; reason: GateReason; detail?: string }

export interface IngameGateDeps {
  log: Logger
  settings: () => Settings
  /** The PlayOut game running now, if any (it is preferred when the program under the overlay is in its folder). */
  running: () => { gameId: string } | null
  /** A game as the library shows it (tag edits applied). */
  game: (id: string) => Game | undefined
  /** Every game as the library shows it. */
  games: () => Game[]
  /** Lower-case image names of the running processes, or null when unknown. */
  runningImages: () => Promise<Set<string> | null>
  helper: Pick<IngameHelper, 'probe' | 'available'>
  /** Tests. */
  scan?: (installDir: string) => Promise<AntiCheatScan>
}

export interface IngameGate {
  /** The verdict for the window the overlay opens over. Never rejects. */
  check(target: OverlayTarget, fg: ForegroundWindow): Promise<GateResult>
  /** Start the folder scan of a game ahead of the first press (a game session started). */
  prewarm(gameId: string): void
}

/** Lower-case, forward slashes, no trailing slash. */
const norm = (p: string): string => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const inside = (file: string, dir: string): boolean => {
  const d = norm(dir)
  return !!d && norm(file).startsWith(d + '/')
}
const WINDOWS_APPS = /(?:^|[\\/])windowsapps(?:[\\/]|$)/i

/** The library game the program `exe` (full path) belongs to: its exe, or a program inside its install folder. */
export function gameOfExe(
  exe: string,
  running: Game | undefined,
  games: () => Game[]
): Game | undefined {
  if (!exe || !/[\\/]/.test(exe)) return undefined
  const owns = (g: Game): boolean =>
    !g.remote &&
    ((!!g.exePath && norm(g.exePath) === norm(exe)) ||
      (!!g.installDir && inside(exe, g.installDir)))
  if (running && owns(running)) return running
  const all = games().filter(owns)
  // The exact exe first, then the deepest install folder.
  return (
    all.find((g) => g.exePath && norm(g.exePath) === norm(exe)) ??
    all.sort((a, b) => norm(b.installDir ?? '').length - norm(a.installDir ?? '').length)[0]
  )
}

/** The block a game's own record shows, else null (no folder scan, nothing about the process). */
export function recordBlock(
  game: Game,
  settings: Settings,
  target: { program: string; exe: string | null }
): { reason: GateReason; detail?: string } | null {
  if ((settings.input.ingameNever ?? []).includes(game.id)) return { reason: 'never' }
  if (game.remote) return { reason: 'remote' }
  if (game.source === 'rom' || game.launch.kind === 'emulator') return { reason: 'rom' }
  if (recompOnlyKey(game)) return { reason: 'recomp' }
  if (!game.installed) return { reason: 'not-installed' }
  if (!game.installDir) return { reason: 'no-folder' }
  if (isXbox360BackwardCompatible(game, target.exe)) return { reason: 'xbox360' }
  if (WINDOWS_APPS.test(game.installDir) || (target.exe && WINDOWS_APPS.test(target.exe)))
    return { reason: 'windowsapps' }
  const kernel = peerPartyKernelAntiCheat(game.title)
  if (kernel) return { reason: 'kernel-anti-cheat', detail: kernel }
  const tags = peerPartyBlockTags(game)
  if (tags.length) return { reason: 'tags', detail: tags.join(', ') }
  // A plain online PvP game is not blocked (Filters > All Competitive is broader than anti-cheat): only real anti-cheat
  // signs are, as for PeerParty (the user's "Real anti-cheat only" choice).
  const vac = game.metadata.steamTags?.vac
  if (vac === true) return { reason: 'vac' }
  if (game.source === 'steam' && vac !== false) return { reason: 'vac-unknown' }
  return null
}

/** The block the helper's probe shows, else null. */
export function probeBlock(
  probe: ProbeResult | null
): { reason: GateReason; detail?: string } | null {
  if (!probe) return { reason: 'probe-failed' }
  if (!probe.ok) return { reason: 'probe-failed', detail: `${probe.step}: ${probe.error}` }
  if (probe.arch !== 'x64') return { reason: 'arch', detail: probe.arch }
  if (probe.elevated) return { reason: 'elevated' }
  if (probe.protected) return { reason: 'protected' }
  if (probe.appContainer) return { reason: 'app-container' }
  if (probe.antiCheat.length)
    return { reason: 'anti-cheat-loaded', detail: probe.antiCheat.join(', ') }
  // Anti-cheat counts as unknown (blocked) unless every source was read: the kernel drivers, the running processes
  // and the game's own modules.
  const checked = probe.checked
  if (!checked || checked.drivers === 0 || checked.processes === 0 || checked.modules === 0)
    return {
      reason: 'anti-cheat-loaded',
      detail: 'unknown (the helper could not read every source)'
    }
  if (!probe.graphics.includes('d3d11') && !probe.graphics.includes('dxgi'))
    return { reason: 'graphics', detail: probe.graphics.join(', ') || 'none' }
  return null
}

/**
 * How long a press waits for a game's first folder scan (usually a few milliseconds) before the window overlay is used
 * instead; the scan goes on and the next press uses its answer.
 */
export const SCAN_WAIT_MS = 2000

export function createIngameGate(deps: IngameGateDeps): IngameGate {
  const { log } = deps
  const scan = deps.scan ?? ((dir: string) => scanAntiCheat(dir))
  /** Folder scans per game id and install folder: running, done, or failed (anti-cheat unknown). */
  const scans = new Map<
    string,
    | { state: 'running' }
    | { state: 'done'; scan: AntiCheatScan }
    | { state: 'failed'; error: string }
  >()
  const keyOf = (g: Game): string => `${g.id}|${norm(g.installDir ?? '')}`
  /** The running scans, to wait for on a press. */
  const running = new Map<string, Promise<void>>()

  function startScan(game: Game): Promise<void> {
    const key = keyOf(game)
    const now = running.get(key)
    if (now) return now
    if (scans.has(key) || !game.installDir) return Promise.resolve()
    scans.set(key, { state: 'running' })
    const started = Date.now()
    const work = (async () => {
      try {
        const result = await scan(game.installDir!)
        scans.set(key, { state: 'done', scan: result })
        log.info(
          `ingame: scanned ${game.title} for anti-cheat in ${Date.now() - started} ms: ${result.names.join(', ') || 'none'}${result.complete ? '' : ' (incomplete)'}`
        )
      } catch (err) {
        scans.set(key, { state: 'failed', error: (err as Error)?.message ?? String(err) })
        log.info(`ingame: ${game.title}'s folder could not be checked for anti-cheat`, err)
      } finally {
        running.delete(key)
      }
    })()
    running.set(key, work)
    return work
  }

  /** The game's scan, started now if needed, waited for up to SCAN_WAIT_MS. */
  async function scanned(game: Game): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SCAN_WAIT_MS)
    })
    await Promise.race([startScan(game), late])
    if (timer) clearTimeout(timer)
  }

  async function check(target: OverlayTarget, fg: ForegroundWindow): Promise<GateResult> {
    const no = (reason: GateReason, detail?: string): GateResult => ({ ok: false, reason, detail })
    const settings = deps.settings()
    if (!settings.input.ingameOverlay) return no('off')
    const exe = fg.exe && /[\\/]/.test(fg.exe) ? fg.exe : ''
    if (!exe) return no('no-exe')
    const running = deps.running()
    const game = gameOfExe(exe, running ? deps.game(running.gameId) : undefined, deps.games)
    if (!game) return no('unknown-game', basename(exe))
    const record = recordBlock(game, settings, { program: target.program, exe })
    if (record) return no(record.reason, record.detail)

    if (scans.get(keyOf(game))?.state !== 'done') await scanned(game)
    const folder = scans.get(keyOf(game))
    if (!folder || folder.state === 'running') {
      log.info(
        `ingame: ${game.title} is still being scanned for anti-cheat; the next press uses the answer`
      )
      return no('scan-pending')
    }
    if (folder.state === 'failed') return no('anti-cheat-unknown', folder.error)
    if (folder.scan.names.length) return no('anti-cheat', folder.scan.names.join(', '))
    if (!folder.scan.complete) return no('anti-cheat-unknown', 'incomplete scan')

    const images = await deps.runningImages().catch(() => null)
    if (!images) return no('running-unknown')
    const service = antiCheatRunning(images)
    if (service) return no('anti-cheat-running', service)

    if (!(await deps.helper.available().catch(() => false))) return no('helper-missing')
    const probe = await deps.helper.probe(target.pid).catch(() => null)
    const blocked = probeBlock(probe)
    if (blocked || !probe || !probe.ok)
      return no(blocked?.reason ?? 'probe-failed', blocked?.detail)
    return { ok: true, game, probe }
  }

  return {
    async check(target, fg) {
      try {
        return await check(target, fg)
      } catch (err) {
        log.warn('ingame: gate check failed', err)
        return { ok: false, reason: 'probe-failed', detail: (err as Error)?.message }
      }
    },
    prewarm(gameId) {
      const settings = deps.settings()
      if (!settings.input.ingameOverlay) return
      const game = deps.game(gameId)
      if (!game) return
      if (recordBlock(game, settings, { program: '', exe: game.exePath ?? null })) return
      startScan(game)
    }
  }
}
