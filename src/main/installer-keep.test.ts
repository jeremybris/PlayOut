import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { UPGRADES_FOLDER } from '../shared/upgrades'
import { VR_MODS_FOLDER } from '../shared/vr-mods'

/**
 * The installer's uninstall step (run on every update too) empties PlayOut's install folder but for the folders it
 * names (build/installer.nsh, customRemoveFiles). Every folder PlayOut downloads into beside PlayOut.exe must be
 * named there, in both loops, or an update deletes it: 0.1.148 and earlier deleted installed recompilations.
 */
const KEPT_BESIDE_EXE = [
  'Emulators',
  'Emulation',
  'Recompilations',
  VR_MODS_FOLDER,
  UPGRADES_FOLDER
]

describe('build/installer.nsh', () => {
  const nsh = readFileSync(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
  const loops = nsh.split('FindFirst $R0 $R1 "$INSTDIR\\*.*"').slice(1)

  it('has the update loop and the delete loop', () => {
    expect(loops).toHaveLength(2)
  })

  for (const folder of KEPT_BESIDE_EXE)
    it(`keeps ${folder} on update and on uninstall`, () => {
      for (const loop of loops) expect(loop).toContain(`\${AndIf} $R1 != "${folder}"`)
    })

  it('removes the install folder itself only when it is empty (a kept Emulation folder keeps it)', () => {
    expect(nsh).toMatch(/^\s*RMDir \$INSTDIR\s*$/m)
    expect(nsh).not.toMatch(/RMDir \/r "?\$INSTDIR"?\s*$/m)
  })
})

describe('electron-builder.yml', () => {
  const yml = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')

  // %APPDATA%\playout holds library.json (the favourites, with the list in the Emulation folder as their copy).
  it('never deletes PlayOut data folder on uninstall', () => {
    expect(yml).not.toMatch(/^\s*deleteAppDataOnUninstall:\s*true/m)
  })
})
