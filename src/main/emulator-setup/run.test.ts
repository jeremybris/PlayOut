import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { elevatedScript, quoteWindowsArg, runElevated, runProcess, startHidden } from './run'
import type { Runner } from './types'

const node = process.execPath

function decode(args: string[]): string {
  const b64 = args[args.indexOf('-EncodedCommand') + 1]
  return Buffer.from(b64, 'base64').toString('utf16le')
}

describe('runProcess', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const r = await runProcess(node, [
      '-e',
      'process.stdout.write("out");process.stderr.write("err");process.exit(3)'
    ])
    expect(r).toEqual({ code: 3, stdout: 'out', stderr: 'err' })
  })

  it('passes arguments without a shell and honours cwd', async () => {
    const r = await runProcess(
      node,
      ['-e', 'process.stdout.write(process.argv[1] + "|" + process.cwd())', 'a b & c'],
      { cwd: __dirname }
    )
    expect(r.stdout).toBe(`a b & c|${__dirname}`)
  })

  it('caps the captured output at 64 KB', async () => {
    const r = await runProcess(node, ['-e', 'process.stdout.write("x".repeat(200000))'])
    expect(r.code).toBe(0)
    expect(r.stdout.length).toBe(64 * 1024)
  })

  it('kills the process on timeout and resolves with code null', async () => {
    const started = Date.now()
    const r = await runProcess(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 })
    expect(r.code).toBeNull()
    expect(Date.now() - started).toBeLessThan(15000)
  }, 20000)

  it('resolves with the error message when the program cannot start', async () => {
    const r = await runProcess('Z:\\no\\such\\program-playout.exe', [])
    expect(r.code).toBeNull()
    expect(r.stderr).toMatch(/ENOENT|not found/i)
  })
})

describe('quoteWindowsArg', () => {
  it('quotes only when needed and escapes quotes and trailing backslashes', () => {
    expect(quoteWindowsArg('/install')).toBe('/install')
    expect(quoteWindowsArg('')).toBe('""')
    expect(quoteWindowsArg('C:\\Program Files\\app.exe')).toBe('"C:\\Program Files\\app.exe"')
    expect(quoteWindowsArg('C:\\a b\\')).toBe('"C:\\a b\\\\"')
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
  })
})

describe('runElevated', () => {
  it('runs an encoded Start-Process -Verb RunAs script and returns the exit code', async () => {
    const calls: {
      file: string
      args: string[]
      options?: { cwd?: string; timeoutMs?: number }
    }[] = []
    const run: Runner = async (file, args, options) => {
      calls.push({ file, args, options })
      return { code: 3010, stdout: '', stderr: '' }
    }
    const code = await runElevated(
      "C:\\Owner's Games\\vc_redist.x64.exe",
      ['/install', '/passive', 'C:\\a b'],
      run
    )
    expect(code).toBe(3010)
    expect(calls).toHaveLength(1)
    const { file, args, options } = calls[0]
    expect(file).toBe('powershell.exe')
    expect(args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ])
    expect(options?.timeoutMs).toBe(30 * 60 * 1000)
    const script = decode(args)
    expect(script).toContain(
      "$p = Start-Process -FilePath 'C:\\Owner''s Games\\vc_redist.x64.exe' -ArgumentList '/install /passive \"C:\\a b\"' -Verb RunAs -Wait -PassThru"
    )
    expect(script).toContain('exit $p.ExitCode')
    expect(script).toContain('exit 1223')
    expect(script).toContain('cancel+ed by the user')
  })

  it('omits -ArgumentList when there are no arguments and doubles quotes in arguments', () => {
    expect(elevatedScript('C:\\app.exe', [])).not.toContain('-ArgumentList')
    expect(elevatedScript('C:\\app.exe', ["it's"])).toContain("-ArgumentList 'it''s'")
  })

  it('hides the elevated window only when asked (installers keep their progress window)', () => {
    expect(elevatedScript('C:\\app.exe', [])).not.toContain('-WindowStyle')
    expect(elevatedScript('C:\\app.exe', [], { hidden: true })).toContain(
      '-Verb RunAs -WindowStyle Hidden -Wait -PassThru'
    )
  })

  it('returns null when PowerShell could not run', async () => {
    const run: Runner = async () => ({ code: null, stdout: '', stderr: 'spawn failed' })
    expect(await runElevated('C:\\app.exe', [], run)).toBeNull()
  })
})

describe('startHidden', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('resolves exited with the exit code without waiting at start', async () => {
    const p = startHidden(node, ['-e', 'setTimeout(() => process.exit(7), 50)'], {
      cwd: __dirname
    })
    expect(await p.exited).toBe(7)
    await p.stop()
  })

  it('resolves exited with null when the program cannot start', async () => {
    const p = startHidden(join(__dirname, 'no-such-program.exe'), [], { cwd: __dirname })
    expect(await p.exited).toBeNull()
    await expect(p.stop()).resolves.toBeUndefined()
  })

  it('stop() kills the process tree and resolves once it exited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playout-hidden-'))
    try {
      const pidFile = join(dir, 'child.pid')
      const script = [
        "const { spawn } = require('child_process')",
        "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))`,
        'setInterval(() => {}, 1000)'
      ].join(';')
      const p = startHidden(node, ['-e', script], { cwd: dir })
      let childPid = 0
      for (let i = 0; i < 100 && !childPid; i++) {
        await new Promise((r) => setTimeout(r, 50))
        childPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      }
      expect(childPid).toBeGreaterThan(0)
      let exited = false
      void p.exited.then(() => (exited = true))
      await p.stop()
      expect(exited).toBe(true)
      if (process.platform === 'win32') {
        for (let i = 0; i < 40 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 50))
        expect(alive(childPid)).toBe(false)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
