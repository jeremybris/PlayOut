import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDiagLog } from './diag-log'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-diag-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('createDiagLog', () => {
  it('writes each line to disk at once, with a timestamp, creating the folder', async () => {
    const file = join(dir, 'logs', 'install-size.log')
    const diag = createDiagLog(file)
    diag.line('first')
    // On disk already: no flush, no await.
    const text = await fs.readFile(file, 'utf8')
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} first\n$/)
    diag.line('second')
    expect((await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('never throws, even when the file cannot be written', () => {
    const diag = createDiagLog(join(dir, 'a-file', 'x.log'))
    return fs.writeFile(join(dir, 'a-file'), 'not a folder').then(() => {
      expect(() => diag.line('lost')).not.toThrow()
    })
  })
})
