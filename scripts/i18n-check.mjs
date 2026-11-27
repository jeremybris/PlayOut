// Translation coverage (docs/TRANSLATING.md): `npm run i18n:check [code ...]`.
//
// Compares every language in src/shared/i18n/locales with English, the source: how many English strings it has,
// which are still missing (they show in English until translated), and the errors a translation must not have: keys
// English does not have (a typo, or a key English removed) and {variables} English does not use. Exits 1 on errors,
// 0 when only translations are missing. `--missing` lists every missing key (by default the first 20 per language).
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCALES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'shared',
  'i18n',
  'locales'
)
const SOURCE = 'en'
const LANGUAGE_FILE = '_language.json'
const PLURAL = /_(zero|one|two|few|many|other)$/

const args = process.argv.slice(2)
const listAll = args.includes('--missing')
const only = args.filter((a) => !a.startsWith('--'))

/** Nested JSON objects of strings as "namespace.path" -> string (the same flattening as src/shared/i18n/core.ts). */
function flatten(value, prefix, out) {
  if (typeof value === 'string') out.set(prefix, value)
  else if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [k, v] of Object.entries(value)) flatten(v, `${prefix}.${k}`, out)
  return out
}

function readLanguage(code) {
  const dir = join(LOCALES, code)
  const messages = new Map()
  let info = {}
  const problems = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    let data
    try {
      data = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch (err) {
      problems.push(`${code}/${file}: not valid JSON (${err.message})`)
      continue
    }
    if (file === LANGUAGE_FILE) info = data
    else flatten(data, file.replace(/\.json$/, ''), messages)
  }
  return { code, info, messages, problems }
}

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
const base = (key) => key.replace(PLURAL, '')

const codes = readdirSync(LOCALES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(LOCALES, d.name, LANGUAGE_FILE)))
  .map((d) => d.name)
if (!codes.includes(SOURCE)) {
  console.error(`No ${SOURCE} folder with ${LANGUAGE_FILE} in ${LOCALES}`)
  process.exit(1)
}

const english = readLanguage(SOURCE)
const englishBases = new Map()
for (const [key, text] of english.messages) {
  const list = englishBases.get(base(key)) ?? []
  list.push(text)
  englishBases.set(base(key), list)
}
// A plural's forms count as one string: translated once any form of it is.
const units = [...englishBases.keys()]

let errors = english.problems.length
for (const p of english.problems) console.log(`  error: ${p}`)
console.log(
  `English: ${units.length} strings in ${new Set(units.map((k) => k.split('.')[0])).size} namespaces\n`
)

for (const code of codes.filter((c) => c !== SOURCE && (only.length === 0 || only.includes(c)))) {
  const lang = readLanguage(code)
  const translatedBases = new Set([...lang.messages.keys()].map(base))
  const missing = units.filter((k) => !translatedBases.has(k))
  const extra = [...lang.messages.keys()].filter((k) => !englishBases.has(base(k)))
  const badVars = []
  for (const [key, text] of lang.messages) {
    const allowed = new Set((englishBases.get(base(key)) ?? []).flatMap(placeholders))
    if (PLURAL.test(key)) allowed.add('count')
    for (const name of placeholders(text)) if (!allowed.has(name)) badVars.push(`${key}: {${name}}`)
  }
  const done = units.length - missing.length
  const percent = units.length ? Math.floor((done / units.length) * 100) : 100
  const tags = [lang.info.machineTranslated ? 'machine translated' : null].filter(Boolean)
  console.log(
    `${lang.info.name ?? code} (${code})${tags.length ? ` [${tags.join(', ')}]` : ''}: ${done}/${units.length} (${percent}%)`
  )
  if (!lang.info.nativeName) console.log(`  note: ${LANGUAGE_FILE} has no nativeName`)
  const shown = listAll ? missing : missing.slice(0, 20)
  for (const key of shown) console.log(`  missing: ${key}`)
  if (shown.length < missing.length)
    console.log(`  ... and ${missing.length - shown.length} more (--missing lists them all)`)
  for (const p of lang.problems) console.log(`  error: ${p}`)
  for (const key of extra) console.log(`  error: not in English: ${key}`)
  for (const v of badVars) console.log(`  error: variable not in English: ${v}`)
  errors += lang.problems.length + extra.length + badVars.length
  console.log('')
}

if (errors) {
  console.log(`${errors} error(s): fix them before sharing the translation.`)
  process.exit(1)
}
