// VR mods (Settings › VR): the bundled VR mod list (resources/vr/vr-mods.json), a GitHub mod's releases and README
// (through the recompilations' conditional-GET cache, only for the mod being looked at: GitHub allows 60 anonymous
// calls an hour), downloads one at a time into the VR Mods folder beside the Recompilations folder, a manual update
// check of the downloaded mods, and removal. What is downloaded is remembered in <userData>/vr-mods.json. Nothing
// downloaded is ever run; linking mods to library games is for later.
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import type { PlayOutApi } from '../../shared/api'
import {
  vrModRepo,
  type InstalledVrMod,
  type VrModEntry,
  type VrModProgress,
  type VrModRelease
} from '../../shared/vr-mods'
import { ensureSevenZip } from '../emulator-setup/sevenzip'
import { runProcess } from '../emulator-setup/run'
import type { Runner } from '../emulator-setup/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import type { AssetHint } from '../recomp/assets'
import type { CachedFetchDeps } from '../recomp/http-cache'
import {
  fetchReadme as realFetchReadme,
  fetchReleases as realFetchReleases,
  isNewer,
  isRepublished,
  latestRelease,
  sameTag,
  sha256FromDigest,
  type GhRelease
} from '../recomp/releases'
import { renameRetry } from '../util/fs'
import { pickVrAsset } from './assets'
import {
  installVrMod as realInstall,
  removeVrModFiles as realRemove,
  vrPlayoutDir,
  type VrInstallDeps
} from './install'
import { tMain } from '../i18n'

export type VrModsMethods = Pick<
  PlayOutApi,
  | 'getVrMods'
  | 'getVrModReleases'
  | 'getVrModReadme'
  | 'downloadVrMod'
  | 'updateVrMod'
  | 'checkVrModUpdates'
  | 'removeVrMod'
  | 'openVrModFolder'
>

export interface VrModsService extends VrModsMethods {
  dispose(): void
}

export interface VrModsServiceDeps {
  userData: string
  /** The VR Mods folder (beside the Recompilations folder). */
  root: () => Promise<string>
  /** resources/vr/vr-mods.json. */
  catalogFile: string
  events: Pick<EventBus, 'emit'>
  /** Open a folder in Explorer (rejects with the shell's message). */
  openPath(path: string): Promise<void>
  log: Logger
  // --- seams (tests) ---
  fetch?: typeof fetch
  fetchReleases?: typeof realFetchReleases
  fetchReadme?: typeof realFetchReadme
  install?: typeof realInstall
  remove?: typeof realRemove
  run?: Runner
  now?: () => Date
}

interface StateFile {
  version: 1
  installed: Record<string, InstalledVrMod>
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The list's entries, dropping anything malformed (the file is generated, but never trusted blindly). */
export function parseCatalog(text: string): {
  mods: VrModEntry[]
  source: string
  updated: string | null
} {
  const data: unknown = JSON.parse(text)
  if (!isObject(data) || !Array.isArray(data.mods)) throw new Error('not a VR mod list')
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const kinds = new Set(['debut', 'alpha', 'tool', 'profile'])
  const mods: VrModEntry[] = []
  const seen = new Set<string>()
  for (const m of data.mods) {
    if (!isObject(m) || typeof m.id !== 'string' || !m.id || typeof m.title !== 'string') continue
    if (seen.has(m.id)) continue
    seen.add(m.id)
    const gh = isObject(m.github) ? m.github : null
    const github =
      gh && typeof gh.owner === 'string' && typeof gh.repo === 'string'
        ? { owner: gh.owner, repo: gh.repo, tag: strOrNull(gh.tag) }
        : null
    mods.push({
      id: m.id,
      title: m.title,
      author: str(m.author),
      date: strOrNull(m.date),
      status: str(m.status),
      kind: kinds.has(m.kind as string) ? (m.kind as VrModEntry['kind']) : 'debut',
      tags: list(m.tags),
      summary: str(m.summary),
      highlights: list(m.highlights),
      page: strOrNull(m.page),
      github,
      thread: strOrNull(m.thread),
      video: strOrNull(m.video),
      reddit: strOrNull(m.reddit),
      outside: m.outside === true,
      accent: strOrNull(m.accent)
    })
  }
  return { mods, source: str(data.source), updated: strOrNull(data.updated) }
}

function parseState(text: string): StateFile {
  const data: unknown = JSON.parse(text)
  const installed: Record<string, InstalledVrMod> = {}
  if (isObject(data) && isObject(data.installed)) {
    for (const [id, rec] of Object.entries(data.installed)) {
      if (!isObject(rec) || typeof rec.dir !== 'string' || typeof rec.tag !== 'string') continue
      const r = rec as unknown as InstalledVrMod
      installed[id] = {
        ...r,
        id,
        title: typeof r.title === 'string' ? r.title : id,
        repo: typeof r.repo === 'string' ? r.repo : '',
        releaseFiles: Array.isArray(r.releaseFiles) ? r.releaseFiles : []
      }
    }
  }
  return { version: 1, installed }
}

/** A downloaded mod the list no longer has: shown from what was remembered. */
function stubMod(rec: InstalledVrMod): VrModEntry {
  const [owner, repo] = rec.repo.split('/')
  return {
    id: rec.id,
    title: rec.title,
    author: owner ?? '',
    date: null,
    status: rec.tag,
    kind: 'debut',
    tags: [],
    summary: tMain('mainVrMods.noLongerListed'),
    highlights: [],
    page: owner && repo ? `https://github.com/${owner}/${repo}` : null,
    github: owner && repo ? { owner, repo, tag: null } : null,
    thread: null,
    video: null,
    reddit: null,
    outside: false,
    accent: null
  }
}

export function createVrModsService(deps: VrModsServiceDeps): VrModsService {
  const log = deps.log
  const now = (): Date => deps.now?.() ?? new Date()
  const fetchReleases = deps.fetchReleases ?? realFetchReleases
  const fetchReadme = deps.fetchReadme ?? realFetchReadme
  const install = deps.install ?? realInstall
  const remove = deps.remove ?? realRemove
  const controller = new AbortController()
  const stateFile = join(deps.userData, 'vr-mods.json')
  const progress = new Map<string, VrModProgress>()
  const updates = new Map<string, string>()
  let queueTail: Promise<void> = Promise.resolve()
  let writeTail: Promise<unknown> = Promise.resolve()
  let disposed = false

  let catalogPromise: Promise<ReturnType<typeof parseCatalog>> | null = null
  function catalog(): Promise<ReturnType<typeof parseCatalog>> {
    catalogPromise ??= fs
      .readFile(deps.catalogFile, 'utf8')
      .then(parseCatalog)
      .catch((err) => {
        log.warn(`VR mod list ${deps.catalogFile}: ${message(err)}`)
        catalogPromise = null
        return { mods: [], source: '', updated: null }
      })
    return catalogPromise
  }

  /**
   * Installed mods whose folder is gone while the VR Mods folder holds one of that name (the user moved the PlayOut
   * folder): their records point there. Checked once per start.
   */
  let dirsHealed = false
  async function healMovedDirs(st: StateFile): Promise<StateFile> {
    if (dirsHealed) return st
    dirsHealed = true
    const root = await deps.root().catch(() => null)
    if (!root) return st
    const fixes = new Map<string, string>()
    for (const [id, rec] of Object.entries(st.installed)) {
      if (!rec.dir || existsSync(rec.dir)) continue
      const here = join(root, basename(rec.dir))
      if (existsSync(here)) fixes.set(id, here)
    }
    if (!fixes.size) return st
    for (const [id, dir] of fixes) {
      log.info(`VR mod ${id}: ${st.installed[id]!.dir} is gone; it is ${dir} now`)
      st.installed[id]!.dir = dir
    }
    await updateState((s) => {
      for (const [id, dir] of fixes) if (s.installed[id]) s.installed[id]!.dir = dir
    }).catch((err) => log.warn(`VR mod folders could not be saved: ${message(err)}`))
    return st
  }

  async function readState(): Promise<StateFile> {
    await writeTail.catch(() => undefined)
    try {
      return await healMovedDirs(parseState(await fs.readFile(stateFile, 'utf8')))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        log.warn(`${stateFile}: ${message(err)}; read as empty`)
      return { version: 1, installed: {} }
    }
  }

  /** Change the state file: serialized, written through a temp file. */
  function updateState(fn: (s: StateFile) => void): Promise<void> {
    const run = writeTail.then(async () => {
      let st: StateFile
      try {
        st = parseState(await fs.readFile(stateFile, 'utf8'))
      } catch {
        st = { version: 1, installed: {} }
      }
      fn(st)
      await fs.mkdir(deps.userData, { recursive: true })
      const tmp = `${stateFile}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(st, null, 2))
      await renameRetry(tmp, stateFile)
    })
    writeTail = run.catch(() => undefined)
    return run
  }

  const httpCache = (): CachedFetchDeps => ({
    dir: join(deps.userData, 'cache', 'vr-mods'),
    fetch: deps.fetch,
    log,
    signal: controller.signal
  })

  const report = (p: VrModProgress): void => {
    progress.set(p.id, p)
    deps.events.emit('vr-mods:progress', p)
  }
  const busy = (id: string): boolean => {
    const p = progress.get(id)
    return !!p && p.phase !== 'done' && p.phase !== 'failed'
  }
  const changed = (ids: string[]): void => deps.events.emit('vr-mods:changed', { ids })

  async function modOf(id: string): Promise<VrModEntry | null> {
    const { mods } = await catalog()
    const hit = mods.find((m) => m.id === id)
    if (hit) return hit
    const rec = (await readState()).installed[id]
    return rec ? stubMod(rec) : null
  }

  async function requireGithub(id: string): Promise<{ mod: VrModEntry; repo: string }> {
    const mod = await modOf(id)
    if (!mod) throw new Error(tMain('mainVrMods.notListed'))
    const repo = vrModRepo(mod)
    if (!repo) throw new Error(tMain('mainVrMods.notOnGithub', { title: mod.title }))
    return { mod, repo }
  }

  const releasesOf = (repo: string, force = false): Promise<GhRelease[]> =>
    fetchReleases({ host: 'github', repo }, httpCache(), { force })

  const hintOf = (rec: InstalledVrMod | null, tag?: string): AssetHint => ({
    pattern: null,
    previousName: rec?.asset ?? null,
    previousTag: rec?.tag ?? null,
    tag: tag ?? null
  })

  /** The newest release with a file PlayOut can keep; a mod with only pre-releases gets its newest pre-release. */
  function newest(releases: GhRelease[], installed: InstalledVrMod | null): GhRelease | null {
    const hint = hintOf(installed)
    const hasDownload = (r: GhRelease): boolean =>
      pickVrAsset(r.assets, { ...hint, tag: r.tag_name }) !== null
    return (
      latestRelease(releases, installed?.tag ?? null, hint, { hasDownload }) ??
      latestRelease(releases, installed?.tag ?? null, hint, { hasDownload, allowPre: true })
    )
  }

  function toRelease(r: GhRelease, installed: InstalledVrMod | null): VrModRelease {
    const picked = pickVrAsset(r.assets, { ...hintOf(installed), tag: r.tag_name })
    return {
      tag: r.tag_name,
      name: r.name?.trim() || r.tag_name,
      publishedAt: r.published_at,
      prerelease: r.prerelease,
      notes: r.body ?? '',
      url: r.html_url,
      asset: picked
        ? {
            name: picked.asset.name,
            size: picked.asset.size,
            sha256: sha256FromDigest(picked.asset.digest)
          }
        : null
    }
  }

  const base = (id: string): VrModProgress => ({
    id,
    phase: 'queued',
    progress: null,
    bytes: null,
    total: null,
    message: null,
    warning: null
  })

  const busyMessage = (id: string): string =>
    progress.get(id)?.phase === 'removing'
      ? tMain('mainVrMods.beingRemoved')
      : tMain('mainVrMods.alreadyDownloading')

  function enqueue(id: string, tag: string | undefined): void {
    if (busy(id)) throw new Error(busyMessage(id))
    report(base(id))
    queueTail = queueTail.then(() => runInstall(id, tag)).catch(() => undefined)
  }

  async function runInstall(id: string, tag: string | undefined): Promise<void> {
    if (disposed) return
    try {
      const { mod, repo } = await requireGithub(id)
      const previous = (await readState()).installed[id] ?? null
      report({ ...base(id), phase: 'checking', message: tMain('mainVrMods.lookingForRelease') })
      const releases = await releasesOf(repo)
      const release = tag
        ? releases.find((r) => !r.draft && sameTag(r.tag_name, tag))
        : newest(releases, previous)
      if (!release)
        throw new Error(
          tag
            ? tMain('mainVrMods.releaseNotFound', { tag, title: mod.title })
            : tMain('mainVrMods.noRelease', { title: mod.title })
        )
      if (
        previous &&
        !tag &&
        sameTag(release.tag_name, previous.tag) &&
        !isRepublished(release, previous, hintOf(previous))
      ) {
        updates.delete(id)
        report({
          ...base(id),
          phase: 'done',
          progress: 1,
          message: tMain('mainVrMods.upToDate', { title: mod.title })
        })
        changed([id])
        return
      }
      const root = await deps.root()
      const http = { fetch: deps.fetch, signal: controller.signal, log }
      const installDeps: VrInstallDeps = {
        root,
        cacheDir: join(vrPlayoutDir(root), 'cache'),
        http,
        sevenZip: () => ensureSevenZip(vrPlayoutDir(root), http),
        run: deps.run ?? runProcess,
        log,
        onProgress: report,
        now
      }
      const record = await install(mod, release, previous, installDeps)
      await updateState((s) => {
        s.installed[id] = {
          ...record,
          installedAt: s.installed[id]?.installedAt ?? record.installedAt
        }
      })
      updates.delete(id)
      changed([id])
    } catch (err) {
      const p = progress.get(id)
      if (!p || (p.phase !== 'failed' && p.phase !== 'done'))
        report({ ...base(id), phase: 'failed', message: message(err) })
      log.warn(`${id}: ${message(err)}`)
    }
  }

  return {
    async getVrMods() {
      const [cat, st] = await Promise.all([catalog(), readState()])
      const listed = new Set(cat.mods.map((m) => m.id))
      const stubs = Object.values(st.installed)
        .filter((r) => !listed.has(r.id))
        .map(stubMod)
      return {
        root: await deps.root(),
        source: cat.source,
        updated: cat.updated,
        mods: [...cat.mods, ...stubs],
        installed: st.installed,
        updates: Object.fromEntries(updates)
      }
    },

    async getVrModReleases(id) {
      const { repo } = await requireGithub(id)
      const installed = (await readState()).installed[id] ?? null
      const releases = await releasesOf(repo)
      return releases.filter((r) => !r.draft).map((r) => toRelease(r, installed))
    },

    async getVrModReadme(id) {
      const { repo } = await requireGithub(id)
      return fetchReadme({ host: 'github', repo }, httpCache())
    },

    async downloadVrMod(id, tag) {
      if (busy(id)) throw new Error(busyMessage(id))
      await requireGithub(id)
      enqueue(id, tag)
    },

    async updateVrMod(id) {
      if (busy(id)) throw new Error(busyMessage(id))
      if (!(await readState()).installed[id]) throw new Error(tMain('mainVrMods.notDownloaded'))
      enqueue(id, undefined)
    },

    async checkVrModUpdates() {
      const st = await readState()
      const found: string[] = []
      for (const rec of Object.values(st.installed)) {
        if (disposed) break
        if (!rec.repo) continue
        try {
          const releases = await releasesOf(rec.repo, true)
          const latest = newest(releases, rec)
          if (
            latest &&
            (isNewer(latest.tag_name, rec.tag, releases) || isRepublished(latest, rec, hintOf(rec)))
          ) {
            updates.set(rec.id, latest.tag_name)
            found.push(rec.id)
          } else updates.delete(rec.id)
        } catch (err) {
          log.warn(`update check of ${rec.id}: ${message(err)}`)
        }
      }
      changed(Object.keys(st.installed))
      return Object.fromEntries(updates)
    },

    async removeVrMod(id) {
      if (busy(id)) {
        throw new Error(
          progress.get(id)?.phase === 'removing'
            ? tMain('mainVrMods.alreadyRemoving')
            : tMain('mainVrMods.downloadingWait')
        )
      }
      // Busy for the whole removal (set before the first await): a download or update of the same mod is refused
      // until the folder and its record are gone, and the renderer disables its buttons meanwhile.
      report({ ...base(id), phase: 'removing', message: tMain('mainVrMods.removing') })
      try {
        const rec = (await readState()).installed[id]
        if (rec) {
          const root = await deps.root()
          await remove(rec, { root, cacheDir: join(vrPlayoutDir(root), 'cache'), log, now })
          await updateState((s) => {
            delete s.installed[id]
          })
          updates.delete(id)
        }
        report({ ...base(id), phase: 'done', message: null })
        if (rec) changed([id])
      } catch (err) {
        report({
          ...base(id),
          phase: 'failed',
          message: tMain('mainVrMods.removeFailed', { error: message(err) })
        })
        throw err
      }
    },

    async openVrModFolder(id) {
      if (id) {
        const rec = (await readState()).installed[id]
        if (!rec) throw new Error(tMain('mainVrMods.notDownloaded'))
        await deps.openPath(rec.dir)
        return
      }
      const root = await deps.root()
      await fs.mkdir(root, { recursive: true })
      await deps.openPath(root)
    },

    dispose() {
      disposed = true
      controller.abort()
    }
  }
}
