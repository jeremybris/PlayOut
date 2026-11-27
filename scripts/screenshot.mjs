// Build the app and capture each UI screen with the mock API: `npm run screenshot [-- home detail ...]`.
// Output: docs/screenshots/<screen>.png (1920x1080).
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
export const SCREENS = [
  'home',
  'library',
  'library-large',
  'library-settings',
  'detail',
  'detail-install',
  'detail-installing',
  'addgames',
  'settings',
  'settings-metadata',
  'settings-streaming',
  'search',
  'empty',
  'quickpanel'
]

/**
 * Throws unless `target` exists and was written at or after `startedAt` (ms since the epoch).
 * A capture run that cannot get Electron's single-instance lock (another PlayOut, or `npm run dev`, is
 * open) quits with exit code 0 without writing anything, so the exit code alone cannot tell a skipped
 * capture from a successful one.
 */
export function assertCaptured(target, startedAt, fs = { existsSync, statSync }) {
  if (!fs.existsSync(target)) {
    throw new Error(
      `${target} was not written. Is another PlayOut instance (or \`npm run dev\`) running? ` +
        'Mock runs need the single-instance lock.'
    )
  }
  const mtime = fs.statSync(target).mtimeMs
  if (mtime < startedAt) {
    throw new Error(
      `${target} was not updated (file time ${new Date(mtime).toISOString()} predates this run). ` +
        'Is another PlayOut instance running?'
    )
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      cwd: root,
      ...opts
    })
    child.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    )
  })
}

async function main(argv) {
  const require = createRequire(import.meta.url)
  const electron = require('electron')
  const wanted = argv.filter((a) => !a.startsWith('--'))
  const screens = wanted.length ? wanted : SCREENS
  const skipBuild = argv.includes('--no-build')

  if (!skipBuild || !existsSync(resolve(root, 'out/main/index.js'))) {
    await run('npx', ['electron-vite', 'build'])
  }

  for (const screen of screens) {
    const target = resolve(root, 'docs/screenshots', `${screen}.png`)
    console.log(`capturing ${screen} -> ${target}`)
    // File times have coarser resolution than Date.now() on some file systems; allow a 2 s skew.
    const startedAt = Date.now() - 2000
    await run(electron, ['.', '--mock', `--screen=${screen}`, `--screenshot=${target}`], {
      shell: false
    })
    assertCaptured(target, startedAt)
  }
  console.log('done')
}

// Run only when invoked directly (`node scripts/screenshot.mjs`), so the test can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
