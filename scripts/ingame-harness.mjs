// End-to-end check of PlayOut's in-game overlay (ingame-helper/): this script plays PlayOut's part. It starts the test
// game (PlayOutIngameTest.exe), probes and injects it with PlayOutIngame64.exe, serves the named pipe (the same framing
// as src/main/overlay/ingame/protocol.ts, re-implemented here in plain JS) and walks the protocol: HELLO, SHOW + FRAME
// -> PRESENTING (and the drawn pixel), HIDE -> HIDDEN, the hold loop (the game's loop stops, Present goes on), the
// pipe dropped (the game survives, dormant), a second inject (reconnect) and DETACH, then `watch`.
//
//   node scripts/ingame-harness.mjs              windowed (SHOW carries the test-only "anyMode": true)
//   node scripts/ingame-harness.mjs --exclusive  a short run in exclusive full screen (no anyMode)
//
// Needs the build (node scripts/build-ingame-helper.mjs): resources/ingame and ingame-helper/build/PlayOutIngameTest.exe.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helper = join(root, 'resources', 'ingame', 'PlayOutIngame64.exe')
const dll = join(root, 'resources', 'ingame', 'PlayOutOverlay64.dll')
const testApp = join(root, 'ingame-helper', 'build', 'PlayOutIngameTest.exe')
const exclusive = process.argv.includes('--exclusive')
const verbose = process.argv.includes('--verbose')

// ---- framing (PROTOCOL.md, section 2) ----------------------------------------------------------------------------

const HELLO = 1
const RESIZE = 2
const PRESENTING = 3
const FAULT = 4
const LOG = 5
const PONG = 6
const UNSUPPORTED = 7
const HIDDEN = 8
const SHOW = 101
const HIDE = 102
const FRAME = 103
const PING = 104
const INPUT_RELEASE = 105
const DETACH = 106
const NAMES = {
  1: 'HELLO',
  2: 'RESIZE',
  3: 'PRESENTING',
  4: 'FAULT',
  5: 'LOG',
  6: 'PONG',
  7: 'UNSUPPORTED',
  8: 'HIDDEN'
}

function encode(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(type, 0)
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function encodeJson(type, value = {}) {
  return encode(type, Buffer.from(Object.keys(value).length ? JSON.stringify(value) : '', 'utf8'))
}

/** A full-size FRAME: a semi-transparent vertical gradient with an opaque magenta box in the middle (premultiplied). */
function encodeFrame(width, height) {
  const pixels = Buffer.alloc(width * height * 4)
  const box = { x0: width / 2 - 60, x1: width / 2 + 60, y0: height / 2 - 60, y1: height / 2 + 60 }
  for (let y = 0; y < height; y++) {
    const alpha = Math.round((y / height) * 160)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) {
        pixels[i] = 255 // B
        pixels[i + 1] = 0 // G
        pixels[i + 2] = 255 // R
        pixels[i + 3] = 255 // A
      } else {
        pixels[i] = alpha // blue, premultiplied: value <= alpha
        pixels[i + 1] = Math.round(alpha * 0.3)
        pixels[i + 2] = 0
        pixels[i + 3] = alpha
      }
    }
  }
  const head = Buffer.alloc(24)
  ;[0, 0, width, height, width, height].forEach((v, k) => head.writeUInt32LE(v, k * 4))
  return encode(FRAME, Buffer.concat([head, pixels]))
}

class Reader {
  buffer = Buffer.alloc(0)
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out = []
    while (this.buffer.length >= 8) {
      const type = this.buffer.readUInt32LE(0)
      const length = this.buffer.readUInt32LE(4)
      if (length > 64 * 1024 * 1024) throw new Error('payload too large')
      if (this.buffer.length < 8 + length) break
      const payload = this.buffer.subarray(8, 8 + length)
      out.push({ type, json: length ? JSON.parse(payload.toString('utf8')) : {} })
      this.buffer = this.buffer.subarray(8 + length)
    }
    return out
  }
}

// ---- helpers ----------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function runHelper(args) {
  return new Promise((resolvePromise) => {
    execFile(helper, args, { windowsHide: true }, (error, stdout) => {
      const line = stdout.trim().split(/\r?\n/).pop() ?? ''
      let json = null
      try {
        json = JSON.parse(line)
      } catch {
        /* reported below */
      }
      resolvePromise({ code: error?.code ?? 0, json, line })
    })
  })
}

/** The test game: its JSON stat lines as they arrive. */
function startGame(seconds) {
  const args = [
    exclusive ? '--exclusive' : '--windowed',
    '--seconds',
    String(seconds),
    '--readback'
  ]
  const child = spawn(testApp, args, { stdio: ['ignore', 'pipe', 'inherit'] })
  const game = { child, stats: [], waiters: [], exited: null }
  let rest = ''
  child.stdout.on('data', (chunk) => {
    rest += chunk.toString('utf8')
    const lines = rest.split(/\r?\n/)
    rest = lines.pop()
    for (const line of lines.filter(Boolean)) {
      const stat = JSON.parse(line)
      game.stats.push(stat)
      if (verbose) console.log(`      game ${line}`)
      game.waiters.splice(0).forEach((w) => w(stat))
    }
  })
  child.on('exit', (code) => (game.exited = code))
  game.next = () => new Promise((r) => game.waiters.push(r))
  return game
}

/** PlayOut's pipe server: one connection, its messages, waits for a given type. */
function startServer() {
  const name = `\\\\.\\pipe\\PlayOut-ingame-${randomBytes(16).toString('hex')}`
  const token = randomBytes(32).toString('hex')
  const s = {
    name,
    token,
    socket: null,
    messages: [],
    pending: [],
    waiters: [],
    closed: false,
    pongs: 0,
    pinger: null
  }
  s.server = net.createServer((socket) => {
    if (s.socket) return socket.destroy()
    s.socket = socket
    const reader = new Reader()
    socket.on('data', (chunk) => {
      for (const m of reader.push(chunk)) {
        if (m.type === LOG) console.log(`      dll ${m.json.level}: ${m.json.message}`)
        else if (m.type === PONG) s.pongs++
        else console.log(`      <- ${NAMES[m.type] ?? m.type} ${JSON.stringify(m.json)}`)
        s.messages.push(m)
        const before = s.waiters.length
        s.waiters = s.waiters.filter((w) => !w(m))
        if (s.waiters.length === before && m.type !== LOG && m.type !== PONG) s.pending.push(m)
      }
    })
    socket.on('close', () => {
      s.closed = true
      clearInterval(s.pinger)
      s.waiters.splice(0).forEach((w) => w(null))
    })
    socket.on('error', () => {})
  })
  s.listen = () => new Promise((r) => s.server.listen(name, r))
  s.send = (buffer) => s.socket?.write(buffer)
  s.wait = (type, ms = 3000) =>
    new Promise((r) => {
      // A message that arrived before anyone waited for it counts.
      const early = s.pending.findIndex((m) => m.type === type)
      if (early >= 0) return r(s.pending.splice(early, 1)[0])
      const timer = setTimeout(() => r(null), ms)
      s.waiters.push((m) => {
        if (m && m.type !== type) return false
        clearTimeout(timer)
        r(m)
        return true
      })
    })
  s.startPings = () => (s.pinger = setInterval(() => s.send(encodeJson(PING)), 500))
  s.stop = () => {
    clearInterval(s.pinger)
    s.socket?.destroy()
    s.server.close()
  }
  return s
}

async function injectInto(pid, server) {
  const r = await runHelper([
    'inject',
    '--pid',
    String(pid),
    '--dll',
    dll,
    '--pipe',
    server.name,
    '--token',
    server.token,
    '--playout-pid',
    String(process.pid)
  ])
  console.log(`      inject: ${r.line}`)
  return r
}

async function waitHello(server, pid) {
  const hello = await server.wait(HELLO, 8000)
  const ok =
    !!hello && hello.json.token === server.token && hello.json.pid === pid && hello.json.proto === 1
  return { hello, ok }
}

/** Whether the test game's centre pixel (RRGGBBAA) is the FRAME's magenta box. */
const isMagenta = (pixel) => /^f[a-f0-9]0[0-9a-f]f[a-f0-9]ff$/.test(pixel ?? '')

// ---- the run ----------------------------------------------------------------------------------------------------

async function main() {
  for (const f of [helper, dll, testApp]) {
    if (!existsSync(f)) throw new Error(`${f} is missing: run node scripts/build-ingame-helper.mjs`)
  }
  console.log(`ingame-harness: ${exclusive ? 'EXCLUSIVE full screen' : 'windowed'} run`)
  const game = startGame(exclusive ? 11 : 40)
  const pid = game.child.pid
  await game.next()

  const probe = await runHelper(['probe', '--pid', String(pid)])
  console.log(`      probe: ${probe.line}`)
  check(
    'probe: x64, not elevated/protected, no anti-cheat, d3d11 + dxgi, not injected',
    probe.code === 0 &&
      probe.json?.ok &&
      probe.json.arch === 'x64' &&
      !probe.json.elevated &&
      !probe.json.protected &&
      !probe.json.appContainer &&
      probe.json.antiCheat.length === 0 &&
      probe.json.graphics.includes('d3d11') &&
      probe.json.graphics.includes('dxgi') &&
      !probe.json.injected
  )

  // ---- session 1 ----
  const s1 = startServer()
  await s1.listen()
  const inject = await injectInto(pid, s1)
  check('inject: ok, step done', inject.json?.ok === true && inject.json.step === 'done')
  const h1 = await waitHello(s1, pid)
  check('HELLO: token, pid and protocol match', h1.ok)
  s1.startPings()
  const resize = await s1.wait(RESIZE, 2000)
  const width = resize?.json.width || h1.hello?.json.width || 1280
  const height = resize?.json.height || h1.hello?.json.height || 720
  check('RESIZE after the first Present', !!resize, resize ? JSON.stringify(resize.json) : 'none')
  if (exclusive) check('exclusive: GetFullscreenState TRUE', resize?.json.exclusive === true)

  // SHOW (game keeps running) + FRAME -> PRESENTING, pixel drawn.
  s1.send(encodeJson(SHOW, exclusive ? { hold: false } : { hold: false, anyMode: true }))
  s1.send(encodeFrame(width, height))
  const presenting = await s1.wait(PRESENTING, 3000)
  check('SHOW {hold:false} -> PRESENTING {held:false}', presenting?.json.held === false)
  await game.next()
  const shown = await game.next()
  check(
    'the overlay is drawn (centre pixel is the FRAME box)',
    isMagenta(shown.pixel),
    `pixel ${shown.pixel}`
  )

  s1.send(encodeJson(HIDE))
  check('HIDE -> HIDDEN', !!(await s1.wait(HIDDEN, 2000)))
  await game.next()
  const hidden = await game.next()
  check('after HIDE the overlay is gone', !isMagenta(hidden.pixel), `pixel ${hidden.pixel}`)

  // SHOW {hold:true}: the game's loop stops, Present goes on.
  s1.send(encodeJson(SHOW, exclusive ? { hold: true } : { hold: true, anyMode: true }))
  const held = await s1.wait(PRESENTING, 3000)
  check('SHOW {hold:true} -> PRESENTING {held:true}', held?.json.held === true)
  const h0 = await game.next()
  const h2 = await game.next()
  check(
    'hold loop: loopTicks stop, presents go on',
    h2.loopTicks - h0.loopTicks <= 1 && h2.presents - h0.presents >= 20,
    `loopTicks +${h2.loopTicks - h0.loopTicks}, presents +${h2.presents - h0.presents}`
  )
  s1.send(encodeJson(HIDE))
  check('HIDE ends the hold -> HIDDEN', !!(await s1.wait(HIDDEN, 2000)))
  const r0 = await game.next()
  const r1 = await game.next()
  check(
    'the game loop runs again',
    r1.loopTicks - r0.loopTicks >= 20,
    `loopTicks +${r1.loopTicks - r0.loopTicks}`
  )
  s1.send(encodeJson(INPUT_RELEASE))
  check('PONG answers PING', s1.pongs > 0, `${s1.pongs} PONGs`)

  if (exclusive) {
    s1.send(encodeJson(DETACH))
    await sleep(500)
    check('DETACH closes the pipe', s1.closed)
    check(
      'no FAULT or UNSUPPORTED',
      !s1.messages.some((m) => m.type === FAULT || m.type === UNSUPPORTED)
    )
    s1.stop()
    await new Promise((r) => (game.exited !== null ? r() : game.child.on('exit', r)))
    check('the game ran to its end', game.exited === 0, `exit code ${game.exited}`)
    return
  }

  // The pipe is dropped: the game survives with the DLL dormant.
  check(
    'no FAULT or UNSUPPORTED (session 1)',
    !s1.messages.some((m) => m.type === FAULT || m.type === UNSUPPORTED)
  )
  s1.stop()
  const d0 = await game.next()
  const d1 = await game.next()
  const d2 = await game.next()
  check(
    'pipe lost: the game runs on (dormant)',
    game.exited === null && d2.frames - d0.frames >= 40 && d1.frames > d0.frames,
    `frames +${d2.frames - d0.frames}`
  )

  // ---- session 2: a second inject reconnects the dormant DLL ----
  const s2 = startServer()
  await s2.listen()
  const again = await injectInto(pid, s2)
  check('second inject: ok, step already', again.json?.ok === true && again.json.step === 'already')
  const h2b = await waitHello(s2, pid)
  check('reconnect: HELLO on the new pipe with the new token', h2b.ok)
  s2.startPings()
  s2.send(encodeJson(SHOW, { hold: true, anyMode: true }))
  check(
    'reconnect: SHOW {hold:true} -> PRESENTING {held:true}',
    (await s2.wait(PRESENTING, 3000))?.json.held === true
  )
  // PlayOut stops answering (no PING): within ~2 s the DLL drops the pipe and lets the game go.
  clearInterval(s2.pinger)
  const w0 = Date.now()
  while (!s2.closed && Date.now() - w0 < 5000) await sleep(100)
  check('missed heartbeat: the DLL closes the pipe', s2.closed, `${Date.now() - w0} ms`)
  await game.next()
  const m0 = await game.next()
  const m1 = await game.next()
  check(
    'missed heartbeat: the hold ends',
    m1.loopTicks - m0.loopTicks >= 20,
    `loopTicks +${m1.loopTicks - m0.loopTicks}`
  )
  check(
    'no FAULT or UNSUPPORTED (session 2)',
    !s2.messages.some((m) => m.type === FAULT || m.type === UNSUPPORTED)
  )
  s2.stop()

  // ---- session 3: reconnect again, then DETACH ----
  const s3 = startServer()
  await s3.listen()
  const third = await injectInto(pid, s3)
  check('third inject: ok, step already', third.json?.ok === true && third.json.step === 'already')
  check('reconnect: HELLO', (await waitHello(s3, pid)).ok)
  s3.startPings()
  s3.send(encodeJson(SHOW, { hold: false, anyMode: true }))
  check('reconnect: SHOW -> PRESENTING', (await s3.wait(PRESENTING, 3000))?.json.held === false)
  s3.send(encodeJson(DETACH))
  await sleep(1000)
  check('DETACH closes the pipe', s3.closed)
  check(
    'no FAULT or UNSUPPORTED (session 3)',
    !s3.messages.some((m) => m.type === FAULT || m.type === UNSUPPORTED)
  )
  s3.stop()
  const e0 = await game.next()
  const e1 = await game.next()
  check(
    'after DETACH the game runs on, overlay gone',
    e1.frames > e0.frames && !isMagenta(e1.pixel)
  )

  const probe2 = await runHelper(['probe', '--pid', String(pid)])
  check('probe: injected true', probe2.json?.injected === true)

  // `watch` reports the exit code when the game ends.
  const watch = runHelper(['watch', '--pid', String(pid)])
  await sleep(300)
  game.child.kill()
  const watched = await watch
  console.log(`      watch: ${watched.line}`)
  check(
    'watch reports the exit code',
    watched.json?.pid === pid && typeof watched.json.exitCode === 'number'
  )
}

main()
  .catch((e) => {
    console.error(e)
    results.push({ name: 'harness', ok: false })
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok)
    console.log(`ingame-harness: ${results.length - failed.length}/${results.length} passed`)
    process.exit(failed.length ? 1 : 0)
  })
