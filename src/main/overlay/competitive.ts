import { basename } from 'path'
import { isCompetitiveOnline } from '../../shared/online-multiplayer'
import type { Game } from '../../shared/types'

/** Lower-case, forward slashes, no trailing slash (Windows paths compared as Windows does). */
const norm = (p: string): string => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Whether `file` lies inside `dir`. */
function inside(file: string, dir: string): boolean {
  const d = norm(dir)
  return !!d && norm(file).startsWith(d + '/')
}

/**
 * The competitive online game under the overlay (Filters > Online Multiplayer > All Competitive), which the overlay
 * never pauses: the game PlayOut is running, or a library game the program under the overlay belongs to (started
 * elsewhere, from Steam say): its exe, or a program inside its install folder. Games are passed as the library shows
 * them (the user's and the cloud's tag edits applied), as the filter sees them. Returns why, or null.
 */
export function competitiveUnder(
  target: { program: string; exe: string | null },
  runningGame: Game | undefined,
  games: () => Game[]
): string | null {
  const why = (g: Game): string => `${g.title} is a competitive online game`
  if (runningGame && isCompetitiveOnline(runningGame)) return why(runningGame)
  const program = target.program.trim().toLowerCase()
  if (!program && !target.exe) return null
  for (const g of games()) {
    if (g.remote || !isCompetitiveOnline(g)) continue
    if (g.exePath) {
      if (target.exe && norm(g.exePath) === norm(target.exe)) return why(g)
      if (program && basename(g.exePath.replace(/\\/g, '/')).toLowerCase() === program)
        return why(g)
    }
    if (g.installDir && target.exe && inside(target.exe, g.installDir)) return why(g)
  }
  return null
}
