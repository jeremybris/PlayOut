import { existsSync, promises as fs, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { unpackPs4Pkg } from './ps4-pkg'

/**
 * A real package, unpacked: PLAYOUT_PS4_PKG names a fake PS4 package and PLAYOUT_PS4_OUT a scratch folder (the game
 * folder is made inside it and left there for a look). Skipped unless both are set.
 */
const PKG = process.env.PLAYOUT_PS4_PKG
const OUT = process.env.PLAYOUT_PS4_OUT

function walk(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const r = walk(p)
      files += r.files
      bytes += r.bytes
    } else {
      files++
      bytes += statSync(p).size
    }
  }
  return { files, bytes }
}

describe.skipIf(!PKG || !OUT)('PS4 package unpacking against a real package', () => {
  it('unpacks the game folder', { timeout: 2 * 60 * 60 * 1000 }, async () => {
    const out = join(OUT!, 'game')
    await fs.rm(out, { recursive: true, force: true })
    const started = Date.now()
    let reports = 0
    const result = await unpackPs4Pkg(PKG!, out, {
      onProgress: (p) => {
        if (++reports % 40 === 0) console.log(`progress ${((100 * p.done) / p.total).toFixed(1)}%`)
      }
    })
    console.log(
      `${result.header.contentId}: ${result.files} files, ${(result.bytes / 2 ** 30).toFixed(2)} GiB in ${((Date.now() - started) / 1000).toFixed(0)} s`
    )
    console.log(`top level: ${readdirSync(out).join(', ')}`)
    console.log(`sce_sys: ${readdirSync(join(out, 'sce_sys')).join(', ')}`)
    const onDisk = walk(out)
    console.log(`on disk: ${onDisk.files} files, ${onDisk.bytes} bytes`)
    expect(existsSync(join(out, 'eboot.bin'))).toBe(true)
    expect(existsSync(join(out, 'sce_sys', 'param.sfo'))).toBe(true)
    const elf = Buffer.alloc(4)
    const fh = await fs.open(join(out, 'eboot.bin'), 'r')
    await fh.read(elf, 0, 4, 0)
    await fh.close()
    console.log(`eboot.bin starts ${elf.toString('hex')}`)
    expect(onDisk.files).toBe(result.files)
  })
})
