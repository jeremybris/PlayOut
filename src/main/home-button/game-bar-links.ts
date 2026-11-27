import { regDeleteValue, regQuery, type RunCommand } from './io'

/**
 * Xbox Game Bar's links (ms-gamebar:, ms-gamingoverlay:): Windows, Win+G and other programs open Game Bar through
 * them, among them launchers that read the Guide button themselves (Winhanced opens Game Bar this way). While the
 * home button keeps Game Bar off, each link is pointed at a program that does nothing (systray.exe, which exits at
 * once), in the user's own HKCU\Software\Classes (no admin). What was there before is recorded and put back.
 */

export const GAME_BAR_LINKS = ['ms-gamebar', 'ms-gamingoverlay'] as const

/**
 * What one link's key held before PlayOut changed it. The optional fields were added later: a record without them
 * (written by 0.1.88's first build) is treated as "it was there", so a restore never removes what it cannot prove
 * PlayOut added.
 */
export interface GameBarLinkRecord {
  /** The link's HKCU key existed. */
  keyExisted: boolean
  /** Its shell subkey existed. */
  shellExisted: boolean
  /** Its shell\open subkey existed. */
  openExisted?: boolean
  /** Its shell\open\command subkey existed. */
  commandKeyExisted?: boolean
  /** The open command (shell\open\command's default value) before; null when there was none. */
  command: string | null
  /** That command's value type (REG_SZ or REG_EXPAND_SZ). */
  commandType?: string | null
  /** The link's key had a default value of its own. */
  keyDefault?: boolean
  /** Its "URL Protocol" value before; null when there was none. */
  urlProtocol?: string | null
  /** The NoOpenWith value existed. */
  noOpenWith: boolean
}

export const linkKey = (link: string): string => `HKCU\\Software\\Classes\\${link}`

/** The command that opens nothing. */
export function noOpCommand(systemRoot = process.env.SystemRoot ?? 'C:\\Windows'): string {
  return `"${systemRoot}\\System32\\systray.exe"`
}

const done = (r: { code: number | null; stdout: string; stderr: string }, what: string): void => {
  if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim()}`)
}

const linesOf = (stdout: string): string[] => stdout.replace(/\r/g, '').split('\n')

/**
 * Whether a reg.exe query found nothing (exit 1). Any other failure (a timeout, access denied) throws, so a reading
 * that failed is never taken for "absent" and recorded as an original.
 */
function absent(r: { code: number | null; stdout: string; stderr: string }): boolean {
  if (r.code === 0) return false
  if (r.code === 1) return true
  throw new Error(`reg query failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`)
}

export async function regKeyExists(run: RunCommand, key: string): Promise<boolean> {
  return !absent(await run('reg.exe', ['query', key]))
}

/** A key's default value with its type; null when it has none (or the key does not exist). */
export async function regDefaultValue(
  run: RunCommand,
  key: string
): Promise<{ type: string; data: string } | null> {
  const r = await run('reg.exe', ['query', key, '/ve'])
  if (absent(r)) return null
  // `    (Default)    REG_SZ    value` (the name is translated on other languages: the type marks the line).
  const line = linesOf(r.stdout).find((l) => /\sREG_[A-Z_]+/.test(l))
  if (!line) return null
  const m = /\s(REG_[A-Z_]+)(?:[ \t]+(.*))?$/.exec(line)
  if (!m || m[1] === 'REG_NONE') return null
  // reg.exe answers an unset default with placeholder text ("(value not set)", translated on other languages). An
  // unset default is left out of the key's own listing, so the value is real only when that listing has the line.
  const all = await run('reg.exe', ['query', key])
  if (absent(all) || !linesOf(all.stdout).includes(line)) return null
  return { type: m[1], data: (m[2] ?? '').trim() }
}

/** A key's default value as text; null when it has none (or the key does not exist). */
export async function regDefault(run: RunCommand, key: string): Promise<string | null> {
  return (await regDefaultValue(run, key))?.data ?? null
}

async function setDefault(
  run: RunCommand,
  key: string,
  data: string,
  type = 'REG_SZ'
): Promise<void> {
  done(await run('reg.exe', ['add', key, '/ve', '/t', type, '/d', data, '/f']), 'reg add')
}

async function setString(run: RunCommand, key: string, name: string, data: string): Promise<void> {
  done(await run('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', data, '/f']), 'reg add')
}

/** Delete a key; one already gone is fine. */
async function deleteKey(run: RunCommand, key: string): Promise<void> {
  const r = await run('reg.exe', ['delete', key, '/f'])
  if (r.code !== 0 && r.code !== 1) done(r, 'reg delete')
}

/** Delete a key's default value; one already gone is fine. */
async function deleteDefault(run: RunCommand, key: string): Promise<void> {
  const r = await run('reg.exe', ['delete', key, '/ve', '/f'])
  if (r.code !== 0 && r.code !== 1) done(r, 'reg delete')
}

/** Whether every link already opens nothing. */
export async function linksOff(run: RunCommand, command = noOpCommand()): Promise<boolean> {
  for (const link of GAME_BAR_LINKS)
    if ((await regDefault(run, `${linkKey(link)}\\shell\\open\\command`)) !== command) return false
  return true
}

/**
 * Point every link that still opens Game Bar at the no-op command. `record` is called with each link's previous
 * state before it is changed (and not for a link already off), so a crash in between never loses an original.
 */
export async function turnLinksOff(
  run: RunCommand,
  record: (link: string, before: GameBarLinkRecord) => Promise<void>,
  command = noOpCommand()
): Promise<string[]> {
  const changed: string[] = []
  for (const link of GAME_BAR_LINKS) {
    const key = linkKey(link)
    const commandKey = `${key}\\shell\\open\\command`
    const current = await regDefaultValue(run, commandKey)
    if (current?.data === command) continue
    const keyDefault = (await regDefaultValue(run, key)) !== null
    await record(link, {
      keyExisted: await regKeyExists(run, key),
      shellExisted: await regKeyExists(run, `${key}\\shell`),
      openExisted: await regKeyExists(run, `${key}\\shell\\open`),
      commandKeyExisted: await regKeyExists(run, commandKey),
      command: current?.data ?? null,
      commandType: current?.type ?? null,
      keyDefault,
      urlProtocol: (await regQuery(run, key, 'URL Protocol'))?.data?.toString() ?? null,
      noOpenWith: (await regQuery(run, key, 'NoOpenWith')) !== null
    })
    if (!keyDefault) await setDefault(run, key, `URL:${link}`)
    await setString(run, key, 'URL Protocol', '')
    await setString(run, key, 'NoOpenWith', '')
    // The command last: until it is written, the link still opens Game Bar and a restore still recognises it.
    await setDefault(run, commandKey, command)
    changed.push(link)
  }
  return changed
}

/**
 * Put each recorded link back as it was, where it still opens nothing or still has its original command (an apply
 * that stopped part way). A link changed since, by Windows or the user, is left alone.
 */
export async function restoreLinks(
  run: RunCommand,
  records: Record<string, GameBarLinkRecord>,
  command = noOpCommand()
): Promise<void> {
  for (const [link, before] of Object.entries(records)) {
    if (!(GAME_BAR_LINKS as readonly string[]).includes(link)) continue
    const key = linkKey(link)
    const commandKey = `${key}\\shell\\open\\command`
    const now = await regDefault(run, commandKey)
    if (now !== command && now !== before.command) continue
    if (!before.keyExisted) {
      await deleteKey(run, key)
      continue
    }
    // The values first and the command last: a restore that stops part way still finds the no-op and tries again.
    if (!before.noOpenWith) await regDeleteValue(run, key, 'NoOpenWith')
    if (before.urlProtocol === null) await regDeleteValue(run, key, 'URL Protocol')
    else if (before.urlProtocol !== undefined && before.urlProtocol !== '')
      await setString(run, key, 'URL Protocol', before.urlProtocol)
    if (before.keyDefault === false) await deleteDefault(run, key)
    if (!before.shellExisted) await deleteKey(run, `${key}\\shell`)
    else if (before.openExisted === false) await deleteKey(run, `${key}\\shell\\open`)
    else if (before.command !== null)
      await setDefault(run, commandKey, before.command, before.commandType ?? 'REG_SZ')
    else if (before.commandKeyExisted === false) await deleteKey(run, commandKey)
    else await deleteDefault(run, commandKey)
  }
}
