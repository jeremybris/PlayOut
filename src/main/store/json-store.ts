import { constants as fsConstants, promises as fs } from 'fs'
import { dirname } from 'path'
import { createLogger } from '../logger'

const log = createLogger('store')

/** Where failed writes are also reported (main/index.ts: the diagnostic log), besides the regular log. */
let writeErrorSink: ((file: string, err: unknown) => void) | null = null

/** Where each store write's steps are traced (main/index.ts: the diagnostic log); null = not traced. */
let writeTraceSink: ((text: string) => void) | null = null

/** Trace store writes to `sink`: the first few of each file, then every 50th, and every slow one. */
export function onStoreWriteTrace(sink: ((text: string) => void) | null): void {
  writeTraceSink = sink
}

/** Report every failed store write to `sink` as well (one sink for the app). */
export function onStoreWriteError(sink: ((file: string, err: unknown) => void) | null): void {
  writeErrorSink = sink
}

/** JSON for a store file; a BigInt (a 64-bit id that slipped into the data) is written as its decimal string. */
function serialize(data: unknown): string {
  return JSON.stringify(
    data,
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    2
  )
}

const READ_ATTEMPTS = 4
const READ_RETRY_DELAY_MS = 250
/** Backups kept of a file that turned out corrupt: `<file>.bak`, then `<file>.bak.1` up to `.bak.4`. */
const MAX_BACKUPS = 5

export interface JsonStoreOptions<T> {
  file: string
  defaults: () => T
  /** Turn raw parsed JSON into a valid T (fill defaults, migrate). Return null to reject the file. */
  normalize?: (raw: unknown) => T | null
  debounceMs?: number
  /**
   * Write no later than this long after the first unwritten `set`, however often sets keep arriving (the art
   * pipeline sets media every 250 ms for minutes: a trailing debounce alone would never write). Default 8 x
   * `debounceMs`.
   */
  maxWaitMs?: number
}

/**
 * A tiny persistent JSON document: load once, mutate in memory, debounced atomic writes (tmp file + rename).
 * A corrupt file is copied to `<file>.bak` (`.bak.1` ... when that exists already) and replaced by defaults.
 */
export class JsonStore<T> {
  private data: T
  private timer: NodeJS.Timeout | null = null
  /** When the oldest unwritten change was made (null = nothing pending). */
  private dirtySince: number | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private loaded = false
  private readonly listeners = new Set<(data: T) => void>()

  constructor(private readonly options: JsonStoreOptions<T>) {
    this.data = options.defaults()
  }

  get file(): string {
    return this.options.file
  }

  async load(): Promise<T> {
    if (this.loaded) return this.data
    const text = await this.readText()
    this.loaded = true
    if (text !== null) {
      try {
        const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
        const normalized = this.options.normalize ? this.options.normalize(raw) : (raw as T)
        if (normalized === null) throw new Error('rejected by normalize()')
        this.data = normalized
        return this.data
      } catch (err) {
        log.error(
          `Corrupt store ${this.options.file}: ${(err as Error).message}; keeping a .bak and using defaults`
        )
        try {
          await this.backUpCorrupt(text)
        } catch {
          /* ignore */
        }
      }
    }
    this.data = this.options.defaults()
    return this.data
  }

  /**
   * Copy the corrupt file to the first free backup name (`.bak`, `.bak.1`, ...), never over an earlier backup: the
   * first one usually holds the most data (later ones are the defaults that replaced it, corrupted again). A file
   * already backed up (it stays on disk until the next write, so every start sees it again) takes no further slot.
   * Only when every slot is taken is the last one replaced.
   */
  private async backUpCorrupt(text: string): Promise<void> {
    const file = this.options.file
    const names = Array.from({ length: MAX_BACKUPS }, (_, i) => `${file}.bak${i ? `.${i}` : ''}`)
    for (const name of names) {
      try {
        await fs.copyFile(file, name, fsConstants.COPYFILE_EXCL)
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        if ((await fs.readFile(name, 'utf8').catch(() => null)) === text) return
      }
    }
    await fs.copyFile(file, names[names.length - 1])
  }

  /**
   * The file's text, or null only when it does not exist. A file that exists but cannot be read (locked by a backup
   * or an antivirus scan) gets a few more tries and then rejects: defaults here would overwrite it on the next write.
   */
  private async readText(): Promise<string | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fs.readFile(this.options.file, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        if (attempt >= READ_ATTEMPTS) {
          throw new Error(`Could not read ${this.options.file}: ${(err as Error).message}`, {
            cause: err
          })
        }
        log.warn(`Could not read ${this.options.file}: ${(err as Error).message}; retrying`)
        await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAY_MS))
      }
    }
  }

  get(): T {
    return this.data
  }

  /** Mutate in place (or return a replacement) and schedule a write. */
  set(mutator: (draft: T) => T | void): T {
    const result = mutator(this.data)
    if (result !== undefined) this.data = result
    this.scheduleWrite()
    return this.data
  }

  replace(data: T): T {
    this.data = data
    this.scheduleWrite()
    return this.data
  }

  onChange(listener: (data: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Write immediately (awaits any in-flight write). Never rejects: a failed write is logged and reported. */
  async flush(): Promise<void> {
    await this.tryFlush()
  }

  /**
   * `flush()` for a caller that needs the outcome (the saves at closing): false when this write failed. Never
   * rejects.
   */
  async tryFlush(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.dirtySince = null
    let written = true
    this.writeChain = this.writeChain
      .then(() => this.writeAtomic())
      .catch((err) => {
        written = false
        log.error(`write failed ${this.options.file}`, err)
        try {
          writeErrorSink?.(this.options.file, err)
        } catch {
          /* the sink must not break the store */
        }
      })
    await this.writeChain
    return written
  }

  private scheduleWrite(): void {
    for (const l of this.listeners) {
      try {
        l(this.data)
      } catch (err) {
        log.error('store listener failed', err)
      }
    }
    const debounceMs = this.options.debounceMs ?? 250
    const maxWaitMs = this.options.maxWaitMs ?? debounceMs * 8
    const now = Date.now()
    this.dirtySince ??= now
    if (this.timer) clearTimeout(this.timer)
    // Trailing debounce, capped: a stream of sets closer together than `debounceMs` still lands on disk every
    // `maxWaitMs`.
    const delay = Math.max(0, Math.min(debounceMs, this.dirtySince + maxWaitMs - now))
    this.timer = setTimeout(() => void this.flush(), delay)
  }

  private writes = 0

  private async writeAtomic(): Promise<void> {
    const file = this.options.file
    const n = ++this.writes
    const started = Date.now()
    // Traced: the first three writes of a file, every 50th, and any that took over 2 s (step by step, so a write that
    // never finishes shows where it stopped).
    const traced = !!writeTraceSink && (n <= 3 || n % 50 === 0)
    const trace = (text: string): void => {
      try {
        writeTraceSink?.(`store write #${n} ${file}: ${text} (${Date.now() - started} ms)`)
      } catch {
        /* never break a write */
      }
    }
    if (traced) trace('start')
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    const text = serialize(this.data)
    if (traced) trace(`serialized ${text.length.toLocaleString('en-US')} chars`)
    await fs.writeFile(tmp, text, 'utf8')
    if (traced) trace('temp file written')
    await fs.rename(tmp, file)
    const ms = Date.now() - started
    if (traced || ms > 2000) trace(`saved${ms > 2000 ? ' (slow)' : ''}`)
  }
}
