// Generates PlayOut's application icon from the inline SVG logo below (an original design: the play
// triangle as a faceted lime gem on a deep indigo rounded tile).
//
//   build/icon.png      1024x1024   electron-builder source icon (also used by the NSIS installer)
//   build/icon.ico      16, 32, 48, 64, 128, 256 (PNG-compressed entries; Windows exe + shortcut icon)
//   resources/icon.png  512x512     app icon at runtime (window / taskbar / about screen)
//
// Run with Electron, not Node (the SVG is rasterised by an offscreen BrowserWindow):
//   npx electron scripts/make-icon.mjs
// The script verifies every file it wrote (PNG IHDR dimensions, ICO directory) and exits non-zero on
// any mismatch, so it can run in CI.
import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ICO_SIZES = [16, 32, 48, 64, 128, 256]
const OUTPUTS = [
  { file: join(root, 'build', 'icon.png'), size: 1024 },
  { file: join(root, 'resources', 'icon.png'), size: 512 }
]
const ICO_FILE = join(root, 'build', 'icon.ico')

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

/**
 * The PlayOut logo at a given pixel size (viewBox 1024 units): the play triangle as a faceted lime gem (light upper,
 * mid left and deep lower facets, a darker thickness under its lower edge) on a deep indigo tile. Each facet is
 * rounded with a round-joined stroke of its own colour, which keeps the shape crisp at 16 px.
 */
export function logoSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#352a78"/>
      <stop offset="1" stop-color="#1c1548"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.28" cy="0.1" r="0.95">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.12"/>
      <stop offset="0.6" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="56"/>
    </filter>
    <clipPath id="clip">
      <rect width="1024" height="1024" rx="224"/>
    </clipPath>
  </defs>
  <g clip-path="url(#clip)">
    <rect width="1024" height="1024" fill="url(#tile)"/>
    <rect width="1024" height="1024" fill="url(#sheen)"/>
    <rect x="16" y="16" width="992" height="992" rx="208" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="32"/>
    <polygon points="372,228 372,736 776,482" fill="#8cff2a" opacity="0.35" filter="url(#glow)"/>
    <g stroke-linejoin="round" stroke-width="36">
      <polygon points="372,736 776,482 776,560 372,814" fill="#1f9b2c" stroke="#1f9b2c"/>
      <polygon points="372,228 776,482 500,488" fill="#d9ff5c" stroke="#d9ff5c"/>
      <polygon points="372,228 500,488 372,736" fill="#a6ec1e" stroke="#a6ec1e"/>
      <polygon points="372,736 500,488 776,482" fill="#3fd23a" stroke="#3fd23a"/>
    </g>
    <g stroke="#ffffff" stroke-opacity="0.35" stroke-width="6" fill="none" stroke-linecap="round">
      <line x1="372" y1="228" x2="500" y2="488"/>
      <line x1="500" y1="488" x2="776" y2="482"/>
      <line x1="500" y1="488" x2="372" y2="736"/>
    </g>
  </g>
</svg>`
}

function pageHtml(size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}
</style></head><body>${logoSvg(size)}</body></html>`
}

// ---------------------------------------------------------------------------
// PNG / ICO helpers (pure JS)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Width and height from a PNG's IHDR chunk (the first chunk after the 8-byte signature). */
export function pngSize(buf) {
  if (
    buf.length < 24 ||
    !buf.subarray(0, 8).equals(PNG_SIGNATURE) ||
    buf.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('not a PNG file')
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * ICO container with PNG-compressed images (supported since Windows Vista and by electron-builder).
 * Layout: ICONDIR (6 bytes) + ICONDIRENTRY[count] (16 bytes each) + image data.
 */
export function encodeIco(images) {
  const HEADER = 6
  const ENTRY = 16
  const header = Buffer.alloc(HEADER)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon (2 would be cursor)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(ENTRY * images.length)
  let offset = HEADER + dir.length
  images.forEach(({ size, png }, i) => {
    if (size > 256) throw new Error(`ICO entries are limited to 256 px (got ${size})`)
    const o = i * ENTRY
    dir.writeUInt8(size === 256 ? 0 : size, o) // width, 0 means 256
    dir.writeUInt8(size === 256 ? 0 : size, o + 1) // height
    dir.writeUInt8(0, o + 2) // palette size (none)
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // colour planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...images.map((i) => i.png)])
}

/** Directory entries of an ICO file with the embedded image bytes (for verification). */
export function decodeIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1)
    throw new Error('not an ICO file')
  const count = buf.readUInt16LE(4)
  return Array.from({ length: count }, (_, i) => {
    const o = 6 + i * 16
    const length = buf.readUInt32LE(o + 8)
    const offset = buf.readUInt32LE(o + 12)
    return {
      width: buf.readUInt8(o) || 256,
      height: buf.readUInt8(o + 1) || 256,
      bitsPerPixel: buf.readUInt16LE(o + 6),
      data: buf.subarray(offset, offset + length)
    }
  })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Rasterise the logo at `size` px with the offscreen window; returns PNG bytes with alpha. */
async function renderPng(win, size) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(size)))
  // Offscreen rendering paints asynchronously: wait for two frames, then make sure the capture is
  // not an empty (fully transparent) frame before accepting it.
  for (let attempt = 1; attempt <= 10; attempt++) {
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'
    )
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    const { width, height } = image.getSize()
    if (width !== size || height !== size) {
      throw new Error(`capturePage returned ${width}x${height} for a ${size} px render`)
    }
    const bitmap = image.toBitmap() // BGRA
    const centre = ((size >> 1) * size + (size >> 1)) * 4
    if (bitmap[centre + 3] !== 0) return image.toPNG()
    console.warn(`  ${size} px: blank frame, retrying (${attempt}/10)`)
    await sleep(100)
  }
  throw new Error(`offscreen render of the ${size} px icon stayed blank`)
}

async function writeOut(file, data) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, data)
  console.log(`  wrote ${relative(root, file)} (${data.length.toLocaleString()} bytes)`)
}

/** Re-read every output and check its dimensions; returns the number of problems found. */
async function verify() {
  let problems = 0
  const check = (ok, message) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`)
    if (!ok) problems++
  }
  for (const { file, size } of OUTPUTS) {
    const { width, height } = pngSize(await readFile(file))
    check(
      width === size && height === size,
      `${relative(root, file)} is ${width}x${height} (expected ${size})`
    )
  }
  const entries = decodeIco(await readFile(ICO_FILE))
  check(
    entries.length === ICO_SIZES.length,
    `${relative(root, ICO_FILE)} has ${entries.length} entries (expected ${ICO_SIZES.length})`
  )
  entries.forEach((entry, i) => {
    const expected = ICO_SIZES[i]
    const { width, height } = pngSize(entry.data)
    check(
      entry.width === expected &&
        entry.height === expected &&
        width === expected &&
        height === expected,
      `ico entry ${i}: directory ${entry.width}x${entry.height}, PNG ${width}x${height}, ${entry.bitsPerPixel} bpp (expected ${expected})`
    )
  })
  return problems
}

async function main() {
  console.log('Rendering PlayOut icon')
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    width: 1024,
    height: 1024,
    webPreferences: { offscreen: true, sandbox: true }
  })
  try {
    const sizes = [...new Set([...ICO_SIZES, ...OUTPUTS.map((o) => o.size)])].sort((a, b) => a - b)
    const pngs = new Map()
    for (const size of sizes) {
      pngs.set(size, await renderPng(win, size))
      console.log(`  rendered ${size} px`)
    }
    for (const { file, size } of OUTPUTS) await writeOut(file, pngs.get(size))
    await writeOut(ICO_FILE, encodeIco(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) }))))
  } finally {
    win.destroy()
  }
  console.log('Verifying')
  const problems = await verify()
  if (problems) throw new Error(`${problems} icon file(s) failed verification`)
  console.log('Done')
}

// Keep this throw-away Electron instance away from the real app's profile and from GPU caches that
// another Electron process may hold open.
app.setPath('userData', join(tmpdir(), 'playout-make-icon'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()
// Destroying the render window must not trigger Electron's default "quit when all windows are closed",
// the verification step still has to run.
app.on('window-all-closed', () => {})

// app.exit() kills the process before piped stdout/stderr are flushed, so drain them first.
const flush = (stream) => new Promise((r) => stream.write('', r))

app
  .whenReady()
  .then(main)
  .then(
    async () => {
      await flush(process.stdout)
      app.exit(0)
    },
    async (err) => {
      console.error(err)
      await Promise.all([flush(process.stdout), flush(process.stderr)])
      app.exit(1)
    }
  )
