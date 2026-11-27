import { describe, expect, it } from 'vitest'
import {
  handlerFileName,
  parseHandlerScript,
  parseLiteral,
  readAssignments,
  stripComments
} from './handler-script'

const BL2 = `Hub.Handler.Version = 13; // Released at https://hub.splitscreen.me/ on 2021
Hub.Handler.Id = "YztSFvxEtWgjuGwTT";
Game.GameName = "Borderlands 2";
Game.ExecutableName = "Borderlands2.exe";
Game.SteamID = "49520";
Game.GUID = "Borderlands 2";
Game.MaxPlayers = 4;
Game.MaxPlayersOneMonitor = 4;
Game.BinariesFolder = "Binaries\\\\Win32";
Game.SupportsKeyboard = true;
/* Game.UseEACBypass = true; */
// Game.UseSteamless = true;
Game.Play = function () {
  Game.ExecutableName = "Other.exe";
  var savePath = Context.GetFolder(Nucleus.Folder.Documents) + "\\\\My Games";
};
`

describe('parseLiteral', () => {
  it('reads strings, numbers, booleans and arrays', () => {
    expect(parseLiteral('"a \\"b\\""')).toBe('a "b"')
    expect(parseLiteral("'x'")).toBe('x')
    expect(parseLiteral('42')).toBe(42)
    expect(parseLiteral('true')).toBe(true)
    expect(parseLiteral('["a.exe", "b.exe"]')).toEqual(['a.exe', 'b.exe'])
    expect(parseLiteral('["false", "--quiet", "2500"]')).toEqual(['false', '--quiet', '2500'])
    expect(parseLiteral('Context.Width')).toBeUndefined()
  })
})

describe('stripComments', () => {
  it('drops comments but keeps // inside strings and the line count', () => {
    const out = stripComments('a = "https://x"; // gone\n/* x\ny */b = 1')
    expect(out).toContain('"https://x"')
    expect(out).not.toContain('gone')
    expect(out.split('\n')).toHaveLength(3)
  })

  it('keeps // and quotes inside regex literals', () => {
    const out = stripComments(
      'a = s.replace(/"/g, ""); // gone\nb = /[//]x/.test(s) // gone\nc = 1'
    )
    expect(out).toContain('s.replace(/"/g, "");')
    expect(out).toContain('/[//]x/.test(s)')
    expect(out).not.toContain('gone')
    expect(out).toContain('c = 1')
    // A division is not a regex: the comment after it still goes.
    expect(stripComments('a = b / 2 // gone\nc = d / 2')).toBe('a = b / 2 \nc = d / 2')
  })
})

describe('readAssignments', () => {
  it('keeps top-level assignments only, the first of each', () => {
    const a = readAssignments(BL2)
    expect(a.get('ExecutableName')).toBe('Borderlands2.exe')
    expect(a.get('Hub.Id')).toBe('YztSFvxEtWgjuGwTT')
    expect(a.has('UseEACBypass')).toBe(false)
    expect(a.has('UseSteamless')).toBe(false)
  })

  it('reads arrays across lines', () => {
    const a = readAssignments(
      'Game.GameName = "X";\nGame.ExecutableNames = [\n  "a.exe",\n  "b.exe"\n];\n'
    )
    expect(a.get('ExecutableNames')).toEqual(['a.exe', 'b.exe'])
  })

  it('does not count braces inside string literals', () => {
    const a = readAssignments(
      [
        'Game.GameName = "X";',
        'Game.Description = "Press { to open the menu";',
        "Game.StartArguments = '-profile \\'{0';",
        'Game.ExecutableName = "x.exe";',
        'Game.SteamID = "480";',
        'Game.Play = function () {',
        '  var s = "}";',
        '  Game.MaxPlayers = 2;',
        '};',
        'Game.MaxPlayers = 4;'
      ].join('\n')
    )
    expect(a.get('ExecutableName')).toBe('x.exe')
    expect(a.get('SteamID')).toBe('480')
    // A closing brace in a string does not end the function body either.
    expect(a.get('MaxPlayers')).toBe(4)
  })

  it('does not take a quote inside a regex literal for the start of a string', () => {
    // The { after the regex must count, or the inner } would end the function body early.
    const open = readAssignments(
      [
        'Game.Play = function () {',
        '  if (/["\']/.test(Context.Nickname)) {',
        '    Context.Nickname = "p";',
        '  }',
        '  Game.SteamID = "999";',
        '};',
        'Game.SteamID = "480";'
      ].join('\n')
    )
    expect(open.get('SteamID')).toBe('480')
    // The } after the regex must count, or every later top-level field would be hidden.
    const close = readAssignments(
      [
        'Game.Play = function () {',
        '  var q = s.replace(/"/g, ""); }',
        'Game.SteamID = "480";'
      ].join('\n')
    )
    expect(close.get('SteamID')).toBe('480')
  })

  it('does not count braces or slashes inside a regex literal', () => {
    const a = readAssignments(
      [
        'Game.Play = function () {',
        '  var a = s.replace(/[/"{]/g, "").split(/\\/\\/{/);',
        '  return /}}"/.test(a) ? 1 : 2;',
        '};',
        'Game.SteamID = "480";'
      ].join('\n')
    )
    expect(a.get('SteamID')).toBe('480')
  })

  it('still reads a division as a division', () => {
    const a = readAssignments(
      [
        'Game.Play = function () {',
        '  var half = Context.Width / 2; var s = "{"; var t = (half) / 2 + i++ / 2; var u = "/";',
        '};',
        'Game.SteamID = "480";'
      ].join('\n')
    )
    expect(a.get('SteamID')).toBe('480')
  })
})

describe('parseHandlerScript', () => {
  it('reads the identity and needs of a handler', () => {
    expect(parseHandlerScript(BL2)).toMatchObject({
      gameName: 'Borderlands 2',
      exeName: 'Borderlands2.exe',
      exeNames: [],
      steamId: '49520',
      guid: 'Borderlands 2',
      binariesFolder: 'Binaries\\Win32',
      maxPlayers: 4,
      supportsKeyboard: true,
      supportsMultipleKeyboardsAndMice: false,
      hubId: 'YztSFvxEtWgjuGwTT',
      hubVersion: 13,
      risks: []
    })
  })

  it('flags DRM-removal and anti-cheat tools', () => {
    const info = parseHandlerScript(
      'Game.GameName = "G";\nGame.UseSteamless = true;\nGame.NeedsSteamEmulation = true;\nGame.UseSteamStubDRMPatcher = true;\nGame.UseEACBypass = true;\n'
    )
    expect(info?.risks).toEqual(['steamless', 'smartsteamemu', 'steamstub', 'eac'])
    expect(
      parseHandlerScript(
        'Game.GameName = "G";\nGame.SteamlessPatch = ["false", "--quiet", "2500"];'
      )?.risks
    ).toEqual(['steamless'])
  })

  it('is null without a game name', () => {
    expect(parseHandlerScript('var x = 1;')).toBeNull()
  })
})

describe('handlerFileName', () => {
  it('drops the characters Windows file names cannot hold', () => {
    expect(handlerFileName('Call of Juarez: Bound in Blood')).toBe('Call of Juarez Bound in Blood')
    expect(handlerFileName('A/B "C" <D>?')).toBe('AB C D')
  })
})
