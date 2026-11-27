import type { CommandResult, HomeButtonIo } from './io'

/**
 * An in-memory Windows for the home button's tests: files, HKCU values (through a fake reg.exe), running programs
 * (through a fake tasklist.exe) and Steam's reaction to `-shutdown` / `-silent`.
 */
export interface FakeWindows {
  io: HomeButtonIo
  files: Map<string, Buffer>
  registry: Map<string, { type: string; data: string | number }>
  processes: Set<string>
  spawned: { file: string; args: string[] }[]
  commands: string[][]
  /** Sleeps Steam takes to exit after -shutdown (Infinity: never). */
  steamExitAfter: number
  /** Called when the fake Steam exits (it writes its files then). */
  onSteamExit?: () => void
  sleeps: number
  setText(path: string, text: string): void
  text(path: string): string | null
}

const norm = (p: string): string => p.replace(/\//g, '\\').toLowerCase()

export function createFakeWindows(): FakeWindows {
  const files = new Map<string, Buffer>()
  const registry = new Map<string, { type: string; data: string | number }>()
  /** Keys that exist (lower case), also without values of their own. */
  const keys = new Set<string>()
  const processes = new Set<string>()
  const spawned: { file: string; args: string[] }[] = []
  const commands: string[][] = []
  let exitIn: number | null = null

  const regKey = (key: string, name: string): string => `${key.toLowerCase()}|${name.toLowerCase()}`
  const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
  const notFound: CommandResult = {
    code: 1,
    stdout: '',
    stderr: 'ERROR: The system was unable to find the specified registry key or value.'
  }

  const fake: FakeWindows = {
    files,
    registry,
    processes,
    spawned,
    commands,
    steamExitAfter: 2,
    sleeps: 0,
    setText(path, text) {
      files.set(norm(path), Buffer.from(text, 'utf8'))
    },
    text(path) {
      const b = files.get(norm(path))
      return b ? b.toString('utf8') : null
    },
    io: {
      async run(file, args) {
        commands.push([file, ...args])
        if (file === 'tasklist.exe') {
          return ok(
            [...processes].map((p) => `"${p}","1234","Console","1","10,000 K"`).join('\r\n') +
              '\r\n'
          )
        }
        if (file === 'reg.exe') {
          const [verb, key] = args
          // A value (/v name), the key's default value (/ve), or the key itself (neither).
          const name = args.includes('/ve')
            ? '(Default)'
            : args.includes('/v')
              ? args[args.indexOf('/v') + 1]
              : null
          const keyLower = key.toLowerCase()
          const under = (k: string): boolean =>
            k === keyLower || k.startsWith(`${keyLower}\\`) || k.startsWith(`${keyLower}|`)
          if (verb === 'query') {
            const exists =
              [...keys].some(under) || [...registry.keys()].some((k) => under(k.toLowerCase()))
            const line = (n: string, v: { type: string; data: string | number }): string =>
              `    ${n}    ${v.type}    ${typeof v.data === 'number' ? `0x${v.data.toString(16)}` : v.data}`
            if (name === null) {
              if (!exists) return notFound
              // Like reg.exe: the key's own values (an unset default is left out), not its subkeys'.
              const own = [...registry.entries()]
                .filter(([k]) => k.startsWith(`${keyLower}|`))
                .map(([k, v]) =>
                  line(
                    k.slice(keyLower.length + 1) === '(default)'
                      ? '(Default)'
                      : k.slice(keyLower.length + 1),
                    v
                  )
                )
              return ok(`\r\n${key}\r\n${own.map((l) => `${l}\r\n`).join('')}\r\n`)
            }
            const v = registry.get(regKey(key, name))
            if (!v) {
              // reg.exe answers an existing key's unset default with placeholder text, not an error.
              if (name === '(Default)' && exists)
                return ok(`\r\n${key}\r\n    (Default)    REG_SZ    (value not set)\r\n\r\n`)
              return notFound
            }
            return ok(`\r\n${key}\r\n${line(name, v)}\r\n\r\n`)
          }
          if (verb === 'add') {
            keys.add(keyLower)
            if (name !== null) {
              const type = args.includes('/t') ? args[args.indexOf('/t') + 1] : 'REG_SZ'
              const raw = args.includes('/d') ? args[args.indexOf('/d') + 1] : ''
              registry.set(regKey(key, name), {
                type,
                data: type === 'REG_DWORD' ? Number(raw) : raw
              })
            }
            return ok('The operation completed successfully.\r\n')
          }
          if (verb === 'delete') {
            if (name !== null) {
              if (!registry.delete(regKey(key, name))) return notFound
              return ok('The operation completed successfully.\r\n')
            }
            const had =
              [...keys].some(under) || [...registry.keys()].some((k) => under(k.toLowerCase()))
            for (const k of [...keys]) if (under(k)) keys.delete(k)
            for (const k of [...registry.keys()]) if (under(k.toLowerCase())) registry.delete(k)
            return had ? ok('The operation completed successfully.\r\n') : notFound
          }
        }
        return { code: null, stdout: '', stderr: `unknown command ${file}` }
      },
      async readFile(path) {
        return files.get(norm(path)) ?? null
      },
      async writeFile(path, data) {
        files.set(norm(path), Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'))
      },
      async rename(from, to) {
        const b = files.get(norm(from))
        if (!b) throw new Error(`ENOENT ${from}`)
        files.delete(norm(from))
        files.set(norm(to), b)
      },
      async copyFile(from, to) {
        const b = files.get(norm(from))
        if (!b) throw new Error(`ENOENT ${from}`)
        files.set(norm(to), Buffer.from(b))
      },
      async mkdir() {
        // Folders are implied by the paths in `files`.
      },
      async exists(path) {
        return files.has(norm(path))
      },
      spawnDetached(file, args) {
        spawned.push({ file, args })
        if (args.includes('-shutdown') && processes.has('steam.exe')) exitIn = fake.steamExitAfter
        if (args.includes('-silent')) processes.add('steam.exe')
      },
      async sleep() {
        fake.sleeps++
        if (exitIn !== null && --exitIn <= 0) {
          exitIn = null
          fake.onSteamExit?.()
          processes.delete('steam.exe')
        }
      },
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
    }
  }
  return fake
}

const quiet = (): void => undefined
export const silentLog = { debug: quiet, info: quiet, warn: quiet, error: quiet }
