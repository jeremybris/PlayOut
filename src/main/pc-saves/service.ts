// PC Saves (docs/USER-GUIDE.md, "Saves of PC games you added"): for a PC game the user added (source 'manual'), the
// user picks its save folder; PlayOut copies it into <Emulation folder>/PC Saves/<Title (key hash)>/ after play and
// copies a newer copy back before play, with the recompilations' machinery (recomp/cloud.ts: current/ + meta.json,
// three-way hashes, backups of whatever is replaced in <userData>/pc-save-backups, all-or-nothing restores). The
// Emulation folder sync (streaming/emulation-sync) carries the copy to the other PCs; each copy holds that sync off
// while it swaps files.
//
// The copy folder is named after the game's stable key (gameMetadataKey, frozen when the folder is chosen), so the same
// game on another PC finds it although library ids differ. A folder that only looks like the game's (same title, another
// key) is used only after the user said yes ("Use the copy from <PC>?"). Saves are never deleted outside what a restore
// replaces (and that is backed up first); Clear forgets the folder and leaves both sides as they are.
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { hostname } from 'os'
import { dirname, join, resolve } from 'path'
import {
  PC_SAVES_CONFIRM_BYTES,
  PC_SAVES_FOLDER,
  type PcSaveFolderCheck,
  type PcSaveView
} from '../../shared/pc-saves'
import { gameMetadataKey } from '../../shared/metadata-edit'
import type { Game, LaunchError } from '../../shared/types'
import type { EventBus } from '../events'
import type { LauncherService } from '../launcher/types'
import type { Logger } from '../logger'
import {
  isOwnCopy,
  readCopyMeta,
  resolveConflict,
  syncSaves,
  type CloudSyncDeps
} from '../recomp/cloud'
import { toSaveTemplate } from '../recomp/saves'
import { createKeyedLock, folderNamesWithin, machineIdOf } from '../save-copy/shared'
import { knownFolders as realKnownFolders, normalizePath, type KnownFolders } from '../util/paths'
import { tMain } from '../i18n'
import { checkSaveFolder, parentStillThere, refusePath, type SaveFolderRules } from './folders'
import {
  createPcSavesStore,
  freshCopyState,
  type PcSaveRecord,
  type PcSavesFile,
  type PcSavesStore
} from './state'

export interface PcSavesDeps {
  userData: string
  library: { getGame(id: string): Game | undefined }
  launcher: Pick<LauncherService, 'running'>
  events: Pick<EventBus, 'on' | 'emit'>
  /** Settings › Library › "Copy saves of games you added". */
  enabled(): boolean
  /** The Emulation folder in use (Settings › Library). */
  emulationDir(): string
  /** PlayOut's own folders, never a save folder (its install folder, Recompilations, Emulators...). */
  ownFolders(): string[]
  /** Holds the Emulation folder sync off while a copy swaps files (streaming.holdEmulationSync). */
  holdSync?(): () => void
  /** The Emulation folder is being moved: no copy starts meanwhile. */
  moving?(): boolean
  log: Logger
  documents?: string
  // --- seams (tests) ---
  knownFolders?: () => KnownFolders
  machine?: string
  /** This install's own id in the copies' meta.json (default: machineIdOf(userData)). */
  machineId?: string
  now?: () => Date
  /** The records file (default <userData>/pc-saves.json). */
  file?: string
  /** How long after a game closed its saves are copied (its files closed; default 2 s). */
  afterPlayDelayMs?: number
}

export interface PcSavesService {
  view(gameId: string): Promise<PcSaveView | null>
  /** A folder's size and count before it is chosen; throws a translated refusal. */
  inspect(gameId: string, path: string): Promise<PcSaveFolderCheck>
  /** Choose the save folder (validated, then copied at once when the game is not running); null clears it. */
  setFolder(gameId: string, path: string | null): Promise<PcSaveView>
  /** Copy now (refused while the game runs). */
  syncNow(gameId: string): Promise<PcSaveView>
  resolve(gameId: string, keep: 'local' | 'cloud'): Promise<PcSaveView>
  /** The answer to "Use the copy from <PC>?". */
  answerCopy(gameId: string, use: boolean): Promise<PcSaveView>
  /**
   * Before a manual game starts: a newer copy is copied back. A conflict (or an unanswered question) refuses the start
   * with a 'save-conflict' error, unless the start is a paired PC's stream (then it starts, the question waits).
   */
  beforePlay(game: Game, context?: { streamed?: boolean }): Promise<LaunchError | null>
  /** The copy after a session of `gameId` ended (also run by 'session:ended'). */
  afterPlay(gameId: string): Promise<void>
  /** The Emulation folder was moved with its copies: the last-synced hashes still hold. */
  noteEmulationFolderMoved(from: string, to: string): Promise<void>
  dispose(): void
}

/** How long reading the PC Saves folder may take (an Emulation folder on a drive that is gone). */
const FOLDER_READ_MS = 1500
const TITLE_CHARS = 40
/**
 * How soon after its before-play copy a session must start to count as started with Play (a start that failed after
 * the copy leaves no session; a Co-Op or PeerParty one started later is not copied).
 */
const ARMED_MS = 2 * 60_000

/** The short stable hash of a key that ends its copy folder's name. */
export function keyHash(key: string): string {
  return createHash('sha1').update(key.toLowerCase()).digest('hex').slice(0, 10)
}

/** "<Title cut to 40> (<key hash>)", safe as a Windows folder name. */
export function copyFolderName(title: string, key: string): string {
  const clean =
    title
      // eslint-disable-next-line no-control-regex -- control characters cannot be in a file name
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TITLE_CHARS)
      .replace(/[. ]+$/, '') || 'Game'
  return `${clean} (${keyHash(key)})`
}

/** A title compared across PCs: letters and digits only, lower case. */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

const isEligible = (game: Game | undefined): game is Game =>
  !!game && game.source === 'manual' && !game.remote

export function createPcSavesService(deps: PcSavesDeps): PcSavesService {
  const { log } = deps
  const store: PcSavesStore = createPcSavesStore(deps.file ?? join(deps.userData, 'pc-saves.json'))
  const withLock = createKeyedLock()
  const folders = deps.knownFolders ?? realKnownFolders
  const machine = deps.machine ?? hostname()
  let machineIdValue = deps.machineId
  const machineId = (): string => (machineIdValue ??= machineIdOf(deps.userData))
  const now = (): Date => deps.now?.() ?? new Date()
  const backupsDir = join(deps.userData, 'pc-save-backups')
  const emulationDir = (): string => resolve(deps.emulationDir())
  const copiesRoot = (): string => join(emulationDir(), PC_SAVES_FOLDER)
  /**
   * Games started through Play, with when their before-play copy ran: only a session that started right after it
   * (ARMED_MS) is copied after play.
   */
  const armed = new Map<string, number>()
  const timers = new Set<NodeJS.Timeout>()

  const running = (gameId: string): boolean => deps.launcher.running()?.gameId === gameId

  function gameOf(gameId: string): Game {
    const game = deps.library.getGame(gameId)
    if (!isEligible(game)) throw new Error(tMain('mainPcSaves.notManual'))
    return game
  }

  function installOf(game: Game): string | null {
    return game.installDir ?? (game.exePath ? dirname(game.exePath) : null)
  }

  function rulesFor(game: Game, file: PcSavesFile): SaveFolderRules {
    return {
      folders: folders(),
      documents: deps.documents,
      install: installOf(game),
      exePath: game.exePath ?? null,
      own: [emulationDir(), deps.userData, backupsDir, ...deps.ownFolders()],
      others: Object.entries(file.games)
        .filter(([id]) => id !== game.id)
        .map(([id, r]) => ({ title: deps.library.getGame(id)?.title ?? r.title, folder: r.folder }))
    }
  }

  function toView(gameId: string, rec: PcSaveRecord | undefined): PcSaveView {
    return {
      gameId,
      featureOn: deps.enabled(),
      folder: rec?.folder ?? null,
      copyDir: rec?.copyFolder ? join(copiesRoot(), rec.copyFolder) : null,
      syncedAt: rec?.state.syncedAt ?? null,
      copyMachine: rec?.copyMachine ?? null,
      pending: rec?.state.pending ?? false,
      error: rec?.state.error ?? null,
      conflict: rec?.state.conflict ?? null,
      confirm: rec?.proposed ? { machine: rec.proposed.machine, title: rec.proposed.title } : null,
      running: running(gameId)
    }
  }

  /**
   * The records with their last-synced hashes valid for the Emulation folder in use: when it changed (and was not
   * moved with its copies), every last-synced hash is forgotten, so a copy already in the new folder that differs from
   * the saves is a conflict for the user, never a silent copy back over them.
   */
  async function fileFor(rootDir: string): Promise<PcSavesFile> {
    const f = await store.read()
    if (f.savesRoot && normalizePath(f.savesRoot) === normalizePath(rootDir)) return f
    return store.update((ff) => {
      if (ff.savesRoot && normalizePath(ff.savesRoot) === normalizePath(rootDir)) return
      if (ff.savesRoot)
        for (const r of Object.values(ff.games)) {
          r.state = { ...r.state, syncedHash: null, conflict: null, pending: false, error: null }
          delete r.proposed
        }
      ff.savesRoot = rootDir
    })
  }

  const saveRecord = (gameId: string, fn: (r: PcSaveRecord) => void): Promise<PcSavesFile> =>
    store.update((f) => {
      const r = f.games[gameId]
      if (r) fn(r)
    })

  type Pick =
    | { kind: 'use'; name: string; switched: boolean }
    | { kind: 'ask'; name: string; machine: string; title: string }
    | { kind: 'unreachable' }

  /** Folder names compared the same way on every PC (case-blind, then by code unit). */
  const byName = (a: string, b: string): number => {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }

  /**
   * The copy folder for a record. Folders other games on this PC use are never one. With folders ending in
   * " (<key hash>)" there (two PCs that chose the folder before the Emulation folder sync carried either copy made one
   * each, named after their own titles), every PC takes the same one, the first by name — switching from its own
   * (a difference is then a conflict, never a silent copy). Else the one chosen before, else one whose meta.json names
   * this key, else a single folder another PC made for a game with the same title (asked about first), else a new one.
   */
  async function pickCopy(rec: PcSaveRecord, gameId: string, file: PcSavesFile): Promise<Pick> {
    const root = copiesRoot()
    const names = await folderNamesWithin(root, FOLDER_READ_MS)
    if (names === null) return { kind: 'unreachable' }
    const taken = new Set(
      Object.entries(file.games)
        .filter(([id, r]) => id !== gameId && r.copyFolder)
        .map(([, r]) => r.copyFolder!.toLowerCase())
    )
    const free = names.filter((n) => !taken.has(n.toLowerCase())).sort(byName)
    const suffix = ` (${keyHash(rec.key)})`
    const has = (n: string): string | undefined =>
      free.find((x) => x.toLowerCase() === n.toLowerCase())
    const exact = free.filter((n) => n.toLowerCase().endsWith(suffix))
    if (rec.copyFolder) {
      const stored = has(rec.copyFolder)
      // A copy the user said yes to (another key's folder) stays while it is there.
      if (exact.length && (rec.copyFolder.toLowerCase().endsWith(suffix) || !stored)) {
        const first = exact[0]!
        return {
          kind: 'use',
          name: first,
          switched: first.toLowerCase() !== rec.copyFolder.toLowerCase()
        }
      }
      return { kind: 'use', name: stored ?? rec.copyFolder, switched: false }
    }
    if (exact.length) return { kind: 'use', name: exact[0]!, switched: false }
    const declined = new Set((rec.declined ?? []).map((d) => d.toLowerCase()))
    const ours = titleKey(rec.title)
    const alike: { name: string; machine: string; title: string }[] = []
    for (const name of free) {
      if (declined.has(name.toLowerCase())) continue
      const meta = await readCopyMeta(join(root, name)).catch(() => null)
      const extra = meta?.extra
      if (!meta || extra?.kind !== 'pc-saves') continue
      if (extra.key && extra.key.toLowerCase() === rec.key.toLowerCase())
        return { kind: 'use', name, switched: false }
      // A same-titled copy this PC made is another game's here (never offered as "the copy from <this PC>").
      if (ours && extra.title && titleKey(extra.title) === ours && !isOwnCopy(meta, ownMachine()))
        alike.push({ name, machine: meta.machine, title: extra.title })
    }
    if (alike.length === 1) return { kind: 'ask', ...alike[0]! }
    return { kind: 'use', name: copyFolderName(rec.title, rec.key), switched: false }
  }

  const ownMachine = (): { machine: string; machineId: string } => ({
    machine,
    machineId: machineId()
  })

  function copyDeps(game: Game, rec: PcSaveRecord, dir: string, rootDir: string): CloudSyncDeps {
    const ctx = {
      install: installOf(game) ?? rec.folder,
      folders: folders(),
      documents: deps.documents
    }
    return {
      rootDir,
      dir,
      machine,
      machineId: machineId(),
      log,
      now,
      backupsDir,
      templates: [toSaveTemplate(rec.folder, ctx)],
      logTag: 'pc saves',
      extraMeta: { kind: 'pc-saves', key: rec.key, title: rec.title },
      rootsByPosition: true
    }
  }

  /**
   * Why the folder cannot be copied now, or null: every check made when it was chosen, again (a junction, programs or
   * a link inside may have come since). A save folder that is gone is made again only while the folder holding it is
   * there as itself (the game just has not made it yet); gone with its parent, it moved (the game with it, likely):
   * "choose it again", never a dead folder made and restored into.
   */
  async function refusedNow(
    game: Game,
    rec: PcSaveRecord,
    file: PcSavesFile
  ): Promise<{ refused: string } | { make: boolean }> {
    const rules = rulesFor(game, file)
    const refused = refusePath(rec.folder, rules)
    if (refused) return { refused }
    const st = await fs.lstat(rec.folder).catch(() => null)
    if (!st) {
      if (await parentStillThere(rec.folder)) return { make: true }
      return { refused: tMain('mainPcSaves.folder.missing', { path: rec.folder }) }
    }
    try {
      await checkSaveFolder(rec.folder, rules)
    } catch (err) {
      return { refused: err instanceof Error ? err.message : String(err) }
    }
    return { make: false }
  }

  /** One copy (under the game's lock): the record's new state is stored and returned as a view. */
  async function sync(
    gameId: string,
    run: (game: Game, rec: PcSaveRecord, cloud: CloudSyncDeps) => Promise<PcSaveRecord['state']>,
    label: string
  ): Promise<PcSaveView> {
    const game = gameOf(gameId)
    const rootDir = emulationDir()
    const file = await fileFor(rootDir)
    let rec = file.games[gameId]
    if (!rec || !deps.enabled()) return toView(gameId, rec)
    if (rec.proposed) return toView(gameId, rec)
    if (deps.moving?.()) {
      const error = tMain('mainEmulationMove.busy.moving')
      const f = await saveRecord(gameId, (r) => (r.state = { ...r.state, pending: true, error }))
      return toView(gameId, f.games[gameId])
    }
    const check = await refusedNow(game, rec, file)
    if ('refused' in check) {
      const refused = check.refused
      log.warn(`pc saves: ${game.title}: ${label} skipped: ${refused}`)
      const f = await saveRecord(
        gameId,
        (r) => (r.state = { ...r.state, pending: false, error: refused })
      )
      return toView(gameId, f.games[gameId])
    }
    const pick = await pickCopy(rec, gameId, file)
    if (pick.kind === 'unreachable') {
      const error = tMain('mainRecomp.saves.emulationUnreachable', { folder: rootDir })
      const f = await saveRecord(gameId, (r) => (r.state = { ...r.state, pending: true, error }))
      return toView(gameId, f.games[gameId])
    }
    if (pick.kind === 'ask') {
      log.info(
        `pc saves: ${game.title}: ${pick.name} (from ${pick.machine}) may be its copy; asking`
      )
      const f = await saveRecord(gameId, (r) => {
        r.proposed = { name: pick.name, machine: pick.machine, title: pick.title }
      })
      return toView(gameId, f.games[gameId])
    }
    if (pick.name !== rec.copyFolder || pick.switched) {
      const f = await saveRecord(gameId, (r) => {
        r.copyFolder = pick.name
        if (pick.switched) r.state = { ...r.state, syncedHash: null }
      })
      rec = f.games[gameId]!
    }
    const dir = join(copiesRoot(), pick.name)
    // A save folder the game has not made (again) yet, in a folder still there: made, so a copy coming back lands in it.
    if (check.make) await fs.mkdir(rec.folder).catch(() => undefined)
    const release = deps.holdSync?.() ?? (() => {})
    let next: PcSaveRecord['state']
    try {
      next = await run(game, rec, copyDeps(game, rec, dir, rootDir))
    } finally {
      release()
    }
    const meta = await readCopyMeta(dir).catch(() => null)
    const f = await store.update((ff) => {
      const r = ff.games[gameId]
      if (!r || normalizePath(r.folder) !== normalizePath(rec!.folder)) return
      // The Emulation folder changed meanwhile: this result belongs to the old one.
      r.state =
        normalizePath(emulationDir()) !== normalizePath(rootDir)
          ? { ...next, syncedHash: null }
          : next
      if (meta) r.copyMachine = meta.machine
    })
    deps.events.emit('pc-saves:changed', { gameId })
    return toView(gameId, f.games[gameId])
  }

  const syncDirection = (
    gameId: string,
    direction: 'before-play' | 'after-play' | 'manual'
  ): Promise<PcSaveView> =>
    withLock(gameId, () =>
      sync(
        gameId,
        (_g, rec, cloud) => syncSaves(rec.key, [rec.folder], rec.state, cloud, direction),
        direction
      )
    )

  async function afterPlay(gameId: string): Promise<void> {
    try {
      const game = deps.library.getGame(gameId)
      if (!isEligible(game)) return
      const rec = (await store.read()).games[gameId]
      if (!rec || !deps.enabled()) return
      if (running(gameId)) return
      const v = await syncDirection(gameId, 'after-play')
      if (v.error) log.warn(`pc saves: ${game.title}: after play: ${v.error}`)
    } catch (err) {
      log.warn(`pc saves: after play of ${gameId} failed`, err)
    }
  }

  /** Whether a session that started at `startedAt` is the one the last before-play copy of `gameId` ran for. */
  function startedWithPlay(gameId: string, startedAt: string): boolean {
    const at = armed.get(gameId)
    const started = Date.parse(startedAt)
    if (at === undefined || Number.isNaN(started)) return false
    // A second of slack: the session's start time and the copy's are read from different clocks' calls.
    return started >= at - 1000 && started - at <= ARMED_MS
  }

  const offEnded = deps.events.on('session:ended', ({ gameId, startedAt }) => {
    const game = deps.library.getGame(gameId)
    if (!isEligible(game)) return
    // A session replaced by a new Play of the same game is not this one: the new session's end is copied.
    const withPlay = startedWithPlay(gameId, startedAt)
    if (withPlay) armed.delete(gameId)
    if (!withPlay) {
      // Started another way (Co-Op, PeerParty): its saves are left as they are (copied at its next Play).
      void store.read().then((f) => {
        if (f.games[gameId])
          log.info(
            `pc saves: ${game.title} was not started with Play (Co-Op or PeerParty): its saves were not copied`
          )
      })
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      void afterPlay(gameId)
    }, deps.afterPlayDelayMs ?? 2000)
    timers.add(timer)
  })

  return {
    async view(gameId) {
      const game = deps.library.getGame(gameId)
      if (!isEligible(game)) return null
      return toView(gameId, (await store.read()).games[gameId])
    },

    async inspect(gameId, path) {
      const game = gameOf(gameId)
      const file = await store.read()
      const p = resolve(path)
      const { files, bytes } = await checkSaveFolder(p, rulesFor(game, file))
      return { path: p, bytes, files: files.length, large: bytes > PC_SAVES_CONFIRM_BYTES }
    },

    async setFolder(gameId, path) {
      const game = gameOf(gameId)
      if (path === null) {
        const f = await withLock(gameId, () =>
          store.update((ff) => {
            delete ff.games[gameId]
          })
        )
        log.info(`pc saves: ${game.title}: save folder cleared (its saves and their copy are kept)`)
        deps.events.emit('pc-saves:changed', { gameId })
        return toView(gameId, f.games[gameId])
      }
      // A folder inside the Emulation folder being moved in could be chosen: no choosing meanwhile.
      if (deps.moving?.()) throw new Error(tMain('mainEmulationMove.busy.moving'))
      const p = resolve(path)
      await withLock(gameId, async () => {
        const file = await store.read()
        const key = file.games[gameId]?.key ?? gameMetadataKey(game) ?? `game-${game.id}`
        // Two entries of one game (or a modded install found as the same game) would share one copy and overwrite
        // each other's saves.
        const same = Object.entries(file.games).find(
          ([id, r]) => id !== gameId && r.key.toLowerCase() === key.toLowerCase()
        )
        if (same)
          throw new Error(
            tMain('mainPcSaves.folder.sameGame', {
              title: deps.library.getGame(same[0])?.title ?? same[1].title
            })
          )
        await checkSaveFolder(p, rulesFor(game, file))
        await store.update((ff) => {
          const old = ff.games[gameId]
          if (old && normalizePath(old.folder) === normalizePath(p)) return
          ff.games[gameId] = {
            folder: p,
            key,
            title: old?.title ?? game.title,
            ...(old?.copyFolder ? { copyFolder: old.copyFolder } : {}),
            ...(old?.declined ? { declined: old.declined } : {}),
            copyMachine: old?.copyMachine ?? null,
            // Another folder: what was synced before says nothing about it (a difference is a conflict).
            state: freshCopyState()
          }
        })
      })
      log.info(`pc saves: ${game.title}: save folder ${p}`)
      if (running(gameId) || deps.moving?.() || !deps.enabled())
        return toView(gameId, (await store.read()).games[gameId])
      return syncDirection(gameId, 'manual')
    },

    async syncNow(gameId) {
      gameOf(gameId)
      if (running(gameId)) throw new Error(tMain('mainRecomp.saves.runningCopiedOnClose'))
      return syncDirection(gameId, 'manual')
    },

    async resolve(gameId, keep) {
      gameOf(gameId)
      if (running(gameId)) throw new Error(tMain('mainRecomp.saves.runningPick'))
      return withLock(gameId, () =>
        sync(
          gameId,
          (_g, rec, cloud) => resolveConflict(rec.key, [rec.folder], rec.state, keep, cloud),
          `keep ${keep}`
        )
      )
    },

    async answerCopy(gameId, use) {
      const game = gameOf(gameId)
      await withLock(gameId, () =>
        store.update((f) => {
          const r = f.games[gameId]
          if (!r?.proposed) return
          if (use) {
            r.copyFolder = r.proposed.name
            // Never synced with that copy: a difference from this PC's saves is a conflict, none is a restore.
            r.state = { ...r.state, syncedHash: null }
          } else {
            r.declined = [...(r.declined ?? []), r.proposed.name]
            r.copyFolder = copyFolderName(r.title, r.key)
          }
          delete r.proposed
        })
      )
      log.info(`pc saves: ${game.title}: ${use ? 'uses' : 'does not use'} the copy offered`)
      if (running(gameId)) return toView(gameId, (await store.read()).games[gameId])
      return syncDirection(gameId, 'manual')
    },

    async beforePlay(game, context) {
      if (!isEligible(game)) return null
      // Started with Play: the session that starts next is copied after (a refused or failed start leaves none).
      armed.set(game.id, Date.now())
      if (!deps.enabled()) return null
      if (running(game.id)) {
        // Started again while it runs (or streamed by a paired PC while it runs here): copying back now would rewrite
        // the saves under the running game. The new session's end is copied as usual.
        log.info(
          `pc saves: ${game.title} is running: its saves are not copied back before this start`
        )
        return null
      }
      try {
        const rec = (await store.read()).games[game.id]
        if (!rec) return null
        const v = await syncDirection(game.id, 'before-play')
        if (v.conflict || v.confirm) {
          if (context?.streamed) {
            log.info(
              `pc saves: ${game.title} started by a paired PC with its saves question open; it waits for the player here`
            )
            return null
          }
          armed.delete(game.id)
          return {
            kind: 'save-conflict',
            message: v.confirm
              ? tMain('mainPcSaves.launch.confirm', {
                  title: game.title,
                  machine: v.confirm.machine
                })
              : tMain('mainPcSaves.launch.conflict', { title: game.title })
          }
        }
        if (v.error) log.warn(`pc saves: ${game.title}: before play: ${v.error}`)
      } catch (err) {
        log.warn(`pc saves: before play of ${game.title} failed; it starts anyway`, err)
      }
      return null
    },

    afterPlay,

    async noteEmulationFolderMoved(from, to) {
      await store.update((f) => {
        if (f.savesRoot && normalizePath(f.savesRoot) === normalizePath(from)) f.savesRoot = to
      })
    },

    dispose() {
      offEnded?.()
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }
}
