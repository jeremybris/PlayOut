import { describe, expect, it } from 'vitest'
import { parseVdf, vdfGet } from '../util/vdf'
import {
  decodeVdf,
  detectEol,
  encodeVdf,
  findVdfKey,
  removeVdfKey,
  removeVdfKeyAt,
  setVdfKey,
  setVdfKeyAt
} from './steam-vdf'

const KEY = 'Controller_CheckGuideButton'
const CONFIG_PATH = ['InstallConfigStore', 'Software', 'Valve', 'Steam']
const LOCAL_PATH = ['UserLocalConfigStore']

// Shaped like the real <Steam>\config\config.vdf (LF, tabs, no BOM).
const CONFIG = [
  '"InstallConfigStore"',
  '{',
  '\t"Software"',
  '\t{',
  '\t\t"Valve"',
  '\t\t{',
  '\t\t\t"Steam"',
  '\t\t\t{',
  '\t\t\t\t"AutoUpdateWindowEnabled"\t\t"0"',
  '\t\t\t\t"ShaderCacheManager"',
  '\t\t\t\t{',
  '\t\t\t\t\t"HasCurrentBucket"\t\t"1"',
  '\t\t\t\t}',
  '\t\t\t\t"SDL_GamepadBind"\t\t"03000000,X360 Controller,a:b0,b:b1"',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '\t"Music"',
  '\t{',
  '\t\t"Volume"\t\t"0.5"',
  '\t}',
  '}',
  ''
].join('\n')

const LOCAL = [
  '"UserLocalConfigStore"',
  '{',
  '\t"Broadcast"',
  '\t{',
  '\t\t"Permissions"\t\t"1"',
  '\t}',
  '\t"system"',
  '\t{',
  '\t\t"EnableGameOverlay"\t\t"1"',
  '\t}',
  '}',
  ''
].join('\n')

describe('findVdfKey', () => {
  it('finds a key at any depth, without case', () => {
    const text = CONFIG.replace(
      '"HasCurrentBucket"\t\t"1"',
      '"HasCurrentBucket"\t\t"1"\n\t\t\t\t\t"controller_checkguidebutton"\t\t"1"'
    )
    const hits = findVdfKey(text, KEY)
    expect(hits).toHaveLength(1)
    expect(hits[0].path).toEqual([
      'InstallConfigStore',
      'Software',
      'Valve',
      'Steam',
      'ShaderCacheManager'
    ])
    expect(hits[0].value).toBe('1')
  })

  it('does not mistake a block name or a value for the key', () => {
    const text =
      '"Root"\n{\n\t"Controller_CheckGuideButton"\n\t{\n\t}\n\t"x"\t\t"Controller_CheckGuideButton"\n}\n'
    expect(findVdfKey(text, KEY)).toEqual([])
  })

  it('skips comments, conditionals, escaped quotes and unquoted tokens', () => {
    const text = [
      '// "Controller_CheckGuideButton" "1"',
      '"Root"',
      '{',
      '\t"Name"\t\t"say \\"hi\\" {not a block}"',
      '\t"Controller_CheckGuideButton"\t\t"1" [$WIN32]',
      '\tBare\tvalue',
      '}'
    ].join('\n')
    const hits = findVdfKey(text, KEY)
    expect(hits).toHaveLength(1)
    expect(hits[0].path).toEqual(['Root'])
  })

  it('throws on something that is not KeyValues', () => {
    expect(() => findVdfKey('"Root"\n{\n\t"a"\t"b"\n', KEY)).toThrow(SyntaxError)
    expect(() => findVdfKey('"Root"\n{\n\t"a\n}', KEY)).toThrow(SyntaxError)
    expect(() => findVdfKey('}', KEY)).toThrow(SyntaxError)
  })
})

describe('setVdfKey', () => {
  it('adds the key to config.vdf under InstallConfigStore > Software > Valve > Steam', () => {
    const r = setVdfKey(CONFIG, KEY, '0', CONFIG_PATH)
    expect(r.changed).toBe(true)
    expect(r.previous).toBeNull()
    expect(r.text).toBe(
      CONFIG.replace(
        '\t\t\t"Steam"\n\t\t\t{\n',
        '\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"Controller_CheckGuideButton"\t\t"0"\n'
      )
    )
    const parsed = parseVdf(r.text)
    expect(String(vdfGet(parsed, ...CONFIG_PATH, KEY))).toBe('0')
    // Everything else as it was.
    expect(String(vdfGet(parsed, ...CONFIG_PATH, 'ShaderCacheManager', 'HasCurrentBucket'))).toBe(
      '1'
    )
  })

  it('adds the key to localconfig.vdf directly under UserLocalConfigStore', () => {
    const r = setVdfKey(LOCAL, KEY, '0', LOCAL_PATH)
    expect(
      r.text.startsWith(
        '"UserLocalConfigStore"\n{\n\t"Controller_CheckGuideButton"\t\t"0"\n\t"Broadcast"'
      )
    ).toBe(true)
    expect(String(vdfGet(parseVdf(r.text), 'UserLocalConfigStore', KEY))).toBe('0')
  })

  it('matches the insert path without case', () => {
    const r = setVdfKey(LOCAL, KEY, '0', ['userlocalconfigstore'])
    expect(String(vdfGet(parseVdf(r.text), 'UserLocalConfigStore', KEY))).toBe('0')
  })

  it('replaces the value wherever the key already is, and nothing else', () => {
    const text = CONFIG.replace(
      '"AutoUpdateWindowEnabled"\t\t"0"',
      '"AutoUpdateWindowEnabled"\t\t"0"\n\t\t\t\t"CONTROLLER_CheckGuideButton"\t\t"1"'
    )
    const r = setVdfKey(text, KEY, '0', CONFIG_PATH)
    expect(r.previous).toBe('1')
    expect(r.changed).toBe(true)
    expect(r.text).toBe(
      text.replace('"CONTROLLER_CheckGuideButton"\t\t"1"', '"CONTROLLER_CheckGuideButton"\t\t"0"')
    )
  })

  it('changes every occurrence (one per file section)', () => {
    const text = LOCAL.replace(
      '"Permissions"\t\t"1"',
      '"Permissions"\t\t"1"\n\t\t"Controller_CheckGuideButton"\t\t"1"'
    ).replace(
      '"EnableGameOverlay"\t\t"1"',
      '"EnableGameOverlay"\t\t"1"\n\t\t"Controller_CheckGuideButton"\t\t"1"'
    )
    const r = setVdfKey(text, KEY, '0', LOCAL_PATH)
    expect(findVdfKey(r.text, KEY).map((e) => e.value)).toEqual(['0', '0'])
  })

  it('reports no change when the value is already set', () => {
    const once = setVdfKey(LOCAL, KEY, '0', LOCAL_PATH).text
    const again = setVdfKey(once, KEY, '0', LOCAL_PATH)
    expect(again.changed).toBe(false)
    expect(again.previous).toBe('0')
    expect(again.text).toBe(once)
  })

  it('keeps CRLF line endings', () => {
    const crlf = CONFIG.replace(/\n/g, '\r\n')
    expect(detectEol(crlf)).toBe('\r\n')
    const r = setVdfKey(crlf, KEY, '0', CONFIG_PATH)
    expect(r.text).not.toMatch(/[^\r]\n/)
    expect(r.text).toContain(
      '\t\t\t{\r\n\t\t\t\t"Controller_CheckGuideButton"\t\t"0"\r\n\t\t\t\t"AutoUpdate'
    )
  })

  it('creates the blocks missing along the path', () => {
    const text = '"InstallConfigStore"\n{\n\t"Music"\n\t{\n\t}\n}\n'
    const r = setVdfKey(text, KEY, '0', CONFIG_PATH)
    expect(String(vdfGet(parseVdf(r.text), ...CONFIG_PATH, KEY))).toBe('0')
    expect(r.text).toBe(
      [
        '"InstallConfigStore"',
        '{',
        '\t"Software"',
        '\t{',
        '\t\t"Valve"',
        '\t\t{',
        '\t\t\t"Steam"',
        '\t\t\t{',
        '\t\t\t\t"Controller_CheckGuideButton"\t\t"0"',
        '\t\t\t}',
        '\t\t}',
        '\t}',
        '\t"Music"',
        '\t{',
        '\t}',
        '}',
        ''
      ].join('\n')
    )
  })

  it('refuses a file without the root block', () => {
    expect(() => setVdfKey('"Other"\n{\n}\n', KEY, '0', LOCAL_PATH)).toThrow(/not found/)
  })

  it('escapes quotes and backslashes in a value', () => {
    const r = setVdfKey(LOCAL, 'Path', 'C:\\a "b"', LOCAL_PATH)
    expect(findVdfKey(r.text, 'Path')[0].value).toBe('C:\\a "b"')
  })
})

describe('removeVdfKey', () => {
  it('removes the whole line, so set-then-remove gives the file back', () => {
    for (const base of [CONFIG, CONFIG.replace(/\n/g, '\r\n')]) {
      const added = setVdfKey(base, KEY, '0', CONFIG_PATH).text
      const r = removeVdfKey(added, KEY)
      expect(r.changed).toBe(true)
      expect(r.text).toBe(base)
    }
  })

  it('removes a trailing conditional with the entry', () => {
    const text = '"Root"\n{\n\t"Controller_CheckGuideButton"\t\t"0" [$WIN32]\n\t"a"\t\t"b"\n}\n'
    expect(removeVdfKey(text, KEY).text).toBe('"Root"\n{\n\t"a"\t\t"b"\n}\n')
  })

  it('removes only the tokens when the entry shares its line', () => {
    const text = '"Root" { "a" "b" "Controller_CheckGuideButton" "0" "c" "d" }'
    const r = removeVdfKey(text, KEY)
    expect(findVdfKey(r.text, KEY)).toEqual([])
    expect(findVdfKey(r.text, 'c')[0].value).toBe('d')
  })

  it('reports no change when absent', () => {
    expect(removeVdfKey(LOCAL, KEY)).toEqual({ text: LOCAL, changed: false })
  })
})

describe('decodeVdf / encodeVdf', () => {
  it('keeps a BOM, and keeps its absence', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LOCAL, 'utf8')])
    const d = decodeVdf(withBom)
    expect(d.bom).toBe(true)
    expect(d.text).toBe(LOCAL)
    expect(encodeVdf(d.text, d.bom).equals(withBom)).toBe(true)

    const plain = Buffer.from(LOCAL, 'utf8')
    expect(decodeVdf(plain).bom).toBe(false)
    expect(encodeVdf(LOCAL, false).equals(plain)).toBe(true)
  })

  it('round-trips non-ASCII text untouched through an edit', () => {
    const text = LOCAL.replace('"Permissions"\t\t"1"', '"Name"\t\t"Café ✓ 日本"')
    const buf = encodeVdf(text, true)
    const d = decodeVdf(buf)
    const edited = setVdfKey(d.text, KEY, '0', LOCAL_PATH).text
    const back = removeVdfKey(edited, KEY).text
    expect(encodeVdf(back, d.bom).equals(buf)).toBe(true)
  })
})

describe('block-scoped edits', () => {
  const TEXT = [
    '"AppState"',
    '{',
    '\t"UserConfig"',
    '\t{',
    '\t\t"DisabledDLC"\t\t"1"',
    '\t}',
    '\t"MountedConfig"',
    '\t{',
    '\t\t"DisabledDLC"\t\t"1"',
    '\t}',
    '}',
    ''
  ].join('\n')

  it('setVdfKeyAt changes the key in that block only', () => {
    const r = setVdfKeyAt(TEXT, ['appstate', 'userconfig'], 'disableddlc', '2')
    expect(r).toEqual({
      text: TEXT.replace('"DisabledDLC"\t\t"1"', '"DisabledDLC"\t\t"2"'),
      changed: true,
      previous: '1'
    })
  })

  it('setVdfKeyAt adds the key to its block even when another block has it', () => {
    const without = removeVdfKeyAt(TEXT, ['AppState', 'UserConfig'], 'DisabledDLC')
    expect(without.changed).toBe(true)
    expect(findVdfKey(without.text, 'DisabledDLC').map((e) => e.path)).toEqual([
      ['AppState', 'MountedConfig']
    ])
    const back = setVdfKeyAt(without.text, ['AppState', 'UserConfig'], 'DisabledDLC', '1')
    expect(back.text).toBe(TEXT)
  })

  it('removeVdfKeyAt reports no change when the block has no such key', () => {
    expect(removeVdfKeyAt(TEXT, ['AppState', 'Other'], 'DisabledDLC')).toEqual({
      text: TEXT,
      changed: false
    })
  })
})
