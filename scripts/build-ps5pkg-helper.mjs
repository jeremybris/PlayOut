// Builds PlayOut's PS5 package helper (ps5pkg-helper/, a separate GPL-3.0 program on PS5PKGTool's extraction) and
// copies it into resources/ps5pkg, which electron-builder ships unpacked:
//   PlayOutPs5Pkg.exe            one self-contained win-x64 file (users need no .NET install)
//   LICENSE                      GPL-3.0
//   LICENSES-THIRD-PARTY.txt     every licence and notice text of what is inside the exe (PS5PKGTool, UFS2Tool,
//                                ProsperoPkgTool, the NuGet libraries, the .NET runtime)
//   playout-ps5pkg-version.txt   helper version, source URL, upstream commits, .NET version and build time
// The helper's source archive (ps5pkg-helper/obj/PlayOutPs5Pkg-<version>-source.zip) goes with its GitHub release.
// Needs git and the .NET 10 SDK (`dotnet` on PATH, or DOTNET_EXE=<path to dotnet.exe>). Run it after changing the
// helper (`node scripts/build-ps5pkg-helper.mjs`); the output is kept in the repository, so `npm run build` does not
// need .NET. The helper's source is published on its own (it is GPL): see ps5pkg-helper/README.md.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helper = join(root, 'ps5pkg-helper')
const target = join(root, 'resources', 'ps5pkg')

execFileSync(process.execPath, [join(helper, 'build.mjs')], { cwd: helper, stdio: 'inherit' })
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const name of readdirSync(join(helper, 'dist')))
  copyFileSync(join(helper, 'dist', name), join(target, name))
console.log(`resources/ps5pkg: ${readdirSync(target).join(', ')}`)
