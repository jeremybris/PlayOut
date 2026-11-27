import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogFileSink } from './log-file-sink'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-logsink-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('createLogFileSink', () => {
  it('appends each line at once, creating the folder', async () => {
    const file = join(dir, 'logs', 'main.log')
    const sink = createLogFileSink({
      resolvePath: () => file,
      maxBytes: 1e6,
      onTrouble: () => undefined
    })
    sink.write('PlayOut 1.2.3 starting (packaged)')
    sink.write('[warn] something')
    expect(await fs.readFile(file, 'utf8')).toBe(
      'PlayOut 1.2.3 starting (packaged)\n[warn] something\n'
    )
    expect(sink.path()).toBe(file)
  })

  it('keeps writing after a failed first write (electron-log would keep a dead file) and reports both', async () => {
    // The logs "folder" is a file at first, so the first write fails the way a locked or missing folder does.
    const logs = join(dir, 'logs')
    await fs.writeFile(logs, 'in the way')
    const trouble: string[] = []
    const sink = createLogFileSink({
      resolvePath: () => join(logs, 'main.log'),
      maxBytes: 1e6,
      onTrouble: (t) => trouble.push(t)
    })
    expect(() => sink.write('lost 1')).not.toThrow()
    sink.write('lost 2')
    expect(sink.failedWrites).toBe(2)
    expect(trouble).toHaveLength(1)
    expect(trouble[0]).toMatch(/cannot be written/)

    await fs.rm(logs)
    sink.write('kept')
    expect(await fs.readFile(join(logs, 'main.log'), 'utf8')).toBe('kept\n')
    expect(trouble[1]).toMatch(/writable again \(2 line\(s\) lost\)/)
  })

  it('waits for a path and rotates at maxBytes', async () => {
    const file = join(dir, 'main.log')
    let ready = false
    const sink = createLogFileSink({
      resolvePath: () => (ready ? file : null),
      maxBytes: 10,
      onTrouble: () => undefined
    })
    sink.write('dropped: no path yet')
    expect(sink.path()).toBeNull()
    ready = true
    sink.write('0123456789ab')
    sink.write('next')
    expect(await fs.readFile(join(dir, 'main.old.log'), 'utf8')).toBe('0123456789ab\n')
    expect(await fs.readFile(file, 'utf8')).toBe('next\n')
  })
})
