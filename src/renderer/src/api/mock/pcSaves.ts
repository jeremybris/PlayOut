// PC Saves in the mock (main/pc-saves): a game you added gets a save folder from its Edit sheet. The folder picked
// decides what happens, so every state can be tried: a path with "big" in it is 150 MB (the confirm question), "huge"
// is refused as too large, a drive root as too broad; "conflict" leaves a conflict after the first copy and "other"
// asks "Use the copy from <PC>?". Play of a game with either question open is refused with a 'save-conflict' error.
import type { PlayOutApi } from '@shared/api'
import { PC_SAVES_CONFIRM_BYTES, PC_SAVES_FOLDER, type PcSaveView } from '@shared/pc-saves'
import type { Game } from '@shared/types'
import type { MockEmitter } from './emitter'

export type PcSavesApi = Pick<
  PlayOutApi,
  | 'getPcSaves'
  | 'inspectPcSaveFolder'
  | 'setPcSaveFolder'
  | 'syncPcSaves'
  | 'resolvePcSaveConflict'
  | 'answerPcSaveCopy'
>

export interface PcSavesMockDeps {
  emitter: MockEmitter
  games: Map<string, Game>
  emulationDir: () => string
  featureOn: () => boolean
  runningId: () => string | null
  now: () => string
}

export interface PcSavesMock {
  api: PcSavesApi
  /** A question waiting before the game may start (Play is refused with 'save-conflict'). */
  blocksLaunch(gameId: string): boolean
}

const MB = 1024 * 1024

export function createPcSavesMock(deps: PcSavesMockDeps): PcSavesMock {
  const views = new Map<string, PcSaveView>()
  const eligible = (id: string): Game => {
    const game = deps.games.get(id)
    if (!game || game.source !== 'manual' || game.remote)
      throw new Error('Only the saves of PC games you added can be copied.')
    return game
  }
  const blank = (gameId: string): PcSaveView => ({
    gameId,
    featureOn: deps.featureOn(),
    folder: null,
    copyDir: null,
    syncedAt: null,
    copyMachine: null,
    pending: false,
    error: null,
    conflict: null,
    confirm: null,
    running: false
  })
  const current = (gameId: string): PcSaveView => ({
    ...(views.get(gameId) ?? blank(gameId)),
    featureOn: deps.featureOn(),
    running: deps.runningId() === gameId
  })
  const store = (v: PcSaveView): PcSaveView => {
    views.set(v.gameId, v)
    deps.emitter.emit('pc-saves:changed', { gameId: v.gameId })
    return current(v.gameId)
  }
  const copied = (v: PcSaveView): PcSaveView => ({
    ...v,
    syncedAt: deps.now(),
    copyMachine: 'THIS-PC',
    pending: false,
    error: null,
    conflict: null,
    confirm: null
  })
  function measure(path: string): { bytes: number; files: number } {
    if (/^[a-z]:\\?$/i.test(path.trim()))
      throw new Error('That folder is too broad to copy (pick the game’s own save folder).')
    if (/huge/i.test(path))
      throw new Error('That folder takes 900 MB, more than the 512 MB PlayOut copies.')
    if (/big/i.test(path)) return { bytes: 150 * MB, files: 340 }
    return { bytes: Math.round(2.4 * MB), files: 12 }
  }

  return {
    blocksLaunch(gameId) {
      const v = views.get(gameId)
      return !!v && deps.featureOn() && (!!v.conflict || !!v.confirm)
    },
    api: {
      async getPcSaves(gameId) {
        const game = deps.games.get(gameId)
        if (!game || game.source !== 'manual' || game.remote) return null
        return current(gameId)
      },
      async inspectPcSaveFolder(gameId, path) {
        eligible(gameId)
        const { bytes, files } = measure(path)
        return { path, bytes, files, large: bytes > PC_SAVES_CONFIRM_BYTES }
      },
      async setPcSaveFolder(gameId, path) {
        const game = eligible(gameId)
        if (path === null) {
          views.delete(gameId)
          deps.emitter.emit('pc-saves:changed', { gameId })
          return current(gameId)
        }
        measure(path)
        const base: PcSaveView = {
          ...blank(gameId),
          folder: path,
          copyDir: `${deps.emulationDir()}\\${PC_SAVES_FOLDER}\\${game.title.slice(0, 40)} (3fa2c91b0d)`
        }
        if (/other/i.test(path))
          return store({ ...base, confirm: { machine: 'LIVING-ROOM', title: game.title } })
        if (/conflict/i.test(path))
          return store({
            ...base,
            conflict: {
              localAt: deps.now(),
              cloudAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
              cloudDevice: 'LIVING-ROOM'
            }
          })
        return store(copied(base))
      },
      async syncPcSaves(gameId) {
        eligible(gameId)
        if (deps.runningId() === gameId)
          throw new Error('It is running; its saves are copied when you close it.')
        const v = current(gameId)
        if (!v.folder || v.conflict || v.confirm) return v
        return store(copied(v))
      },
      async resolvePcSaveConflict(gameId, keep) {
        eligible(gameId)
        const v = current(gameId)
        return store({
          ...copied(v),
          copyMachine: keep === 'cloud' ? (v.conflict?.cloudDevice ?? null) : 'THIS-PC'
        })
      },
      async answerPcSaveCopy(gameId, use) {
        eligible(gameId)
        const v = current(gameId)
        return store({ ...copied(v), copyMachine: use ? (v.confirm?.machine ?? null) : 'THIS-PC' })
      }
    }
  }
}
