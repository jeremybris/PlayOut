// The VR mod browser's search, filters, sort and the words it shows (VrBrowser.tsx, Settings › VR): pure, so they
// are tested on their own.
import {
  VR_MOD_KIND_LABELS,
  vrModRepo,
  type InstalledVrMod,
  type VrModEntry,
  type VrModKind,
  type VrModProgress
} from '@shared/vr-mods'
import { t } from '../../i18n'
import { formatBytes } from '../../lib/format'
import { foldText } from '../Recomp/browseView'
import { progressText } from '../Settings/sections/recompText'

export type VrFilter = 'all' | 'debut' | 'alpha' | 'tool' | 'profile' | 'quest' | 'installed'

/** The filter chips, labelled in the current language (built when shown, never kept). */
export function vrFilters(): { value: VrFilter; label: string }[] {
  return [
    { value: 'all', label: t('vrMods.filters.all') },
    { value: 'debut', label: t('vrMods.filters.debut') },
    { value: 'alpha', label: t('vrMods.filters.alpha') },
    { value: 'tool', label: t('vrMods.filters.tool') },
    { value: 'profile', label: t('vrMods.filters.profile') },
    { value: 'quest', label: t('vrMods.filters.quest') },
    { value: 'installed', label: t('vrMods.filters.installed') }
  ]
}

export type VrSort = 'newest' | 'oldest' | 'title'

/** The sort choices, labelled in the current language. */
export function vrSorts(): { value: VrSort; label: string }[] {
  return [
    { value: 'newest', label: t('vrMods.sorts.newest') },
    { value: 'oldest', label: t('vrMods.sorts.oldest') },
    { value: 'title', label: t('vrMods.sorts.title') }
  ]
}

/** A mod's kind in words (the chip and the row); the shared English labels stay for search. */
export function kindLabel(kind: VrModKind): string {
  switch (kind) {
    case 'debut':
      return t('vrMods.kind.debut')
    case 'alpha':
      return t('vrMods.kind.alpha')
    case 'tool':
      return t('vrMods.kind.tool')
    case 'profile':
      return t('vrMods.kind.profile')
  }
}

/** Plays on a Quest by itself (an .apk or a port), by the list's tags. */
export function isQuestMod(mod: Pick<VrModEntry, 'tags'>): boolean {
  return mod.tags.some((tag) => /\bquest\b.*\b(standalone|apk)\b/i.test(tag))
}

/** A PC VR build is mentioned in the list's tags ("PCVR", "Windows build", "OpenXR", "SteamVR", "Quest Link"). */
function hasPcBuild(mod: Pick<VrModEntry, 'tags'>): boolean {
  return mod.tags.some((tag) =>
    /\bpc ?vr\b|\bwindows\b|\bopenxr\b|\bsteamvr\b|\bquest link\b/i.test(tag)
  )
}

/** Only for a Quest by itself: nothing PlayOut could keep on this PC, so its page is the way to get it. */
export function isQuestOnlyMod(mod: Pick<VrModEntry, 'tags'>): boolean {
  return isQuestMod(mod) && !hasPcBuild(mod)
}

/** What a mod is searched by: title, author, status, tags, summary, highlights and its GitHub repository. */
function haystack(mod: VrModEntry): { words: string; compact: string } {
  const words = foldText(
    [
      mod.title,
      mod.author,
      mod.status,
      VR_MOD_KIND_LABELS[mod.kind],
      ...mod.tags,
      mod.summary,
      ...mod.highlights,
      vrModRepo(mod) ?? ''
    ].join(' ')
  )
  return { words, compact: words.replace(/ /g, '') }
}

/** Every word of the query must be found (as words, or with the spaces removed). */
export function searchMods(mods: VrModEntry[], query: string): VrModEntry[] {
  const q = foldText(query)
  if (!q) return mods
  const parts = q.split(' ')
  return mods.filter((m) => {
    const h = haystack(m)
    return parts.every((p) => h.words.includes(p) || h.compact.includes(p))
  })
}

export function filterMods(
  mods: VrModEntry[],
  filter: VrFilter,
  installed: Record<string, unknown>
): VrModEntry[] {
  switch (filter) {
    case 'all':
      return mods
    case 'quest':
      return mods.filter(isQuestMod)
    case 'installed':
      return mods.filter((m) => m.id in installed)
    default:
      return mods.filter((m) => m.kind === filter)
  }
}

/** Newest / oldest by the list's date (the list's own order within a day), or by name. */
export function sortMods(mods: VrModEntry[], sort: VrSort): VrModEntry[] {
  const indexed = mods.map((m, i) => ({ m, i }))
  indexed.sort((a, b) => {
    if (sort === 'title')
      return a.m.title.localeCompare(b.m.title, undefined, { sensitivity: 'base' }) || a.i - b.i
    const ad = a.m.date ?? ''
    const bd = b.m.date ?? ''
    const byDate = sort === 'newest' ? bd.localeCompare(ad) : ad.localeCompare(bd)
    return byDate || a.i - b.i
  })
  return indexed.map((x) => x.m)
}

/** The list shown: searched, filtered and sorted. */
export function shownMods(
  mods: VrModEntry[],
  opts: { query: string; filter: VrFilter; sort: VrSort; installed: Record<string, unknown> }
): VrModEntry[] {
  return sortMods(filterMods(searchMods(mods, opts.query), opts.filter, opts.installed), opts.sort)
}

/** How many mods each filter would show (for the chips). */
export function filterCounts(
  mods: VrModEntry[],
  installed: Record<string, unknown>
): Record<VrFilter, number> {
  const out = {} as Record<VrFilter, number>
  for (const f of vrFilters()) out[f.value] = filterMods(mods, f.value, installed).length
  return out
}

/** What the mod's main button does. */
export type VrModAction =
  | 'download'
  | 'update'
  | 'busy'
  | 'downloaded'
  /** Not on GitHub, or only for a Quest by itself: only its page can be opened. */
  | 'page'

export function modAction(
  mod: Pick<VrModEntry, 'github' | 'tags'>,
  installed: InstalledVrMod | undefined,
  update: string | undefined,
  busy: boolean
): VrModAction {
  if (busy) return 'busy'
  if (installed) return update ? 'update' : 'downloaded'
  return mod.github && !isQuestOnlyMod(mod) ? 'download' : 'page'
}

/** The words for a download's progress: VR mods are only saved, never installed or run. */
export function vrProgressText(p: VrModProgress): string {
  switch (p.phase) {
    case 'removing':
      return t('vrMods.progress.removing')
    case 'installing':
      return t('vrMods.progress.saving')
    default:
      return progressText({ ...p, phase: p.phase })
  }
}

/** The site a mod's page is on, in words ("GitHub", "Nexus Mods", "itch.io", …). */
export function siteName(url: string | null): string {
  if (!url) return ''
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
  const known: Record<string, string> = {
    'github.com': 'GitHub',
    'nexusmods.com': 'Nexus Mods',
    'discord.com': 'Discord',
    'reddit.com': 'Reddit',
    'gitlab.com': 'GitLab',
    'moddb.com': 'ModDB',
    'patreon.com': 'Patreon',
    'youtube.com': 'YouTube',
    'youtu.be': 'YouTube'
  }
  if (known[host]) return known[host]!
  if (host.endsWith('.itch.io') || host === 'itch.io') return 'itch.io'
  return host
}

/** The mod's links besides its page: video, Reddit post and the thread the list found it in. */
export function modLinks(
  mod: Pick<VrModEntry, 'video' | 'reddit' | 'thread'>
): { id: string; label: string; url: string }[] {
  const out: { id: string; label: string; url: string }[] = []
  if (mod.video) out.push({ id: 'video', label: t('vrMods.links.video'), url: mod.video })
  if (mod.reddit) out.push({ id: 'reddit', label: t('vrMods.links.reddit'), url: mod.reddit })
  if (mod.thread) {
    const site = siteName(mod.thread)
    out.push({
      id: 'thread',
      label: site ? t('vrMods.links.sourceThreadOn', { site }) : t('vrMods.links.sourceThread'),
      url: mod.thread
    })
  }
  return out
}

/**
 * The detail's facts line: the list's status, and what is downloaded (the kind is a chip and the date is in the
 * header).
 */
export function modFacts(mod: VrModEntry, installed: InstalledVrMod | undefined): string[] {
  const parts: (string | null)[] = [
    mod.status ? t('vrMods.facts.status', { status: mod.status }) : null
  ]
  if (installed) {
    parts.push(
      installed.verified === 'unverified'
        ? t('vrMods.facts.downloadedUnverified', { tag: installed.tag })
        : t('vrMods.facts.downloaded', { tag: installed.tag })
    )
    if (installed.diskBytes !== null)
      parts.push(t('vrMods.facts.onDisk', { size: formatBytes(installed.diskBytes) }))
  }
  return parts.filter((p): p is string => !!p)
}

/** Settings › VR's lead line. */
export function vrLead(count: number, github: number, updated: string | null): string {
  if (!count) return t('vrMods.lead.empty')
  const vars = { mods: count.toLocaleString(), github: github.toLocaleString() }
  return updated ? t('vrMods.lead.countListed', { ...vars, updated }) : t('vrMods.lead.count', vars)
}

/** A finished download's warning or error is still worth showing. */
export function progressWorthShowing(p: VrModProgress | undefined, busy: boolean): boolean {
  return !!p && (busy || p.phase === 'failed' || !!p.warning)
}
