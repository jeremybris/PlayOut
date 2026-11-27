import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A stand-in for a spawned process: it "starts" at once and exits only when the test says so. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() })
  pid = 4242
  exitCode: number | null = null
  kill = vi.fn()

  exit(code: number): void {
    this.exitCode = code
    this.emit('close', code)
  }
}

const spawned: { command: string; args: string[]; child: FakeChild }[] = []
vi.mock('child_process', () => ({
  spawn: (command: string, args: string[]): FakeChild => {
    const child = new FakeChild()
    spawned.push({ command, args, child })
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
}))

const { createCoopHelper, HELPER_STOP_BUDGET_MS, STOP_TIMEOUT_MS, sweepJobFiles } =
  await import('./helper')

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const job = { handler: 'h.js', exePath: 'C:\\G\\game.exe', screens: [], players: [], options: {} }
const taskkills = (): number => spawned.filter((s) => s.command === 'taskkill').length

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'playout-coop-helper-'))
  spawned.length = 0
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('Co-Op helper: stopping a session', () => {
  it('gives the helper longer than its own stop budget before killing it', async () => {
    expect(STOP_TIMEOUT_MS).toBeGreaterThan(HELPER_STOP_BUDGET_MS)
    const session = await createCoopHelper({ root, log: log as never }).play(job, () => undefined)
    const child = spawned[0]!.child
    vi.useFakeTimers()
    session.stop()
    expect(child.stdin.write).toHaveBeenCalledWith('stop\n')
    // The helper may use its whole budget (session.Stop(60000)) and then still restore the game's files.
    await vi.advanceTimersByTimeAsync(HELPER_STOP_BUDGET_MS + 5_000)
    expect(taskkills()).toBe(0)
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS - HELPER_STOP_BUDGET_MS)
    expect(taskkills()).toBe(1)
    expect(spawned.at(-1)!.args).toEqual(['/T', '/F', '/PID', '4242'])
    vi.useRealTimers()
    child.exit(1)
    await session.done
  })

  it('does not kill a helper that ended the session in time', async () => {
    const session = await createCoopHelper({ root, log: log as never }).play(job, () => undefined)
    vi.useFakeTimers()
    session.stop()
    spawned[0]!.child.exit(0)
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS * 2)
    expect(taskkills()).toBe(0)
  })
})

describe('Co-Op helper: job files', () => {
  const jobs = (): string[] => readdirSync(root).filter((n) => /^job-/.test(n))

  it('removes the job files a crashed run left when a session starts', async () => {
    writeFileSync(join(root, 'job-1700000000000.json'), '{}')
    writeFileSync(join(root, 'job-1700000000001.json'), '{}')
    writeFileSync(join(root, 'job-notes.json'), '{}')
    writeFileSync(join(root, 'Settings.ini'), '')
    const session = await createCoopHelper({ root, log: log as never }).play(job, () => undefined)
    const jobPath = spawned[0]!.args[spawned[0]!.args.indexOf('--job') + 1]!
    // Only this session's job is left; files that are not job files are not touched.
    expect(jobs().sort()).toEqual([jobPath.slice(root.length + 1), 'job-notes.json'].sort())
    expect(existsSync(join(root, 'Settings.ini'))).toBe(true)
    spawned[0]!.child.exit(0)
    await session.done
    await vi.waitFor(() => expect(existsSync(jobPath)).toBe(false))
  })

  it('keeps the job files of sessions still running', async () => {
    const live = join(root, 'job-5.json')
    writeFileSync(live, '{}')
    writeFileSync(join(root, 'job-6.json'), '{}')
    expect(await sweepJobFiles(root, new Set([live]))).toBe(1)
    expect(jobs()).toEqual(['job-5.json'])
    // A missing engine root is nothing to sweep.
    expect(await sweepJobFiles(join(root, 'absent'), new Set())).toBe(0)
  })
})
