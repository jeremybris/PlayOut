// Copies the Co-Op helper build (PlayOut Co-Op, a separate GPL-3 program built from Nucleus Co-op's engine; its source
// is in coop-helper/, published on its own as https://github.com/jeremybris/PlayOut-CoOp) into resources/coop, which electron-builder ships unpacked. Writes
// playout-coop-version.txt (the helper's commit and build time), by which PlayOut knows when to copy a new helper
// into the user's Co-Op engine folder. Run by `npm run build`; a missing helper fails the build unless
// PLAYOUT_COOP_OPTIONAL=1 (development without the helper: Co-Op then says the build has no helper).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helperRepo = resolve(process.env.PLAYOUT_COOP_REPO ?? join(root, 'coop-helper'))
const dist = join(helperRepo, 'dist')
const target = join(root, 'resources', 'coop')

if (!existsSync(join(dist, 'PlayOutCoop.exe'))) {
  const message = `Co-Op helper not found at ${dist} (build it with build.ps1 in ${helperRepo})`
  if (process.env.PLAYOUT_COOP_OPTIONAL === '1') {
    console.warn(`sync-coop-helper: ${message}; continuing without it`)
    process.exit(0)
  }
  console.error(`sync-coop-helper: ${message}`)
  process.exit(1)
}

let commit = 'unknown'
try {
  // The last commit that changed the helper's own folder (it lives inside PlayOut's repository).
  commit =
    execFileSync('git', ['-C', helperRepo, 'log', '-1', '--format=%h', '--', '.'], {
      encoding: 'utf8'
    }).trim() || 'unknown'
} catch {
  // not a git checkout: the build time alone identifies it
}
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(dist, target, { recursive: true })
const built = statSync(join(dist, 'PlayOutCoop.exe')).mtime.toISOString()
writeFileSync(join(target, 'playout-coop-version.txt'), `${commit} ${built}\n`)
// The helper's license and source offer travel with it (GPL-3 §4, §6).
for (const file of ['LICENSE', 'README.md']) {
  if (existsSync(join(helperRepo, file)))
    cpSync(join(helperRepo, file), join(target, file === 'LICENSE' ? 'LICENSE.txt' : file))
}
console.log(`sync-coop-helper: ${commit} (${built}) -> resources/coop`)
