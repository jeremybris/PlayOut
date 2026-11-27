import type { OverrideStatus } from '../../shared/overlay'
import type { Logger } from '../logger'
import { linksOff, restoreLinks, turnLinksOff } from './game-bar-links'
import { regDeleteValue, regQuery, regSetDword, type RunCommand } from './io'
import type { OverridesStore } from './overrides-store'

/**
 * Xbox Game Bar off (docs/home-overlay.md, "Steam and Game Bar overrides"), all in HKCU (no admin):
 * - its controller shortcuts: with these values on, Windows opens Game Bar on a Guide press; both are set to 0;
 * - its links (game-bar-links.ts), so a program opening Game Bar itself (a launcher reading the Guide button, Win+G)
 *   gets nothing.
 * What was there before (absent values mean on) is kept in overrides.json and put back afterwards. Game Bar is also
 * closed whenever it still starts, by the controller reader (native-host/pad-script.ts).
 */
export const GAME_BAR_KEY = 'HKCU\\Software\\Microsoft\\GameBar'
export const GAME_BAR_VALUES = ['UseNexusForGameBarEnabled', 'GamepadNexusChordEnabled'] as const

export interface GameBarOverride {
  apply(): Promise<OverrideStatus>
  restore(): Promise<OverrideStatus>
}

export function createGameBarOverride(deps: {
  run: RunCommand
  store: OverridesStore
  log: Logger
}): GameBarOverride {
  const { run, store, log } = deps

  async function current(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {}
    for (const name of GAME_BAR_VALUES) {
      const v = await regQuery(run, GAME_BAR_KEY, name)
      out[name] = v && typeof v.data === 'number' ? v.data : null
    }
    return out
  }

  const failed = (err: unknown): OverrideStatus => ({
    state: 'error',
    message: err instanceof Error ? err.message : String(err)
  })

  return {
    async apply() {
      try {
        const now = await current()
        const record = (await store.read()).gameBar
        const toChange = GAME_BAR_VALUES.filter((n) => now[n] !== 0)
        const linksAreOff = await linksOff(run)
        if (toChange.length === 0 && linksAreOff) return { state: record ? 'applied' : 'already' }
        // Originals already recorded stay: they are the values from before PlayOut.
        const values = { ...(record?.values ?? {}) }
        for (const n of toChange) if (!(n in values)) values[n] = now[n]
        const links = { ...(record?.links ?? {}) }
        await store.set('gameBar', { values, links })
        for (const n of toChange) await regSetDword(run, GAME_BAR_KEY, n, 0)
        const changedLinks = await turnLinksOff(run, async (link, before) => {
          if (link in links) return
          links[link] = before
          await store.set('gameBar', { values, links })
        })
        log.info(
          `Game Bar turned off (${[...toChange, ...changedLinks].join(', ') || 'already off'})`
        )
        return { state: 'applied' }
      } catch (err) {
        log.warn('Game Bar override failed', err)
        return failed(err)
      }
    },

    async restore() {
      try {
        const record = (await store.read()).gameBar
        if (!record) return { state: 'off' }
        const now = await current()
        for (const [name, original] of Object.entries(record.values)) {
          // Only a value still at PlayOut's 0: anything else was changed since, in Windows' own settings.
          if (now[name] !== 0 || original === 0) continue
          if (original === null) await regDeleteValue(run, GAME_BAR_KEY, name)
          else await regSetDword(run, GAME_BAR_KEY, name, original)
        }
        if (record.links) await restoreLinks(run, record.links)
        await store.set('gameBar', undefined)
        log.info('Game Bar put back')
        return { state: 'off' }
      } catch (err) {
        log.warn('Game Bar restore failed', err)
        return failed(err)
      }
    }
  }
}
