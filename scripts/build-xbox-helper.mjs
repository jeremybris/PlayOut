// Builds PlayOut's Xbox / Xbox 360 image helper (xbox-helper/, C# on the MIT XISOSharp and CHDSharp libraries)
// into resources/xbox, which electron-builder ships unpacked:
//   PlayOutXbox.exe   one self-contained, trimmed win-x64 file (users need no .NET install)
//   VendoredFlac.dll  CHDSharp's FLAC codec (LGPL-2.1), shipped unmodified beside the exe so it stays replaceable
//   LICENSES.txt      the licence and notice texts of everything inside those two files
//   playout-xbox-version.txt  helper version and build time
// Needs the .NET 10 SDK: `dotnet` on PATH, or DOTNET_EXE=<path to dotnet.exe>. Run it after changing the
// helper (`node scripts/build-xbox-helper.mjs`); the output is kept in the repository, so `npm run build`
// does not need .NET.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const project = join(root, 'xbox-helper')
const publishDir = join(project, 'dist')
const target = join(root, 'resources', 'xbox')
const dotnet = process.env.DOTNET_EXE ?? 'dotnet'
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }

/** The files the helper ships; anything else in the publish folder is a build mistake. */
const SHIPPED = ['PlayOutXbox.exe', 'VendoredFlac.dll']

/** NuGet packages compiled into the helper, with the licence files each one carries. */
const PACKAGES = [
  ['XISOSharp', ['LICENSE']],
  ['CCISharp', ['LICENSE', 'THIRD-PARTY-NOTICES.md']],
  ['ZArchiveSharp', ['LICENSE', 'THIRD-PARTY-NOTICES.md']],
  ['StfsSharp', ['LICENSE', 'THIRD-PARTY-NOTICES.md']],
  ['CHDSharp', ['LICENSE.txt']]
]

function run(args) {
  execFileSync(dotnet, args, { cwd: project, env, stdio: 'inherit' })
}

/** The NuGet folder of a restored package (from obj/project.assets.json). */
function packageFolder(assets, id) {
  const key = Object.keys(assets.libraries).find(
    (k) => k.split('/')[0].toLowerCase() === id.toLowerCase()
  )
  if (!key) throw new Error(`${id} is not in project.assets.json`)
  const base = Object.keys(assets.packageFolders)[0]
  return { version: key.split('/')[1], folder: join(base, assets.libraries[key].path) }
}

function section(title, text) {
  return `${'='.repeat(100)}\n${title}\n${'='.repeat(100)}\n\n${text.trim()}\n\n`
}

rmSync(publishDir, { recursive: true, force: true })
run(['publish', '-c', 'Release', '-o', publishDir])

for (const name of SHIPPED) {
  if (!existsSync(join(publishDir, name))) throw new Error(`publish produced no ${name}`)
}

const assets = JSON.parse(readFileSync(join(project, 'obj', 'project.assets.json'), 'utf8'))
const runtimeDep = assets.project.frameworks['net10.0'].downloadDependencies.find(
  (d) => d.name === 'Microsoft.NETCore.App.Runtime.win-x64'
)
const runtimeVersion = runtimeDep.version.replace(/[[\]\s]/g, '').split(',')[0]
const runtimeFolder = join(
  Object.keys(assets.packageFolders)[0],
  'microsoft.netcore.app.runtime.win-x64',
  runtimeVersion
)

let licences = `PlayOutXbox - PlayOut's Xbox / Xbox 360 disc image helper
Part of PlayOut (PlayOut License, Copyright (c) 2026 Jeremy Bristol; see PlayOut's LICENSE).

PlayOutXbox.exe contains the libraries below (MIT, by PureLogicCode.com / Peterson Fernandes - the engine of
XISO Studio, https://github.com/purelogiccode/XISOStudio) and the .NET ${runtimeVersion} runtime. Their licence
and notice texts follow, unmodified. CHDSharp: original developers Peterson Fernandes (@purelogiccode) and
Gordon Jefferyes (@gjefferyes).

This product includes software developed by in <in@fishtank.com> (extract-xiso, through XISOSharp).

VendoredFlac.dll (CHDSharp's FLAC codec, GNU LGPL 2.1 or later) is the unmodified file from the CHDSharp
${packageFolder(assets, 'CHDSharp').version} NuGet package, loaded from beside PlayOutXbox.exe: it may be replaced
with a version rebuilt from its source, https://github.com/purelogiccode/CHDSharp/tree/v${packageFolder(assets, 'CHDSharp').version}/VendoredFlac
(the LGPL 2.1 text is at the end of this file).

`
for (const [id, files] of PACKAGES) {
  const { version, folder } = packageFolder(assets, id)
  for (const file of files) {
    licences += section(`${id} ${version} - ${file}`, readFileSync(join(folder, file), 'utf8'))
  }
}
const logging = packageFolder(assets, 'Microsoft.Extensions.Logging.Abstractions')
licences += section(
  `.NET ${runtimeVersion} runtime and Microsoft.Extensions.Logging.Abstractions ${logging.version} - LICENSE.TXT`,
  readFileSync(join(runtimeFolder, 'LICENSE.TXT'), 'utf8')
)
licences += section(
  `.NET ${runtimeVersion} runtime - THIRD-PARTY-NOTICES.TXT`,
  readFileSync(join(runtimeFolder, 'THIRD-PARTY-NOTICES.TXT'), 'utf8')
)
licences += section(
  'GNU Lesser General Public License 2.1 (VendoredFlac.dll)',
  readFileSync(join(project, 'licenses', 'LGPL-2.1.txt'), 'utf8')
)

const version = /<Version>([^<]+)<\/Version>/.exec(
  readFileSync(join(project, 'PlayOutXbox.csproj'), 'utf8')
)[1]

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const name of SHIPPED) copyFileSync(join(publishDir, name), join(target, name))
writeFileSync(join(target, 'LICENSES.txt'), licences.replace(/\r\n/g, '\n'))
writeFileSync(join(target, 'playout-xbox-version.txt'), `${version} ${new Date().toISOString()}\n`)
console.log(`build-xbox-helper: ${target} (PlayOutXbox ${version}, .NET ${runtimeVersion})`)
