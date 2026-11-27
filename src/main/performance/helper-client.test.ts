import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHelperClient, notRunningMessage, type HelperClient } from './helper-client'
import { HELPER_MEMORY_BUSY, HelperMemoryBusyError, LineDecoder } from './helper/protocol'

const quiet = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined
}
const SID = 'S-1-5-21-1-2-3-1001'

let n = 0
function pipePath(): string {
  n++
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\playout-test-${process.pid}-${n}`
    : join(tmpdir(), `playout-test-${process.pid}-${n}.sock`)
}

/** A fake helper: answers each request line with `answer(request)` (undefined = stay silent, 'close' = hang up). */
function fakeHelper(
  path: string,
  answer: (req: Record<string, unknown>) => unknown
): Promise<{ server: Server; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = []
  const server = createServer((socket: Socket) => {
    const d = new LineDecoder()
    socket.on('data', (chunk) => {
      for (const line of d.push(chunk)) {
        const req = JSON.parse(line) as Record<string, unknown>
        requests.push(req)
        const a = answer(req)
        if (a === 'close') socket.destroy()
        else if (a !== undefined) socket.write(`${JSON.stringify(a)}\n`)
      }
    })
  })
  return new Promise((resolve) => server.listen(path, () => resolve({ server, requests })))
}

const servers: Server[] = []
const clients: HelperClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe('helper client', () => {
  it('sends requests one at a time and parses the answers', async () => {
    const path = pipePath()
    const { server, requests } = await fakeHelper(path, (req) => {
      if (req.op === 'info')
        return {
          ok: true,
          method: 'intel-msr',
          cpu: 'Test CPU',
          minWatts: 5,
          maxWatts: 45,
          version: 1
        }
      if (req.op === 'set') return { ok: true, watts: req.watts, boostWatts: req.boostWatts }
      return { ok: true }
    })
    servers.push(server)
    const c = createHelperClient({ sid: SID, log: quiet, pipePath: path })
    clients.push(c)
    const [info, set] = await Promise.all([c.info(), c.set(15, 25), c.restore()])
    expect(info).toMatchObject({ method: 'intel-msr', minWatts: 5, maxWatts: 45 })
    expect(set).toEqual({ watts: 15, boostWatts: 25 })
    expect(requests.map((r) => r.op)).toEqual(['info', 'set', 'restore'])
  })

  it('starts, reads and stops frame-rate measuring (protocol 2), sending only clean pids', async () => {
    const path = pipePath()
    const { server, requests } = await fakeHelper(path, (req) => {
      if (req.op === 'fps')
        return { ok: true, fps: 58.7, frameTimeMs: 17.04, pid: 4242, frames: 88, running: true }
      return { ok: true }
    })
    servers.push(server)
    const c = createHelperClient({ sid: SID, log: quiet, pipePath: path })
    clients.push(c)
    await c.fpsStart!([4242, 4242, 0, 3, 1.5, 9001])
    expect(await c.fps!()).toEqual({
      fps: 58.7,
      frameTimeMs: 17.04,
      pid: 4242,
      frames: 88,
      running: true
    })
    await c.fpsStop!()
    expect(requests).toEqual([
      { op: 'fpsStart', pids: [4242, 9001] },
      { op: 'fps' },
      { op: 'fpsStop' }
    ])
    await expect(c.fpsStart!([0, 2])).rejects.toThrow(/No processes/)
  })

  it('writes RivaTuner profiles (protocol 3), checking names and limits before sending', async () => {
    const path = pipePath()
    const { server, requests } = await fakeHelper(path, (req) => {
      if (req.op === 'rtssLimit')
        return { ok: true, exe: req.exe, fps: req.fps, created: req.fps !== 0 }
      if (req.op === 'rtssSelf') return { ok: true, changed: true }
      if (req.op === 'rtssRestore') return { ok: true, restored: 2 }
      return { ok: false, error: 'Unknown request.' }
    })
    servers.push(server)
    const c = createHelperClient({ sid: SID, log: quiet, pipePath: path })
    clients.push(c)
    expect(await c.rtssLimit!('JWE3.exe', 60)).toEqual({ exe: 'JWE3.exe', fps: 60, created: true })
    expect(await c.rtssLimit!('JWE3.exe', 0)).toEqual({ exe: 'JWE3.exe', fps: 0, created: false })
    expect(await c.rtssSelf!('PlayOut.exe')).toEqual({ changed: true })
    await expect(c.rtssLimit!('Global', 60)).rejects.toThrow(/Not a program name/)
    await expect(c.rtssLimit!('Game.exe', 2000)).rejects.toThrow(/Not a frame rate limit/)
    await expect(c.rtssSelf!('a/b.exe')).rejects.toThrow(/Not a program name/)
    expect(await c.rtssRestore!()).toEqual({ restored: 2 })
    expect(requests).toEqual([
      { op: 'rtssLimit', exe: 'JWE3.exe', fps: 60 },
      { op: 'rtssLimit', exe: 'JWE3.exe', fps: 0 },
      { op: 'rtssSelf', exe: 'PlayOut.exe' },
      { op: 'rtssRestore' }
    ])
  })

  it('starts a memory cleanup (protocol 4) and asks for its result until it has ended', async () => {
    const path = pipePath()
    let polls = 0
    const steps = {
      workingSets: { state: 'done', trimmed: 12, denied: 4, skipped: 1, gone: 0, ms: 412 },
      modifiedList: { state: 'done', ms: 1830 },
      // No time for this one (as a helper from before timings answers): the result is taken all the same.
      lowPriorityStandby: { state: 'done' },
      standby: { state: 'skipped', detail: 'not asked for' },
      combine: { state: 'failed', detail: 'not supported', ms: 3 },
      totalMs: 2250
    }
    const { server, requests } = await fakeHelper(path, (req) => {
      if (req.op === 'memTrim') return { ok: true, id: 3 }
      if (req.op === 'memResult')
        return ++polls < 3
          ? { ok: true, id: 3, running: true }
          : { ok: true, id: 3, running: false, steps }
      // The pipe keeps answering other requests while the cleanup runs.
      if (req.op === 'fps') return { ok: true, fps: 60, running: true }
      return { ok: false, error: 'Unknown request.' }
    })
    servers.push(server)
    const c = createHelperClient({ sid: SID, log: quiet, pipePath: path, memoryPollMs: 5 })
    clients.push(c)
    const [result, fps] = await Promise.all([
      c.memoryTrim!([1234, 1234, 5678], {
        shell: true,
        purgeBelowMb: 2048,
        createdBefore: 1_700_000_000_000
      }),
      c.fps!()
    ])
    expect(fps.fps).toBe(60)
    expect(result.counts).toEqual({ trimmed: 12, denied: 4, skipped: 1, gone: 0 })
    expect(result.steps.standby).toEqual({ state: 'skipped', detail: 'not asked for' })
    expect(result.steps.combine).toEqual({ state: 'failed', detail: 'not supported', ms: 3 })
    expect(result.steps.workingSets).toEqual({ state: 'done', ms: 412 })
    expect(result.steps.modifiedList).toEqual({ state: 'done', ms: 1830 })
    expect(result.steps.lowPriorityStandby).toEqual({ state: 'done' })
    expect(result.totalMs).toBe(2250)
    expect(requests[0]).toEqual({
      op: 'memTrim',
      pids: [1234, 5678],
      shell: true,
      purgeBelowMb: 2048,
      createdBefore: 1_700_000_000_000
    })
    expect(requests.filter((r) => r.op === 'memResult')).toHaveLength(3)
    // A bad list is never sent.
    const sent = requests.length
    await expect(
      c.memoryTrim!([1234, 4], { shell: false, purgeBelowMb: 0, createdBefore: 1 })
    ).rejects.toThrow(/Not a process id/)
    // Nor is a request without the time the process list was read.
    await expect(
      c.memoryTrim!([1234], { shell: false, purgeBelowMb: 0, createdBefore: 0 })
    ).rejects.toThrow(/Not a time/)
    expect(requests).toHaveLength(sent)
  })

  it('fails a memory cleanup the helper refuses, loses or does not end in time', async () => {
    const path = pipePath()
    let mode: 'refused' | 'busy' | 'lost' | 'stuck' | 'silent' | 'broken' = 'refused'
    const { server } = await fakeHelper(path, (req) => {
      if (req.op === 'memTrim') {
        if (mode === 'refused') return { ok: false, error: 'Not a time.' }
        return mode === 'busy' ? { ok: false, error: HELPER_MEMORY_BUSY } : { ok: true, id: 5 }
      }
      if (mode === 'broken') return { ok: false, error: 'Unknown request.' }
      if (mode === 'lost') return { ok: true, id: 1, running: false }
      if (mode === 'silent') return { ok: true, id: 5, running: false }
      return { ok: true, id: 5, running: true }
    })
    servers.push(server)
    const c = createHelperClient({ sid: SID, log: quiet, pipePath: path, memoryPollMs: 5 })
    clients.push(c)
    const opts = { shell: false, purgeBelowMb: 0, createdBefore: 1_700_000_000_000 }
    const failure = (o: typeof opts & { timeoutMs?: number } = opts): Promise<Error> =>
      c.memoryTrim!([1234], o).then(
        () => new Error('it did not fail'),
        (err: Error) => err
      )
    // Refused before it started: an ordinary error (PlayOut may then trim by itself).
    const refused = await failure()
    expect(refused.message).toBe('Not a time.')
    expect(refused).not.toBeInstanceOf(HelperMemoryBusyError)
    // Everything else means a cleanup is, or may still be, running in the helper: nobody else may trim meanwhile.
    for (const [next, text] of [
      ['busy', /already running/],
      ['lost', /lost the memory cleanup/],
      ['silent', /did not report/],
      ['broken', /did not report the memory cleanup: Unknown request/]
    ] as const) {
      mode = next
      const err = await failure()
      expect(err.message, next).toMatch(text)
      expect(err, next).toBeInstanceOf(HelperMemoryBusyError)
    }
    mode = 'stuck'
    const late = await failure({ ...opts, timeoutMs: 30 })
    expect(late.message).toMatch(/did not finish in time/)
    expect(late).toBeInstanceOf(HelperMemoryBusyError)
  })

  it('throws the helper error', async () => {
    const path = pipePath()
    const { server } = await fakeHelper(path, () => ({ ok: false, error: 'MSR 0x610 is locked' }))
    servers.push(server)
    const c = createHelperClient({ sid: SID, log: quiet, pipePath: path })
    clients.push(c)
    await expect(c.set(10, null)).rejects.toThrow(/locked/)
    await expect(c.restore()).rejects.toThrow(/locked/)
  })

  it('never starts the helper itself: a missing pipe is reported as not running', async () => {
    const c = createHelperClient({
      sid: SID,
      log: quiet,
      pipePath: pipePath(),
      connectWaitMs: 100,
      retryMs: 20
    })
    clients.push(c)
    await expect(c.info()).rejects.toThrow(notRunningMessage())
    expect(notRunningMessage()).toBe(
      'The power helper is not running: reinstall it in Settings › System.'
    )
    // The client has no way to run anything (no schtasks /run): its deps take no command runner.
    expect(createHelperClient.toString()).not.toMatch(/schtasks/)
  })

  it('connects once the helper opens its pipe within the wait (after boot or an install)', async () => {
    const path = pipePath()
    const c = createHelperClient({ sid: SID, log: quiet, pipePath: path, retryMs: 10 })
    clients.push(c)
    setTimeout(() => {
      void fakeHelper(path, () => ({ ok: true, method: null, cpu: 'x', version: 1 })).then(
        ({ server }) => servers.push(server)
      )
    }, 50)
    await c.waitUntilRunning!(2_000)
    expect((await c.info()).method).toBeNull()
    const late = createHelperClient({ sid: SID, log: quiet, pipePath: pipePath(), retryMs: 10 })
    clients.push(late)
    await expect(late.waitUntilRunning!(50)).rejects.toThrow(notRunningMessage())
  })

  it('times out a silent helper and reconnects for the next request', async () => {
    const path = pipePath()
    let silent = true
    const { server, requests } = await fakeHelper(path, () =>
      silent ? undefined : { ok: true, method: null, cpu: 'x', version: 1 }
    )
    servers.push(server)
    const c = createHelperClient({
      sid: SID,
      log: quiet,
      pipePath: path,
      requestTimeoutMs: 100
    })
    clients.push(c)
    await expect(c.info()).rejects.toThrow(/did not answer/)
    silent = false
    await expect(c.info()).resolves.toMatchObject({ cpu: 'x' })
    expect(requests).toHaveLength(2)
  })

  it('fails the request when the helper hangs up, then reconnects', async () => {
    const path = pipePath()
    let hangUp = true
    const { server } = await fakeHelper(path, () => {
      if (hangUp) {
        hangUp = false
        return 'close'
      }
      return { ok: true }
    })
    servers.push(server)
    const c = createHelperClient({ sid: SID, log: quiet, pipePath: path })
    clients.push(c)
    await expect(c.restore()).rejects.toThrow(/closed the connection/)
    await expect(c.restore()).resolves.toBeUndefined()
  })

  it('refuses requests once closed', async () => {
    const c = createHelperClient({ sid: SID, log: quiet, pipePath: pipePath() })
    c.close()
    await expect(c.info()).rejects.toThrow(/closed/)
  })
})
