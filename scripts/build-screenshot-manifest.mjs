// Builds steam-screenshots.json for PlayOut's Drive screenshot mirror (src/main/scrapers/screenshot-mirror.ts): lists
// the public folder's steam_<appId> game folders and their steam-thumb-<key>.jpg files, reads each game's screenshot
// list from Steam's store, and writes the lists with the Drive file of each thumbnail. Upload the result to the root
// of the Drive folder (replacing the old one). A re-run resumes from <outDir>/state.json and picks up game folders
// uploaded since; delete state.json to start over.
// usage: node scripts/build-screenshot-manifest.mjs <outDir> [folderId]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2]
const ROOT = process.argv[3] || '17I39D1VSUFZ2SK_8271tjcG6_BL_ekGk'
if (!OUT) {
  console.error('usage: node scripts/build-screenshot-manifest.mjs <outDir> [folderId]')
  process.exit(2)
}
fs.mkdirSync(OUT, { recursive: true })
const STATE = path.join(OUT, 'state.json')
const UA = 'PlayOut manifest builder'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const state = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, 'utf8'))
  : { folders: null, files: {}, details: {} }
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state))

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
function parse(html) {
  const out = []
  const re = /id="entry-([\w-]+)"[\s\S]*?class="flip-entry-title">([^<]+)</g
  let m
  while ((m = re.exec(html))) out.push({ id: m[1], name: decode(m[2].trim()) })
  return out
}
async function text(url, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } })
      if (r.status === 429 || r.status >= 500) throw new Error('status ' + r.status)
      if (!r.ok) return { status: r.status, body: '' }
      return { status: r.status, body: await r.text() }
    } catch (e) {
      if (i >= tries) throw e
      await sleep(5000 * (i + 1) * (String(e.message).includes('429') ? 12 : 1))
    }
  }
}
const listing = async (id) =>
  parse((await text(`https://drive.google.com/embeddedfolderview?id=${id}`)).body)
const key = (thumb) =>
  crypto
    .createHash('sha1')
    .update(thumb.split('?')[0].toLowerCase())
    .digest('base64url')
    .slice(0, 16)

async function main() {
  // Always read the root again: game folders may have been uploaded since the last run.
  state.folders = (await listing(ROOT)).filter((f) => /^steam_\d+$/.test(f.name))
  saveState()
  console.log('folders', state.folders.length)
  // Drive files per folder (always re-listed unless already seen with thumbnails: uploads may still be landing).
  const todo = state.folders.filter(
    (f) => !(state.files[f.name] && Object.keys(state.files[f.name]).length)
  )
  let n = 0
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (todo.length) {
        const f = todo.shift()
        const thumbs = {}
        for (const e of await listing(f.id)) {
          const m = /^steam-thumb-([A-Za-z0-9_-]{16})\.jpg$/.exec(e.name)
          if (m) thumbs[m[1]] = e.id
        }
        state.files[f.name] = thumbs
        if (++n % 100 === 0) {
          console.log('listed', n)
          saveState()
        }
      }
    })
  )
  saveState()
  const withThumbs = state.folders.filter((f) => Object.keys(state.files[f.name] || {}).length)
  console.log('folders with thumbnails', withThumbs.length)
  let d = 0
  for (const f of withThumbs) {
    const appId = f.name.slice(6)
    if (state.details[appId]) continue
    const r = await text(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=screenshots`
    )
    let shots = []
    try {
      const j = JSON.parse(r.body)[appId]
      shots = (j && j.success && j.data && j.data.screenshots) || []
    } catch {
      // Not JSON (an error page): no screenshots for this game.
    }
    state.details[appId] = shots
      .map((s) => {
        const thumbnail = (s.path_thumbnail || s.path_full || '').trim()
        return { thumbnail, full: (s.path_full || thumbnail).trim() }
      })
      .filter((s) => s.thumbnail)
    if (++d % 25 === 0) {
      console.log('details', d)
      saveState()
    }
    await sleep(1600)
  }
  saveState()
  const games = {}
  let matched = 0
  let unmatched = 0
  for (const f of withThumbs) {
    const appId = f.name.slice(6)
    const files = state.files[f.name]
    const items = (state.details[appId] || []).map((s) => {
      const id = files[key(s.thumbnail)]
      if (id) matched++
      return id ? { ...s, drive: id } : s
    })
    unmatched += Object.keys(files).length - items.filter((s) => s.drive).length
    if (items.some((s) => s.drive)) games[appId] = items
  }
  const manifest = { version: 1, generatedAt: new Date().toISOString(), games }
  fs.writeFileSync(path.join(OUT, 'steam-screenshots.json'), JSON.stringify(manifest))
  console.log(
    `done: ${Object.keys(games).length} games, ${matched} thumbnails matched, ${unmatched} Drive files without a current Steam screenshot`
  )
}
main().catch((e) => {
  saveState()
  console.error(e)
  process.exit(1)
})
