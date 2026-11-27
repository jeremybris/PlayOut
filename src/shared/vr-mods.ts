// VR mods (Settings › VR): mods that play flat PC games in VR, listed by the Flat2VR release list (bundled as
// resources/vr/vr-mods.json, built by scripts/build-vr-mods.mjs). A mod published on GitHub can be downloaded into
// the "VR Mods" folder beside the Recompilations folder (one folder per mod); nothing downloaded is ever run. Shared
// between main (src/main/vr-mods/) and the renderer (Settings › VR and its browser).
import type { RecompProgress, RecompRelease } from './recomp'

/** What the list calls an entry: a new mod, an update or alpha build of one, a tool, or a game profile. */
export type VrModKind = 'debut' | 'alpha' | 'tool' | 'profile'

/** A mod's GitHub repository, from its "Project / download" link. */
export interface VrModGithub {
  owner: string
  repo: string
  /** The release the link named (…/releases/tag/<tag>), else null. */
  tag: string | null
}

/** One entry of the VR mod list. */
export interface VrModEntry {
  /** Stable id (from the title; "<slug>-<date>" for a later entry of the same name). */
  id: string
  title: string
  author: string
  /** When the list saw it released (YYYY-MM-DD), if known. */
  date: string | null
  /** The list's status line ("v0.9.0 beta", "First build"). */
  status: string
  kind: VrModKind
  /** "PCVR", "Quest standalone", "motion controls", "UEVR profile", … */
  tags: string[]
  summary: string
  highlights: string[]
  /** The "Project / download" link (GitHub, Nexus Mods, itch.io, Discord, …), if any. */
  page: string | null
  /** Set when `page` is a GitHub repository (PlayOut can read its releases and download them). */
  github: VrModGithub | null
  /** Where the list found it (a Discord or Reddit thread). */
  thread: string | null
  video: string | null
  reddit: string | null
  /** Released outside the Flat2VR server. */
  outside: boolean
  /** The list's colour for it ("#baf56a"), if any. */
  accent: string | null
}

/**
 * A download in progress (the same phases as a recompilation's), or a removal ('removing': the mod counts as busy,
 * so no download of it starts until its folder is gone).
 */
export type VrModProgress = Omit<RecompProgress, 'phase'> & {
  phase: RecompProgress['phase'] | 'removing'
}

/** A release of a mod, with the file PlayOut would download (null = none it can keep). */
export type VrModRelease = RecompRelease

/** A downloaded mod. */
export interface InstalledVrMod {
  id: string
  /** The mod's name and "owner/repo" when it was downloaded (kept should the list drop it). */
  title: string
  repo: string
  /** Its folder in the VR Mods folder. */
  dir: string
  tag: string
  publishedAt: string | null
  /** The downloaded file's name. */
  asset: string
  downloadBytes: number
  diskBytes: number | null
  sha256: string
  /** GitHub published a checksum and the download matched it, or there was none. */
  verified: 'github' | 'unverified'
  /** Files the release put in the folder (lowercase '/' keys), to tell them from the user's on update. */
  releaseFiles: string[]
  installedAt: string
  updatedAt: string
}

/** Settings › VR and its browser. */
export interface VrModsView {
  /** The VR Mods folder (beside the Recompilations folder). */
  root: string
  /** The page the list comes from. */
  source: string
  /** The newest release date on the list. */
  updated: string | null
  /** Newest first. */
  mods: VrModEntry[]
  /** Downloaded mods, by id. */
  installed: Record<string, InstalledVrMod>
  /** A newer release of a downloaded mod, by id (found by Check for updates). */
  updates: Record<string, string>
}

/** The VR Mods folder's name (beside the Recompilations folder). */
export const VR_MODS_FOLDER = 'VR Mods'

export const VR_MOD_KIND_LABELS: Record<VrModKind, string> = {
  debut: 'New mod',
  alpha: 'Update',
  tool: 'Tool',
  profile: 'Profile'
}

/** "owner/repo" of a GitHub mod. */
export function vrModRepo(mod: Pick<VrModEntry, 'github'>): string | null {
  return mod.github ? `${mod.github.owner}/${mod.github.repo}` : null
}
