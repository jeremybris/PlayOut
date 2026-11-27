import { promises as fs } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * PlayOut runs on Electron, whose crypto is BoringSSL, not the OpenSSL of plain Node (where the tests run). Some
 * ciphers exist only in OpenSSL ('aes-128-xts' failed with "Unknown cipher" in the app while every test passed), so
 * the main process may only name ciphers Electron has. These are the ones checked in Electron's runtime.
 */
const ELECTRON_CIPHERS = new Set([
  'aes-128-cbc',
  'aes-192-cbc',
  'aes-256-cbc',
  'aes-128-ecb',
  'aes-256-ecb',
  'aes-128-ctr',
  'aes-256-ctr',
  'aes-128-gcm',
  'aes-256-gcm'
])

async function sources(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await sources(p)))
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

describe('ciphers in the main process', () => {
  it('names only ciphers that Electron (BoringSSL) has', async () => {
    const used: string[] = []
    for (const file of await sources(join(__dirname, '..'))) {
      const text = await fs.readFile(file, 'utf8')
      for (const m of text.matchAll(/create(?:De)?[Cc]ipheriv\(\s*'([^']+)'/g)) used.push(m[1]!)
    }
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter((c) => !ELECTRON_CIPHERS.has(c))).toEqual([])
  })
})
