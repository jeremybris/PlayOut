// Which file of a VR mod's GitHub release PlayOut downloads. A Windows build (zip, 7z, a program) is picked the way
// a recompilation's is (recomp/assets.ts); VR mods also ship plain files a game or UEVR loads (a .dll, an .asi, a
// .pak, a .uevrz profile), kept as they are. Phone / headset builds (.apk), other systems, sources, checksums and
// archives PlayOut cannot unpack (.rar, tarballs) are never picked: then the mod has no download here and its page
// is offered instead.
import {
  isInstallerName,
  notABuild,
  notForWindows,
  pickWindowsAsset,
  type AssetHint,
  type PickedAsset,
  type ReleaseAsset
} from '../recomp/assets'

/** Files a VR mod may ship that PlayOut keeps as they are, best first. */
const PLAIN_FILES = ['.uevrz', '.pak', '.dll', '.asi', '.utoc', '.ucas', '.lua', '.ini', '.cfg']
/** Archives PlayOut cannot unpack. */
const UNSUPPORTED = /\.(rar|tar|gz|tgz|bz2|xz|zst)$/i

/** The file PlayOut would download from a release, or null when it has none it can keep. */
export function pickVrAsset<A extends ReleaseAsset>(
  assets: A[],
  hint: AssetHint
): PickedAsset<A> | null {
  const windows = pickWindowsAsset(assets, hint)
  if (windows) return windows
  const usable = assets.filter(
    (a) => !UNSUPPORTED.test(a.name) && !notABuild(a.name) && !notForWindows(a.name)
  )
  const rank = (name: string): number => {
    const n = name.toLowerCase()
    const at = PLAIN_FILES.findIndex((ext) => n.endsWith(ext))
    return at < 0 ? PLAIN_FILES.length : at
  }
  const plain = usable
    .filter((a) => rank(a.name) < PLAIN_FILES.length)
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
  const asset = plain[0] ?? null
  return asset ? { asset, installer: isInstallerName(asset.name) } : null
}

/** Whether a release has a file PlayOut can download for a VR mod. */
export function hasVrAsset(assets: ReleaseAsset[], tag: string): boolean {
  return pickVrAsset(assets, { pattern: null, tag }) !== null
}
