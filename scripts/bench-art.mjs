// `npm run bench:art [-- 300|3000]`: the simulated-clock benchmark of the art pipeline (docs/ARCHITECTURE.md §4.6
// "Art pipeline", §7). Runs src/main/scrapers/metadata-service.bench.test.ts with PLAYOUT_BENCH=1 for the 300-game
// library and then the 3,000-game one (both rows of the acceptance table; a number argument or PLAYOUT_BENCH_GAMES
// runs only that size), prints the before/after tables and asserts the acceptance numbers. No network, no user
// data. A plain `npm` script cannot set an environment variable portably, which is all this file does.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const only = process.argv[2] ?? process.env.PLAYOUT_BENCH_GAMES
const sizes = only ? [String(only)] : ['300', '3000']

function run(games) {
  return new Promise((done) => {
    const child = spawn(
      'npx',
      ['vitest', 'run', 'src/main/scrapers/metadata-service.bench.test.ts', '--reporter=verbose'],
      {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, PLAYOUT_BENCH: '1', PLAYOUT_BENCH_GAMES: games }
      }
    )
    child.on('exit', (code) => done(code ?? 1))
  })
}

let exit = 0
for (const games of sizes) {
  const code = await run(games)
  if (code !== 0) exit = code
}
process.exit(exit)
