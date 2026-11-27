// Launcher wiring: process monitor -> session tracker -> launcher (see docs/ARCHITECTURE.md section 4.5).
import { createGameLauncher } from './launcher'
import { createProcessMonitor, PROCESS_LIST_REUSE_MS } from './process-monitor'
import { createSessionTracker } from './session-tracker'
import type { LauncherDeps, LauncherService } from './types'

export function createLauncher(deps: LauncherDeps): LauncherService {
  const monitor = createProcessMonitor(deps.log)
  const tracker = createSessionTracker({
    library: deps.library,
    settings: deps.settings,
    window: deps.window,
    monitor,
    log: deps.log
  })
  const launcher = createGameLauncher({
    emulation: deps.emulation,
    tracker,
    monitor,
    log: deps.log,
    beforeLaunch: deps.beforeLaunch,
    launchBlocked: deps.launchBlocked,
    beforeGameLaunch: deps.beforeGameLaunch,
    events: deps.events
  })
  return {
    launch: launcher.launch,
    running: launcher.running,
    track: launcher.track,
    stop: launcher.stop,
    gameProcesses: () => launcher.gameProcesses?.() ?? Promise.resolve([]),
    processes: () => monitor.list({ maxAgeMs: PROCESS_LIST_REUSE_MS }),
    dispose() {
      launcher.dispose()
      monitor.dispose()
    }
  }
}

export type {
  LauncherDeps,
  LauncherService,
  LaunchOptions,
  RunningGame,
  WindowController
} from './types'
export type { ProcessInfo, ProcessMonitor } from './process-monitor'
export type {
  SessionTiming,
  SessionTracker,
  TrackedLaunch,
  TrackedSession
} from './session-tracker'
