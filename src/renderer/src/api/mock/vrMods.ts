// VR mods in the mock (src/main/vr-mods/): a few entries shaped like the real list. Final Fantasy 16 VR is
// downloaded one release behind (its update shows); Edge of Eternity VR and the UEVR nightly are GitHub mods to
// download; the Silent Hill f profile ships a .uevrz kept as it is; Star Wars Pinball is Quest-only (an .apk, so no
// download here); Silent Hill Townfall VR is on Nexus Mods (Open page only). Downloads walk through the real phases
// with 'vr-mods:progress'; every change emits 'vr-mods:changed'.
import type { PlayOutApi } from '@shared/api'
import type {
  InstalledVrMod,
  VrModEntry,
  VrModProgress,
  VrModRelease,
  VrModsView
} from '@shared/vr-mods'
import type { MockEmitter } from './emitter'

export type VrModsApi = Pick<
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

export interface VrModsMockDeps {
  emitter: MockEmitter
  log?: (...args: unknown[]) => void
}

export const MOCK_VR_ROOT = 'C:\\Games\\PlayOut\\VR Mods'
export const FF16_VR = 'final-fantasy-16-vr'
export const EDGE_VR = 'edge-of-eternity-vr'
export const UEVR_NIGHTLY = 'uevr-nightly'
export const SILENT_HILL_F_PROFILE = 'silent-hill-f-uevr-profile'
export const PINBALL_QUEST = 'star-wars-pinball-vr-quest'
export const TOWNFALL_NEXUS = 'silent-hill-townfall-vr'

const STEP_MS = 300
const DOWNLOAD_TICKS = 8
/** How long one mock download takes from 'checking' to 'done'. */
export const VR_DOWNLOAD_MS = STEP_MS * (4 + DOWNLOAD_TICKS)
const MB = 1024 * 1024
const UNVERIFIED_WARNING =
  'This download has no published checksum, so PlayOut could not verify it.'
const SHA = (c: string): string => c.repeat(64).slice(0, 64)

function mod(partial: Partial<VrModEntry> & Pick<VrModEntry, 'id' | 'title'>): VrModEntry {
  return {
    author: '',
    date: '2026-10-29',
    status: '',
    kind: 'debut',
    tags: ['PCVR'],
    summary: '',
    highlights: [],
    page: null,
    github: null,
    thread: 'https://discord.com/channels/747967102895390741/1565211785726795876',
    video: null,
    reddit: null,
    outside: false,
    accent: null,
    ...partial
  }
}

const gh = (owner: string, repo: string, tag: string | null = null): Partial<VrModEntry> => ({
  page: `https://github.com/${owner}/${repo}${tag ? `/releases/tag/${tag}` : ''}`,
  github: { owner, repo, tag }
})

function catalog(): VrModEntry[] {
  return [
    mod({
      id: FF16_VR,
      title: 'Final Fantasy 16 VR',
      author: 'markmon (mark-mon)',
      status: 'v0.9.0 beta',
      kind: 'alpha',
      accent: '#ff806c',
      tags: ['PCVR', 'VRS foveated rendering', 'third person, gamepad'],
      summary:
        'A Final Fantasy XVI VR mod released as v0.9.0 beta; the author thinks it is fully playable. VRS foveated rendering helps performance.',
      highlights: ['Quad views rendering tried and dropped', 'DLSS ghosting being worked on'],
      video: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      ...gh('mark-mon', 'final-fantasy-16-vr')
    }),
    mod({
      id: EDGE_VR,
      title: 'Edge of Eternity VR',
      author: 'markmon (mark-mon)',
      status: 'First build',
      accent: '#baf56a',
      tags: ['PCVR', 'gamepad', 'third-person'],
      summary: 'VR mod for Edge of Eternity, a third-person action JRPG, played with a gamepad.',
      highlights: ['Gamepad play', 'Part of a run of markmon releases'],
      ...gh('mark-mon', 'edge-of-eternity-vr')
    }),
    mod({
      id: SILENT_HILL_F_PROFILE,
      title: 'Silent Hill f UEVR profile',
      author: 'keton',
      date: '2026-10-21',
      status: 'Profile v3',
      kind: 'profile',
      accent: '#8fd3ff',
      tags: ['PCVR', 'UEVR profile', 'motion controls'],
      summary: 'A UEVR profile with motion controls and a fixed HUD for Silent Hill f.',
      reddit: 'https://www.reddit.com/r/virtualreality/comments/1x0000/silent_hill_f_uevr/',
      ...gh('keton', 'silent-hill-f-uevr', 'v3')
    }),
    mod({
      id: UEVR_NIGHTLY,
      title: 'UEVR nightly',
      author: 'praydog',
      date: '2026-10-12',
      status: 'Nightly 1123',
      kind: 'tool',
      accent: '#ffd477',
      tags: ['PCVR', 'Unreal Engine', 'injector'],
      summary: 'The universal Unreal Engine VR injector, nightly build.',
      highlights: ['Most UEVR profiles need a recent nightly'],
      ...gh('praydog', 'UEVR-nightly')
    }),
    mod({
      id: PINBALL_QUEST,
      title: 'Star Wars Pinball VR (Quest port)',
      author: 'questporter',
      date: '2026-10-05',
      status: 'v1.2',
      accent: '#c792ea',
      tags: ['Quest standalone', 'native mod'],
      summary: 'A standalone Quest port, installed on the headset with SideQuest.',
      outside: true,
      ...gh('questporter', 'swpinball-quest')
    }),
    mod({
      id: TOWNFALL_NEXUS,
      title: 'Silent Hill Townfall VR',
      author: 'Ripper',
      date: '2026-09-30',
      status: 'v1.0',
      accent: '#ff9ec7',
      tags: ['PCVR', 'motion controls'],
      summary: 'Full motion controls for Silent Hill Townfall, published on Nexus Mods.',
      page: 'https://www.nexusmods.com/silenthilltownfall/mods/122'
    })
  ]
}

function release(
  tag: string,
  publishedAt: string,
  asset: VrModRelease['asset'],
  extra: Partial<VrModRelease> = {}
): VrModRelease {
  return {
    tag,
    name: tag,
    publishedAt,
    prerelease: false,
    notes: `## ${tag}\n\n- Fixes and improvements.`,
    url: `https://github.com/example/releases/tag/${tag}`,
    asset,
    ...extra
  }
}

function releasesFor(id: string): VrModRelease[] {
  switch (id) {
    case FF16_VR:
      return [
        release('v0.9.0', '2026-10-29T18:00:00Z', {
          name: 'FF16VR-v0.9.0.zip',
          size: 42 * MB,
          sha256: SHA('a')
        }),
        release('v0.8.0', '2026-10-20T18:00:00Z', {
          name: 'FF16VR-v0.8.0.zip',
          size: 40 * MB,
          sha256: SHA('b')
        })
      ]
    case EDGE_VR:
      return [
        release('v0.1.0', '2026-10-29T12:00:00Z', {
          name: 'EdgeOfEternityVR.zip',
          size: 18 * MB,
          sha256: SHA('c')
        })
      ]
    case SILENT_HILL_F_PROFILE:
      return [
        release('v3', '2026-10-21T09:00:00Z', {
          name: 'SilentHillf.uevrz',
          size: Math.round(0.4 * MB),
          sha256: null
        })
      ]
    case UEVR_NIGHTLY:
      return [
        release(
          'nightly-1123',
          '2026-10-12T03:00:00Z',
          { name: 'uevr.zip', size: 9 * MB, sha256: SHA('d') },
          { prerelease: true }
        )
      ]
    case PINBALL_QUEST:
      return [release('v1.2', '2026-10-05T10:00:00Z', null)]
    default:
      return []
  }
}

function readmeFor(m: VrModEntry): string {
  return [
    `# ${m.title}`,
    '',
    m.summary,
    '',
    '## Installing',
    '',
    '1. Download the release and unpack it next to the game.',
    '2. Start the game with your headset connected.',
    '',
    'PlayOut keeps the download in its VR Mods folder; follow these steps to use it.'
  ].join('\n')
}

const safeFolder = (m: VrModEntry): string =>
  `${m.title.replace(/[<>:"/\\|?*]+/g, ' ').trim()} (${m.id})`

export function createVrModsMock(deps: VrModsMockDeps): { api: VrModsApi } {
  const { emitter } = deps
  const log = deps.log ?? (() => undefined)
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const clone = <T>(value: T): T => structuredClone(value)
  const mods = catalog()
  const byId = new Map(mods.map((m) => [m.id, m]))
  const releases = new Map(mods.map((m) => [m.id, releasesFor(m.id)]))
  const installed = new Map<string, InstalledVrMod>()
  const updates = new Map<string, string>()
  const progress = new Map<string, VrModProgress>()
  let queueTail: Promise<void> = Promise.resolve()

  // Final Fantasy 16 VR: downloaded one release behind.
  {
    const m = byId.get(FF16_VR)!
    installed.set(FF16_VR, {
      id: FF16_VR,
      title: m.title,
      repo: 'mark-mon/final-fantasy-16-vr',
      dir: `${MOCK_VR_ROOT}\\${safeFolder(m)}`,
      tag: 'v0.8.0',
      publishedAt: '2026-10-20T18:00:00Z',
      asset: 'FF16VR-v0.8.0.zip',
      downloadBytes: 40 * MB,
      diskBytes: 96 * MB,
      sha256: SHA('b'),
      verified: 'github',
      releaseFiles: ['ff16vr.dll', 'ff16vr.ini'],
      installedAt: '2026-10-21T08:00:00Z',
      updatedAt: '2026-10-21T08:00:00Z'
    })
    updates.set(FF16_VR, 'v0.9.0')
  }

  const report = (p: VrModProgress): void => {
    progress.set(p.id, p)
    emitter.emit('vr-mods:progress', clone(p))
  }
  const busy = (id: string): boolean => {
    const p = progress.get(id)
    return !!p && p.phase !== 'done' && p.phase !== 'failed'
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
  const requireMod = (id: string): VrModEntry => {
    const m = byId.get(id)
    if (!m) throw new Error(`Unknown VR mod ${id}`)
    return m
  }
  const requireGithub = (id: string): VrModEntry => {
    const m = requireMod(id)
    if (!m.github) throw new Error(`${m.title} is not on GitHub: open its page to get it.`)
    return m
  }
  const newest = (id: string): VrModRelease | null => {
    const list = (releases.get(id) ?? []).filter((r) => r.asset)
    return list.find((r) => !r.prerelease) ?? list[0] ?? null
  }

  async function runDownload(id: string, tag: string | undefined): Promise<void> {
    const m = requireMod(id)
    report({ ...base(id), phase: 'checking', message: 'Looking for the newest release…' })
    await sleep(STEP_MS)
    const r = tag ? (releases.get(id) ?? []).find((x) => x.tag === tag) : newest(id)
    if (!r?.asset) {
      report({
        ...base(id),
        phase: 'failed',
        message: `${m.title} has no release PlayOut can download (it may be for Quest, or packed in a way PlayOut cannot open): open its page.`
      })
      return
    }
    const previous = installed.get(id)
    if (previous && !tag && previous.tag === r.tag) {
      report({ ...base(id), phase: 'done', progress: 1, message: `${m.title} is up to date` })
      return
    }
    const total = r.asset.size
    const warning = r.asset.sha256 ? null : UNVERIFIED_WARNING
    for (let i = 1; i <= DOWNLOAD_TICKS; i++) {
      await sleep(STEP_MS)
      report({
        ...base(id),
        phase: 'downloading',
        progress: i / DOWNLOAD_TICKS,
        bytes: Math.round((total * i) / DOWNLOAD_TICKS),
        total,
        warning
      })
    }
    report({ ...base(id), phase: 'verifying', total, warning })
    await sleep(STEP_MS)
    report({ ...base(id), phase: 'extracting', total, warning })
    await sleep(STEP_MS)
    report({ ...base(id), phase: 'installing', total, warning })
    await sleep(STEP_MS)
    const at = new Date().toISOString()
    installed.set(id, {
      id,
      title: m.title,
      repo: `${m.github!.owner}/${m.github!.repo}`,
      dir: previous?.dir ?? `${MOCK_VR_ROOT}\\${safeFolder(m)}`,
      tag: r.tag,
      publishedAt: r.publishedAt,
      asset: r.asset.name,
      downloadBytes: total,
      diskBytes: Math.round(total * (r.asset.name.endsWith('.zip') ? 2.3 : 1)),
      sha256: r.asset.sha256 ?? SHA('e'),
      verified: r.asset.sha256 ? 'github' : 'unverified',
      releaseFiles: [r.asset.name.toLowerCase()],
      installedAt: previous?.installedAt ?? at,
      updatedAt: at
    })
    updates.delete(id)
    report({
      ...base(id),
      phase: 'done',
      progress: 1,
      message: `${m.title} ${r.tag} is downloaded`,
      warning
    })
    emitter.emit('vr-mods:changed', { ids: [id] })
  }

  const busyMessage = (id: string): string =>
    progress.get(id)?.phase === 'removing'
      ? 'That VR mod is being removed; wait for it to finish.'
      : 'That VR mod is already downloading.'

  function enqueue(id: string, tag: string | undefined): void {
    if (busy(id)) throw new Error(busyMessage(id))
    report(base(id))
    queueTail = queueTail.then(() => runDownload(id, tag)).catch(() => undefined)
  }

  const api: VrModsApi = {
    async getVrMods(): Promise<VrModsView> {
      return {
        root: MOCK_VR_ROOT,
        source:
          'https://htmlpreview.github.io/?https://gist.githubusercontent.com/elliotttate/62874c06da42b6942587038711742bb2/raw/index.html',
        updated: '2026-10-29',
        mods: clone(mods),
        installed: Object.fromEntries([...installed].map(([k, v]) => [k, clone(v)])),
        updates: Object.fromEntries(updates)
      }
    },
    async getVrModReleases(id) {
      requireGithub(id)
      await sleep(STEP_MS)
      return clone(releases.get(id) ?? [])
    },
    async getVrModReadme(id) {
      const m = requireGithub(id)
      await sleep(STEP_MS)
      return readmeFor(m)
    },
    async downloadVrMod(id, tag) {
      requireGithub(id)
      enqueue(id, tag ?? undefined)
    },
    async updateVrMod(id) {
      if (!installed.has(id)) throw new Error('That VR mod is not downloaded.')
      enqueue(id, undefined)
    },
    async checkVrModUpdates() {
      await sleep(STEP_MS)
      for (const rec of installed.values()) {
        const latest = newest(rec.id)
        if (latest && latest.tag !== rec.tag) updates.set(rec.id, latest.tag)
        else updates.delete(rec.id)
      }
      emitter.emit('vr-mods:changed', { ids: [...installed.keys()] })
      return Object.fromEntries(updates)
    },
    async removeVrMod(id) {
      if (busy(id)) {
        throw new Error(
          progress.get(id)?.phase === 'removing'
            ? 'That VR mod is already being removed.'
            : 'That VR mod is downloading; wait for it to finish.'
        )
      }
      if (!installed.has(id)) return
      // Busy while the folder is deleted, as main does: a download of it is refused meanwhile.
      report({ ...base(id), phase: 'removing', message: 'Removing…' })
      await sleep(STEP_MS)
      installed.delete(id)
      updates.delete(id)
      report({ ...base(id), phase: 'done', message: null })
      emitter.emit('vr-mods:changed', { ids: [id] })
    },
    async openVrModFolder(id) {
      if (id) {
        const rec = installed.get(id)
        if (!rec) throw new Error('That VR mod is not downloaded.')
        log(`openVrModFolder(${rec.dir})`)
        return
      }
      log(`openVrModFolder(${MOCK_VR_ROOT})`)
    }
  }
  return { api }
}
