// The recompilations manifest, <root>/.playout/recomps.json: what is installed (and the user's choices for each
// install), the preferred recompilation per game title and the cloud folder chosen by older versions (its save copies
// are adopted once into the Emulation folder). Writes are serialized through one
// promise chain and land atomically (temp file + rename); a missing or damaged file reads as empty (a damaged one is
// kept aside as recomps.json.bad).
import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import type { InstalledRecomp, RecompCloudState } from '../../shared/recomp'
import { renameRetry } from '../util/fs'
import { heldEntryValid, validHoldId, type HeldEntry } from '../services/held-files'
import { tMain } from '../i18n'

export interface RecompManifest {
  version: 1
  installed: Record<string, InstalledRecomp>
  /** Title key ("n64:legend of zelda majoras mask") -> the recompilation the user chose. */
  preferred: Record<string, string>
  /**
   * Recompilations the user favourited in the recompilations browser (their ids). A recompilation's own library card
   * (Add to library) shows it as a favourite, and favouriting that card changes this.
   */
  favorites: string[]
  /**
   * The cloud-synced folder older PlayOut versions copied saves into (null = none was chosen). Kept read-only: a
   * recompilation's copy there is adopted once when its copy in the Emulation folder does not exist yet.
   */
  cloudDir: string | null
  /**
   * The save copies moved to the Emulation folder: every record was switched on once and its last-synced hash
   * forgotten (it described the old cloud copy). False in manifests from older versions.
   */
  savesMigrated: boolean
  /**
   * The Emulation folder the stored last-synced hashes refer to. When the Emulation folder changes (Settings › Library),
   * every last-synced hash is forgotten: a copy already in the new folder that differs from the saves is a conflict
   * for the user, never a silent copy back over them.
   */
  savesRoot: string | null
  /**
   * The "Delete the original disc image?" questions (image-offer.ts), by "<recompId>|<image path, normalized>":
   * waiting for an answer, kept (never asked again) or deleted (moved to the Recycle Bin). Kept apart from `installed`
   * so an uninstall and reinstall does not ask again.
   */
  imageOffers: Record<string, RecompImageOfferRecord>
  /**
   * Game folders PlayOut itself unpacked for a setup program that takes the game unpacked (game-folder.ts), by their
   * path normalized: only these are ever offered for deletion ("Delete the unpacked game folder"). `state` is the
   * folder's own answer: 'unpacked' (not answered yet), 'kept' (Keep it, or only the disc image was deleted in a
   * question that offered it) or 'deleted' (moved to the Recycle Bin). A new unpack into it starts again at 'unpacked'.
   */
  unpackedFolders: Record<string, RecompUnpackedFolderRecord>
  /**
   * Disc images (and unpacked game folders) a Delete answer moved aside while the recompilation is started to check it
   * runs without them (services/held-files.ts), by hold id. Written before anything moves, so a file is never lost:
   * an item left here at start (PlayOut closed during the test) is asked about again.
   */
  heldImages: Record<string, RecompHeldRecord>
}

/** One item moved aside for a test run (RecompManifest.heldImages). */
export interface RecompHeldRecord {
  holdId: string
  recompId: string
  gameId: string
  /** The question it answered (its key in imageOffers): Restore remembers that image as kept. */
  offerKey: string
  /** The disc image (the card's own file) moved aside; null when only the folder was. */
  image: string | null
  /** The unpacked game folder moved aside; null when only the image was. */
  folder: string | null
  /** Every file or folder moved aside (or about to be), in the order they moved. */
  entries: HeldEntry[]
  /** When it was moved aside (ISO). */
  at: string
  /**
   * 'holding': being moved aside; 'testing': moved, the test runs; else the verdict (RecompHeldImage.state), kept until
   * the player answers.
   */
  state: 'holding' | 'testing' | 'crashed' | 'not-tested' | 'passed'
  reason: string | null
  decidedAt: string | null
}

/**
 * One delete question as the manifest keeps it: about a disc image (`image`), the unpacked game folder (`folder`), or
 * both. `state` is the question's and the image's own answer (a folder-only question's: the folder's).
 */
export interface RecompImageOfferRecord {
  state: 'pending' | 'kept' | 'deleted'
  recompId: string
  gameId: string
  /** The image's path when it was asked; null in a question about the unpacked game folder only. */
  image: string | null
  /** The unpacked game folder the question also offers (RecompUnpackedFolderRecord.folder), if any. */
  folder?: string | null
  /** When it was asked (ISO). */
  at: string
}

/** A game folder PlayOut unpacked for a setup program (RecompManifest.unpackedFolders). */
export interface RecompUnpackedFolderRecord {
  folder: string
  recompId: string
  /** The library game whose disc image was unpacked. */
  gameId: string
  /** When PlayOut unpacked it (ISO). */
  at: string
  state: 'unpacked' | 'kept' | 'deleted'
}

export interface RecompState {
  /** The manifest (a copy; waits for writes in flight). */
  read(): Promise<RecompManifest>
  /** Change the manifest: `fn` mutates the copy it gets; it is written when `fn` resolves (a throw writes nothing). */
  update(fn: (m: RecompManifest) => void | Promise<void>): Promise<RecompManifest>
}

export function emptyManifest(): RecompManifest {
  return {
    version: 1,
    installed: {},
    preferred: {},
    favorites: [],
    cloudDir: null,
    savesMigrated: false,
    savesRoot: null,
    imageOffers: {},
    unpackedFolders: {},
    heldImages: {}
  }
}

/** A new install's save-copy state: on (saves are copied to the Emulation folder unless the user turns it off). */
export function defaultCloudState(): RecompCloudState {
  return {
    enabled: true,
    syncedHash: null,
    localHash: null,
    syncedAt: null,
    pending: false,
    error: null,
    conflict: null
  }
}

/** <root>/.playout: PlayOut's own files beside the installs. */
export function recompPlayoutDir(root: string): string {
  return join(root, '.playout')
}

export function recompManifestPath(root: string): string {
  return join(recompPlayoutDir(root), 'recomps.json')
}

/** Where player-file backups of one recompilation go (before updates and uninstalls). */
export function recompBackupsDir(root: string, safeId: string): string {
  return join(recompPlayoutDir(root), 'backups', safeId)
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0

const SAVE_SOURCES = new Set(['user', 'catalog', 'developer', 'detected', 'install'])

function normalizeCloud(v: unknown): RecompCloudState {
  const d = defaultCloudState()
  if (!isObject(v)) return d
  const c = isObject(v.conflict) ? v.conflict : null
  return {
    // A stored state keeps its switch (an older manifest's "off" is switched on once by the migration in service.ts).
    enabled: v.enabled === true,
    syncedHash: str(v.syncedHash),
    localHash: str(v.localHash),
    syncedAt: str(v.syncedAt),
    pending: v.pending === true,
    error: str(v.error),
    conflict: c
      ? {
          localAt: str(c.localAt) ?? '',
          cloudAt: str(c.cloudAt) ?? '',
          cloudDevice: str(c.cloudDevice) ?? '',
          ...(c.gone === true ? { gone: true } : {})
        }
      : null,
    ...(v.freshStart === true ? { freshStart: true } : {})
  }
}

/** A stored exeIdentified, or null when it is not one. */
function identified(v: unknown): InstalledRecomp['exeIdentified'] | null {
  if (!isObject(v)) return null
  const exe = str(v.exe)
  if (!exe || (v.by !== 'player' && v.by !== 'auto')) return null
  return { exe, by: v.by, starts: Math.floor(count(v.starts)) }
}

const OFFER_STATES = new Set(['pending', 'kept', 'deleted'])
const FOLDER_STATES = new Set(['unpacked', 'kept', 'deleted'])

/** One installed record with every field present (a file from an older PlayOut, or hand-edited). Null = unusable. */
function normalizeInstalled(id: string, v: unknown): InstalledRecomp | null {
  if (!isObject(v)) return null
  const dir = str(v.dir)
  const tag = str(v.tag)
  if (!dir || tag === null) return null
  const gameFiles: InstalledRecomp['gameFiles'] = {}
  if (isObject(v.gameFiles))
    for (const [need, choice] of Object.entries(v.gameFiles)) {
      if (!isObject(choice)) continue
      const path = str(choice.path)
      if (path)
        gameFiles[need] = { path, source: choice.source === 'library' ? 'library' : 'picked' }
    }
  const verified = v.verified === 'scanned' || v.verified === 'github' ? v.verified : 'unverified'
  const now = new Date(0).toISOString()
  return {
    id,
    dir,
    tag,
    asset: str(v.asset) ?? '',
    downloadBytes: count(v.downloadBytes),
    diskBytes: typeof v.diskBytes === 'number' ? count(v.diskBytes) : null,
    sha256: str(v.sha256) ?? '',
    verified,
    exe: str(v.exe),
    // The user's own program choice (absent in manifests from older versions: PlayOut's pick).
    ...(v.exeChosen === 'user' && str(v.exe)
      ? { exeChosen: 'user' as const, autoExe: str(v.autoExe) }
      : v.exeChosen === 'confirmed'
        ? { exeChosen: 'confirmed' as const }
        : {}),
    ...(identified(v.exeIdentified) ? { exeIdentified: identified(v.exeIdentified)! } : {}),
    // Starts still to come before the disc image question (the original arrived late): kept while it counts down.
    ...(Number.isInteger(v.imageAskAfter) &&
    (v.imageAskAfter as number) > 0 &&
    (v.imageAskAfter as number) <= 10
      ? { imageAskAfter: v.imageAskAfter as number }
      : {}),
    installedAt: str(v.installedAt) ?? now,
    updatedAt: str(v.updatedAt) ?? str(v.installedAt) ?? now,
    releaseFiles: strings(v.releaseFiles),
    autoUpdate: v.autoUpdate === true,
    gameFiles,
    savePaths: strings(v.savePaths),
    saveSource: SAVE_SOURCES.has(v.saveSource as string)
      ? (v.saveSource as InstalledRecomp['saveSource'])
      : null,
    ...(Array.isArray(v.saveSuggestions) ? { saveSuggestions: strings(v.saveSuggestions) } : {}),
    ...(str(v.saveCopyFolder) ? { saveCopyFolder: str(v.saveCopyFolder)! } : {}),
    ...(v.oldCopyAdopted === true ? { oldCopyAdopted: true } : {}),
    cloud: normalizeCloud(v.cloud),
    prevTag: str(v.prevTag),
    // Absent in records from older PlayOut versions: follows the newest release.
    pinnedTag: str(v.pinnedTag),
    ...(str(v.publishedAt) ? { publishedAt: str(v.publishedAt) } : {})
  }
}

/** A parsed manifest made whole; throws when it is not a manifest at all. */
export function parseRecompManifest(text: string): RecompManifest {
  const data: unknown = JSON.parse(text)
  if (!isObject(data)) throw new Error('not a recompilations manifest')
  const m = emptyManifest()
  if (isObject(data.installed))
    for (const [id, v] of Object.entries(data.installed)) {
      const rec = normalizeInstalled(id, v)
      if (rec) m.installed[id] = rec
    }
  if (isObject(data.preferred))
    for (const [key, id] of Object.entries(data.preferred))
      if (typeof id === 'string') m.preferred[key] = id
  if (Array.isArray(data.favorites))
    m.favorites = [
      ...new Set(data.favorites.filter((id): id is string => typeof id === 'string' && !!id))
    ]
  m.cloudDir = str(data.cloudDir)
  m.savesMigrated = data.savesMigrated === true
  m.savesRoot = str(data.savesRoot)
  if (isObject(data.imageOffers))
    for (const [key, v] of Object.entries(data.imageOffers)) {
      if (!isObject(v) || !OFFER_STATES.has(v.state as string)) continue
      const recompId = str(v.recompId)
      const gameId = str(v.gameId)
      const image = str(v.image)
      const folder = str(v.folder)
      if (!recompId || !gameId || (!image && !folder)) continue
      m.imageOffers[key] = {
        state: v.state as RecompImageOfferRecord['state'],
        recompId,
        gameId,
        image,
        ...(folder ? { folder } : {}),
        at: str(v.at) ?? new Date(0).toISOString()
      }
    }
  if (isObject(data.unpackedFolders))
    for (const [key, v] of Object.entries(data.unpackedFolders)) {
      if (!isObject(v) || !FOLDER_STATES.has(v.state as string)) continue
      const folder = str(v.folder)
      const recompId = str(v.recompId)
      const gameId = str(v.gameId)
      if (!folder || !recompId || !gameId) continue
      m.unpackedFolders[key] = {
        folder,
        recompId,
        gameId,
        at: str(v.at) ?? new Date(0).toISOString(),
        state: v.state as RecompUnpackedFolderRecord['state']
      }
    }
  if (isObject(data.heldImages))
    for (const [holdId, v] of Object.entries(data.heldImages)) {
      if (!isObject(v) || !validHoldId(holdId) || !HELD_STATES.has(v.state as string)) continue
      const recompId = str(v.recompId)
      const gameId = str(v.gameId)
      if (!recompId || !gameId || !Array.isArray(v.entries)) continue
      // Only entries PlayOut itself made for this hold (held-files.ts heldEntryValid): nothing else is ever moved.
      const entries: HeldEntry[] = []
      for (const e of v.entries) {
        if (!isObject(e)) continue
        const original = str(e.original)
        const held = str(e.held)
        if (original && held && heldEntryValid({ original, held }, holdId))
          entries.push({ original, held })
      }
      m.heldImages[holdId] = {
        holdId,
        recompId,
        gameId,
        offerKey: str(v.offerKey) ?? '',
        image: str(v.image),
        folder: str(v.folder),
        entries,
        at: str(v.at) ?? new Date(0).toISOString(),
        state: v.state as RecompHeldRecord['state'],
        reason: str(v.reason),
        decidedAt: str(v.decidedAt)
      }
    }
  return m
}

const HELD_STATES = new Set(['holding', 'testing', 'crashed', 'not-tested', 'passed'])

/** Retries of a manifest read that fails with something other than "not found". */
const READ_RETRIES = 4

/** The manifest of `root` with serialized, atomic writes. */
export function createRecompState(root: string): RecompState {
  const file = recompManifestPath(root)
  let current: RecompManifest | null = null
  /** Every read and write runs after the previous one. */
  let chain: Promise<unknown> = Promise.resolve()

  async function load(): Promise<RecompManifest> {
    if (current) return current
    // Missing (first run): start empty. Any other read error (a lock by antivirus or a sync client, permissions, an
    // online-only placeholder) is retried a few times, then thrown — never taken for an empty manifest, which the
    // next write would put over every install record. Nothing is cached, so the next call tries again.
    let text: string | null = null
    for (let i = 0; ; i++) {
      try {
        text = await fs.readFile(file, 'utf8')
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') break
        if (i >= READ_RETRIES) {
          throw new Error(
            tMain('mainRecomp.listUnreadable', { file, error: (err as Error).message }),
            { cause: err }
          )
        }
        await new Promise((ok) => setTimeout(ok, 150 * (i + 1)))
      }
    }
    if (text === null) return (current = emptyManifest())
    try {
      return (current = parseRecompManifest(text))
    } catch {
      // Damaged: kept aside for a person to look at, and the next write starts a fresh file.
      await renameRetry(file, `${file}.bad`).catch(() => undefined)
      return (current = emptyManifest())
    }
  }

  async function write(m: RecompManifest): Promise<void> {
    await fs.mkdir(recompPlayoutDir(root), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(m, null, 2), 'utf8')
    await renameRetry(tmp, file)
  }

  function queue<T>(job: () => Promise<T>): Promise<T> {
    const run = chain.then(job, job)
    chain = run.catch(() => undefined)
    return run
  }

  return {
    read: () => queue(async () => structuredClone(await load())),
    update: (fn) =>
      queue(async () => {
        const draft = structuredClone(await load())
        await fn(draft)
        await write(draft)
        current = draft
        return structuredClone(draft)
      })
  }
}

/** %ProgramFiles%, %ProgramW6432% and %ProgramFiles(x86)% (the ones that are set). */
function defaultProgramFilesDirs(): string[] {
  return [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env['ProgramFiles(x86)']
  ].filter((d): d is string => !!d)
}

/** True when `dir` is one of `parents` or inside one (case-insensitive: Windows paths). */
function isUnder(dir: string, parents: readonly string[]): boolean {
  const child = resolve(dir).toLowerCase()
  return parents.some((p) => {
    const parent = resolve(p)
      .toLowerCase()
      .replace(/[\\/]+$/, '')
    return child === parent || child.startsWith(parent + sep)
  })
}

/** True when `dir` can be made and written (a small file is written and deleted). */
async function writable(dir: string): Promise<boolean> {
  const probe = join(dir, `.playout-write-test-${process.pid}-${Date.now()}`)
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(probe, 'ok')
    await fs.rm(probe, { force: true })
    return true
  } catch {
    await fs.rm(probe, { force: true }).catch(() => undefined)
    return false
  }
}

/** The two places recompilations can live: next to PlayOut.exe, else in the settings folder. */
export function recompRootCandidates(exeDir: string, userData: string): [string, string] {
  return [join(exeDir, 'Recompilations'), join(userData, 'Recompilations')]
}

async function hasInstalls(root: string): Promise<boolean> {
  try {
    return (
      Object.keys(
        parseRecompManifest(await fs.readFile(recompManifestPath(root), 'utf8')).installed
      ).length > 0
    )
  } catch {
    return false
  }
}

/**
 * Where recompilations are installed: <exeDir>/Recompilations when it can be written and is not under Program Files
 * (a run without elevation cannot write there), else <userData>/Recompilations. A root that already holds installs
 * wins, so moving PlayOut or a permissions change never hides what is installed.
 */
export async function resolveRecompRoot(
  exeDir: string,
  userData: string,
  opts: { programFilesDirs?: string[] } = {}
): Promise<string> {
  const [preferred, fallback] = recompRootCandidates(exeDir, userData)
  const candidates = isUnder(preferred, opts.programFilesDirs ?? defaultProgramFilesDirs())
    ? [fallback]
    : [preferred, fallback]
  for (const candidate of candidates) if (await hasInstalls(candidate)) return candidate
  if (candidates[0] === preferred && (await writable(preferred))) return preferred
  await fs.mkdir(fallback, { recursive: true }).catch(() => undefined)
  return fallback
}
