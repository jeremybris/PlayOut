import { describe, expect, it, vi } from 'vitest'
import {
  createIngameHelper,
  parseHelperLine,
  parseInject,
  parseProbe,
  parsePeerPartyInvite,
  PEERPARTY_INVITE_TIMEOUT_MS,
  type HelperRunner
} from './helper'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const probeLine =
  '{"ok":true,"pid":1234,"arch":"x64","elevated":false,"protected":false,"appContainer":false,"antiCheat":[],"graphics":["d3d11","dxgi"],"injected":false,"exe":"C:\\\\G\\\\Spel2.exe"}'

function helper(
  answers: Record<string, string | { code: number | null; stdout: string }>,
  present = true
): {
  h: ReturnType<typeof createIngameHelper>
  calls: { file: string; args: string[]; timeout: number }[]
  kills: number
} {
  const calls: { file: string; args: string[]; timeout: number }[] = []
  const state = { kills: 0 }
  const run: HelperRunner = (file, args, timeout) => {
    calls.push({ file, args, timeout })
    const a = answers[args[0]!] ?? ''
    const r = typeof a === 'string' ? { code: 0, stdout: a } : a
    return { done: Promise.resolve(r), kill: () => state.kills++ }
  }
  const h = createIngameHelper({
    log,
    dir: 'C:\\app\\resources\\ingame',
    run,
    exists: async () => present
  })
  return {
    h,
    calls,
    get kills() {
      return state.kills
    }
  }
}

describe('parseHelperLine', () => {
  it('takes the last JSON object line', () => {
    expect(parseHelperLine('noise\r\n{"a":1}\r\n{"b":2}\r\n')).toEqual({ b: 2 })
    expect(parseHelperLine('{"a":1}\n{broken')).toEqual({ a: 1 })
    expect(parseHelperLine('')).toBeNull()
    expect(parseHelperLine('[1]')).toBeNull()
  })
})

describe('parseProbe / parseInject', () => {
  it('reads a full probe and refuses an incomplete one', () => {
    const p = parseProbe(JSON.parse(probeLine), 1234)
    expect(p).toMatchObject({
      ok: true,
      arch: 'x64',
      graphics: ['d3d11', 'dxgi'],
      exe: 'C:\\G\\Spel2.exe'
    })
    expect(parseProbe({ ok: true, arch: 'x64' }, 1)).toMatchObject({ ok: false, step: 'parse' })
    expect(parseProbe({ ok: false, error: 'denied', step: 'open' }, 1)).toEqual({
      ok: false,
      pid: 1,
      error: 'denied',
      step: 'open'
    })
    expect(parseProbe(null, 1)).toBeNull()
  })

  it('reads inject answers', () => {
    expect(parseInject({ ok: true, step: 'done' }, 5)).toEqual({ ok: true, pid: 5, step: 'done' })
    expect(parseInject({ ok: true, step: 'already' }, 5)).toEqual({
      ok: true,
      pid: 5,
      step: 'already'
    })
    expect(parseInject({ ok: false, error: 'x', step: 'thread' }, 5)).toEqual({
      ok: false,
      pid: 5,
      error: 'x',
      step: 'thread'
    })
    expect(parseInject({ ok: true, step: 'weird' }, 5)).toMatchObject({ ok: false })
  })
})

describe('createIngameHelper', () => {
  it('runs probe, inject and watch with their arguments and timeouts', async () => {
    const t = helper({
      probe: probeLine,
      inject: '{"ok":true,"pid":1234,"step":"done"}',
      watch: '{"pid":1234,"exitCode":3221225477}'
    })
    expect((await t.h.probe(1234))?.ok).toBe(true)
    expect(t.calls[0]).toEqual({
      file: 'C:\\app\\resources\\ingame\\PlayOutIngame64.exe',
      args: ['probe', '--pid', '1234'],
      timeout: 5000
    })
    expect(
      await t.h.inject({
        pid: 1234,
        dll: t.h.dll,
        pipe: '\\\\.\\pipe\\x',
        token: 'ab',
        playoutPid: 9
      })
    ).toEqual({ ok: true, pid: 1234, step: 'done' })
    expect(t.calls[1]!.args).toEqual([
      'inject',
      '--pid',
      '1234',
      '--dll',
      'C:\\app\\resources\\ingame\\PlayOutOverlay64.dll',
      '--pipe',
      '\\\\.\\pipe\\x',
      '--token',
      'ab',
      '--playout-pid',
      '9'
    ])
    expect(await t.h.watch(1234)).toBe(0xc0000005)
    expect(t.calls[2]).toMatchObject({ args: ['watch', '--pid', '1234'], timeout: 0 })
  })

  it('is unavailable without its files: no runs, null answers', async () => {
    const t = helper({ probe: probeLine }, false)
    expect(await t.h.available()).toBe(false)
    expect(await t.h.probe(1)).toBeNull()
    expect(await t.h.inject({ pid: 1, dll: 'd', pipe: 'p', token: 't', playoutPid: 2 })).toBeNull()
    expect(await t.h.watch(1)).toBeNull()
    expect(t.calls).toHaveLength(0)
  })

  it('gives null for a helper that printed nothing', async () => {
    const t = helper({ probe: { code: null, stdout: '' }, watch: { code: 1, stdout: 'oops' } })
    expect(await t.h.probe(1)).toBeNull()
    expect(await t.h.watch(1)).toBeNull()
  })

  it('stops running watches on dispose', async () => {
    const calls: string[] = []
    let finish: (v: { code: number | null; stdout: string }) => void = () => {}
    const h = createIngameHelper({
      log,
      dir: 'd',
      exists: async () => true,
      run: () => ({
        done: new Promise((r) => (finish = r)),
        kill: () => {
          calls.push('kill')
          finish({ code: null, stdout: '' })
        }
      })
    })
    const watched = h.watch(5)
    await new Promise((r) => setTimeout(r, 0))
    h.dispose()
    expect(await watched).toBeNull()
    expect(calls).toEqual(['kill'])
  })
})

describe('peerparty-invite', () => {
  it('runs the command with no arguments and reads whether a game took the invite', async () => {
    const taken = helper({ 'peerparty-invite': '{"ok":true,"taken":true}' })
    expect(await taken.h.peerPartyInvite()).toEqual({ ok: true, taken: true })
    expect(taken.calls).toEqual([
      {
        file: expect.stringMatching(/PlayOutIngame64\.exe$/),
        args: ['peerparty-invite'],
        timeout: PEERPARTY_INVITE_TIMEOUT_MS
      }
    ])
    expect(
      await helper({ 'peerparty-invite': '{"ok":true,"taken":false}' }).h.peerPartyInvite()
    ).toEqual({ ok: true, taken: false })
    expect(
      await helper({
        'peerparty-invite':
          '{"ok":false,"error":"PeerParty\'s invite event could not be opened (Windows error 5)","step":"event"}'
      }).h.peerPartyInvite()
    ).toEqual({
      ok: false,
      error: "PeerParty's invite event could not be opened (Windows error 5)"
    })
  })

  it('gives null for no answer, an older helper (usage error) or a missing one', async () => {
    expect(await helper({}).h.peerPartyInvite()).toBeNull()
    expect(parsePeerPartyInvite({ ok: true })).toBeNull()
    expect(parsePeerPartyInvite(null)).toBeNull()
    // An older helper refuses the command as a usage error: shown as that error.
    expect(
      parsePeerPartyInvite({
        ok: false,
        error: '--pid is missing or not a process id',
        step: 'usage'
      })
    ).toEqual({ ok: false, error: '--pid is missing or not a process id' })
    const missing = helper({ 'peerparty-invite': '{"ok":true,"taken":true}' }, false)
    expect(await missing.h.peerPartyInvite()).toBeNull()
    expect(missing.calls).toEqual([])
  })
})
