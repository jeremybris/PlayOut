import { describe, expect, it } from 'vitest'
import {
  cleanPids,
  encodeRequest,
  HELPER_FPS_VERSION,
  HELPER_MEMORY_BUSY,
  HELPER_MEMORY_VERSION,
  HelperMemoryBusyError,
  HELPER_PROTOCOL_VERSION,
  HELPER_RTSS_VERSION,
  isRtssFps,
  MAX_PURGE_BELOW_MB,
  MAX_TRIM_PIDS,
  memTrimRequest,
  parseFps,
  parseMemResult,
  parseMemStart,
  parseMemSteps,
  parseRtssLimit,
  parseRtssSelf,
  rtssLimitRequest,
  rtssSelfRequest,
  helperPipeName,
  helperPipePath,
  LineDecoder,
  MAX_LINE,
  parseInfo,
  parseResponse
} from './protocol'
import { MAX_ELAPSED_MS, parseElapsedMs } from '../memory/trim-cs'

const SID = 'S-1-5-21-3656239912-250964603-1012508381-1001'

describe('pipe name', () => {
  it('is per user', () => {
    expect(helperPipeName(SID)).toBe(`PlayOutPower-${SID}`)
    expect(helperPipePath(SID)).toBe(`\\\\.\\pipe\\PlayOutPower-${SID}`)
  })

  it('refuses anything that is not a SID', () => {
    expect(() => helperPipeName('..\\evil')).toThrow()
    expect(() => helperPipeName('S-1-5-21-1-2-3-1001\\x')).toThrow()
  })
})

describe('framing', () => {
  it('sends one JSON object per line', () => {
    expect(encodeRequest({ op: 'set', watts: 15, boostWatts: null })).toBe(
      '{"op":"set","watts":15,"boostWatts":null}\n'
    )
  })

  it('splits lines across chunks, CRLF or LF, and skips blank lines', () => {
    const d = new LineDecoder()
    expect(d.push('{"ok":tr')).toEqual([])
    expect(d.push('ue}\r\n\n{"ok":false,')).toEqual(['{"ok":true}'])
    expect(d.push('"error":"x"}\n')).toEqual(['{"ok":false,"error":"x"}'])
  })

  it('decodes UTF-8 split inside a character', () => {
    const d = new LineDecoder()
    const bytes = Buffer.from('{"cpu":"Ryzen™"}\n', 'utf8')
    const cut = bytes.indexOf(0xe2) + 1
    expect(d.push(bytes.subarray(0, cut))).toEqual([])
    expect(d.push(bytes.subarray(cut))).toEqual(['{"cpu":"Ryzen™"}'])
  })

  it('throws on a line longer than the limit', () => {
    const d = new LineDecoder()
    expect(() => d.push('x'.repeat(MAX_LINE + 1))).toThrow(/too long/)
  })
})

describe('answers', () => {
  it('parses ok and error answers', () => {
    expect(parseResponse('{"ok":true,"watts":15}')).toEqual({ ok: true, watts: 15 })
    expect(parseResponse('{"ok":false,"error":"locked"}')).toEqual({ ok: false, error: 'locked' })
    expect(parseResponse('{"ok":false}')).toEqual({ ok: false, error: 'The power helper failed' })
    expect(() => parseResponse('nope')).toThrow(/JSON/)
    expect(() => parseResponse('[1]')).toThrow(/unexpected/)
    expect(() => parseResponse('{"watts":1}')).toThrow(/unexpected/)
  })

  it('reads an info answer, dropping wrong types', () => {
    expect(
      parseInfo({
        ok: true,
        method: 'intel-msr',
        cpu: 'Intel(R) Core(TM) Ultra X9 388H',
        minWatts: 5,
        maxWatts: 'lots',
        currentWatts: 7.3,
        locked: true,
        message: 'locked',
        version: 1
      })
    ).toEqual({
      ok: true,
      method: 'intel-msr',
      cpu: 'Intel(R) Core(TM) Ultra X9 388H',
      minWatts: 5,
      maxWatts: undefined,
      currentWatts: 7.3,
      watts: undefined,
      boostWatts: undefined,
      locked: true,
      message: 'locked',
      version: 1
    })
    expect(parseInfo({ ok: true, method: 'ryzenadj' }).method).toBeNull()
    expect(HELPER_PROTOCOL_VERSION).toBe(4)
    expect(HELPER_FPS_VERSION).toBe(2)
    expect(HELPER_RTSS_VERSION).toBe(3)
    expect(HELPER_MEMORY_VERSION).toBe(4)
    // Every gate is a version this helper speaks.
    for (const gate of [HELPER_FPS_VERSION, HELPER_RTSS_VERSION, HELPER_MEMORY_VERSION])
      expect(gate).toBeLessThanOrEqual(HELPER_PROTOCOL_VERSION)
    expect(() => parseInfo({ ok: false, error: 'PawnIO is not installed' })).toThrow(/PawnIO/)
  })
})

describe('frame rates (protocol 2)', () => {
  it('parses a reading, no frames, and a stopped PresentMon', () => {
    expect(
      parseFps({ ok: true, fps: 59.9, frameTimeMs: 16.7, pid: 12, frames: 90, running: true })
    ).toEqual({
      fps: 59.9,
      frameTimeMs: 16.7,
      pid: 12,
      frames: 90,
      running: true
    })
    expect(parseFps({ ok: true, fps: null, running: true })).toEqual({ fps: null, running: true })
    expect(parseFps({ ok: true, fps: null, running: false })).toEqual({ fps: null, running: false })
    expect(parseFps({ ok: true, fps: 0 })).toEqual({ fps: null, running: true })
    expect(parseFps({ ok: true, fps: 'x', pid: 1.5 })).toEqual({ fps: null, running: true })
    expect(() => parseFps({ ok: false, error: 'PresentMon is missing' })).toThrow(/PresentMon/)
  })

  it('keeps only whole pids above 4, once each, at most 64', () => {
    expect(cleanPids([0, 4, 5, 5, 6.5, -1, NaN, 2 ** 33, 77])).toEqual([5, 77])
    expect(cleanPids(Array.from({ length: 100 }, (_, i) => i + 10))).toHaveLength(64)
  })
})

describe('RivaTuner profiles (protocol 3)', () => {
  it('builds requests only for bare program names and whole limits from 0 to 1000', () => {
    expect(rtssLimitRequest('JWE3.exe', 60)).toEqual({ op: 'rtssLimit', exe: 'JWE3.exe', fps: 60 })
    expect(rtssLimitRequest('JWE3.exe', 0)).toEqual({ op: 'rtssLimit', exe: 'JWE3.exe', fps: 0 })
    expect(encodeRequest(rtssSelfRequest('PlayOut.exe'))).toBe(
      '{"op":"rtssSelf","exe":"PlayOut.exe"}\n'
    )
    expect(() => rtssLimitRequest('Global', 60)).toThrow(/Not a program name/)
    expect(() => rtssLimitRequest('..\\x.exe', 60)).toThrow(/Not a program name/)
    expect(() => rtssLimitRequest('x.exe', -1)).toThrow(/Not a frame rate limit/)
    expect(() => rtssLimitRequest('x.exe', 1001)).toThrow(/Not a frame rate limit/)
    expect(() => rtssLimitRequest('x.exe', 59.94)).toThrow(/Not a frame rate limit/)
    expect(() => rtssSelfRequest('C:\\PlayOut.exe')).toThrow(/Not a program name/)
    expect([0, 1, 1000].every(isRtssFps)).toBe(true)
    expect([NaN, '60', null, 1.5].some(isRtssFps)).toBe(false)
  })

  it('parses the answers and throws the helper errors', () => {
    expect(
      parseRtssLimit({ ok: true, exe: 'JWE3.exe', fps: 60, created: true }, 'JWE3.exe', 60)
    ).toEqual({
      exe: 'JWE3.exe',
      fps: 60,
      created: true
    })
    expect(parseRtssLimit({ ok: true }, 'A.exe', 30)).toEqual({
      exe: 'A.exe',
      fps: 30,
      created: false
    })
    expect(parseRtssSelf({ ok: true, changed: true })).toEqual({ changed: true })
    expect(parseRtssSelf({ ok: true })).toEqual({ changed: false })
    expect(() =>
      parseRtssLimit(
        { ok: false, error: 'RivaTuner Statistics Server is not installed' },
        'A.exe',
        30
      )
    ).toThrow(/not installed/)
    expect(() => parseRtssSelf({ ok: false, error: 'Unknown request.' })).toThrow(/Unknown request/)
  })
})

describe('memory cleanup (protocol 4)', () => {
  it('builds a request only from whole pids above 4, at most the cap, and a whole amount', () => {
    const createdBefore = 1_700_000_000_000
    expect(
      memTrimRequest([1234, 5678, 1234], { shell: false, purgeBelowMb: 2048, createdBefore })
    ).toEqual({
      op: 'memTrim',
      pids: [1234, 5678],
      shell: false,
      purgeBelowMb: 2048,
      createdBefore
    })
    expect(encodeRequest(memTrimRequest([], { shell: true, purgeBelowMb: 0, createdBefore }))).toBe(
      '{"op":"memTrim","pids":[],"shell":true,"purgeBelowMb":0,"createdBefore":1700000000000}\n'
    )
    const opts = { shell: false, purgeBelowMb: 0, createdBefore }
    // The time the process list was read is required: without it a reused process id could be trimmed.
    for (const bad of [0, -1, 1.5, NaN, Infinity, undefined as unknown as number])
      expect(() => memTrimRequest([1234], { ...opts, createdBefore: bad }), String(bad)).toThrow(
        /Not a time/
      )
    // Unlike fpsStart nothing is dropped quietly: a list with one bad entry is not sent at all.
    for (const bad of [[4], [0], [-8], [12.5], [NaN], [2 ** 31], ['1234' as unknown as number]])
      expect(() => memTrimRequest(bad, opts), JSON.stringify(bad)).toThrow(/Not a process id/)
    expect(() => memTrimRequest('all' as unknown as number[], opts)).toThrow(/Not a list/)
    const many = Array.from({ length: MAX_TRIM_PIDS + 1 }, (_, i) => 8 + i * 4)
    expect(() => memTrimRequest(many, opts)).toThrow(/Too many/)
    expect(memTrimRequest(many.slice(1), opts)).toMatchObject({ op: 'memTrim' })
    for (const purgeBelowMb of [-1, 1.5, NaN, MAX_PURGE_BELOW_MB + 1])
      expect(() => memTrimRequest([1234], { ...opts, purgeBelowMb })).toThrow(/Not a memory amount/)
    expect(memTrimRequest([1234], { ...opts, shell: 'yes' as unknown as boolean })).toMatchObject({
      shell: false
    })
  })

  it('reads the start answer and throws the helper error', () => {
    expect(parseMemStart({ ok: true, id: 7 })).toEqual({ id: 7 })
    expect(() => parseMemStart({ ok: true })).toThrow(/did not start/)
    expect(() => parseMemStart({ ok: true, id: 0 })).toThrow(/did not start/)
    // Busy is told apart from a refusal: a cleanup is running in the helper, so nobody else may trim.
    const busy = (): unknown => parseMemStart({ ok: false, error: HELPER_MEMORY_BUSY })
    expect(busy).toThrow(/already running/)
    expect(busy).toThrow(HelperMemoryBusyError)
    const refused = (): unknown => parseMemStart({ ok: false, error: 'Not a time.' })
    expect(refused).toThrow('Not a time.')
    expect(refused).not.toThrow(HelperMemoryBusyError)
  })

  it('reads a running cleanup and a finished one, step by step', () => {
    expect(parseMemResult({ ok: true, id: 7, running: true })).toEqual({ id: 7, running: true })
    // No cleanup ever ran.
    expect(parseMemResult({ ok: true, id: 0, running: false })).toEqual({ id: 0, running: false })
    const done = parseMemResult({
      ok: true,
      id: 7,
      running: false,
      steps: {
        workingSets: { state: 'done', trimmed: 41, denied: 3, skipped: 2, gone: 1 },
        modifiedList: { state: 'done' },
        lowPriorityStandby: { state: 'failed', detail: 'the privilege is not held' },
        standby: { state: 'skipped', detail: 'enough memory is free' },
        combine: { state: 'done', pages: 1234 }
      }
    })
    expect(done).toEqual({
      id: 7,
      running: false,
      result: {
        counts: { trimmed: 41, denied: 3, skipped: 2, gone: 1 },
        steps: {
          workingSets: { state: 'done' },
          modifiedList: { state: 'done' },
          lowPriorityStandby: { state: 'failed', detail: 'the privilege is not held' },
          standby: { state: 'skipped', detail: 'enough memory is free' },
          combine: { state: 'done' }
        }
      }
    })
    expect(() => parseMemResult({ ok: false, error: 'Unknown request.' })).toThrow(
      /Unknown request/
    )
  })

  it('reads how long each step and the whole cleanup took', () => {
    const { steps, counts, totalMs } = parseMemSteps({
      workingSets: { state: 'done', trimmed: 131, denied: 2, skipped: 0, gone: 0, ms: 412 },
      modifiedList: { state: 'done', ms: 1830 },
      lowPriorityStandby: { state: 'failed', detail: 'access denied', ms: 0 },
      // A skipped step took no time, whatever it says.
      standby: { state: 'skipped', detail: 'enough memory is free', ms: 5 },
      combine: { state: 'done', pages: 9, ms: 2210.4 },
      totalMs: 4547
    })
    expect(steps).toEqual({
      workingSets: { state: 'done', ms: 412 },
      modifiedList: { state: 'done', ms: 1830 },
      lowPriorityStandby: { state: 'failed', detail: 'access denied', ms: 0 },
      standby: { state: 'skipped', detail: 'enough memory is free' },
      combine: { state: 'done', ms: 2210 }
    })
    expect(counts).toEqual({ trimmed: 131, denied: 2, skipped: 0, gone: 0 })
    expect(totalMs).toBe(4547)
  })

  it('takes a result without times, or with times that are not times, as it is (an older helper)', () => {
    const old = parseMemSteps({
      workingSets: { state: 'done', trimmed: 41, denied: 3, skipped: 2, gone: 1 },
      modifiedList: { state: 'done' },
      lowPriorityStandby: { state: 'done' },
      standby: { state: 'skipped', detail: 'not asked for' },
      combine: { state: 'done' }
    })
    expect(old).not.toHaveProperty('totalMs')
    expect(old.steps.workingSets).toEqual({ state: 'done' })
    expect(old.counts).toEqual({ trimmed: 41, denied: 3, skipped: 2, gone: 1 })
    for (const bad of [-1, '412', null, true, NaN, Infinity, {}, [5]]) {
      const r = parseMemSteps({
        workingSets: { state: 'done', trimmed: 1, ms: bad },
        modifiedList: { state: 'failed', detail: 'x', ms: bad },
        totalMs: bad
      })
      expect(r.steps.workingSets, String(bad)).toEqual({ state: 'done' })
      expect(r.steps.modifiedList, String(bad)).toEqual({ state: 'failed', detail: 'x' })
      expect(r, String(bad)).not.toHaveProperty('totalMs')
      expect(r.counts.trimmed).toBe(1)
    }
    // A number nobody would believe is cut, not passed on.
    const huge = parseMemSteps({ workingSets: { state: 'done', ms: 1e15 }, totalMs: 1e300 })
    expect(huge.steps.workingSets.ms).toBe(MAX_ELAPSED_MS)
    expect(huge.totalMs).toBe(MAX_ELAPSED_MS)
    expect(parseElapsedMs(0)).toBe(0)
    expect(parseElapsedMs(undefined)).toBeUndefined()
  })

  it('never takes a step the helper did not report as done', () => {
    const { steps, counts } = parseMemSteps({
      workingSets: { state: 'finished', trimmed: -1, denied: '3' },
      modifiedList: 'done',
      standby: { state: 'done', detail: 7 }
    })
    const missing = { state: 'failed', detail: 'not reported by the power helper' }
    expect(steps).toEqual({
      workingSets: missing,
      modifiedList: missing,
      lowPriorityStandby: missing,
      standby: { state: 'done' },
      combine: missing
    })
    expect(counts).toEqual({ trimmed: 0, denied: 0, skipped: 0, gone: 0 })
    expect(parseMemSteps(null).steps.workingSets).toEqual(missing)
  })
})
