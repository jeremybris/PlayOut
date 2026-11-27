import { describe, expect, it } from 'vitest'
import { listFixedDrives, parseDrives } from './drives'

describe('parseDrives', () => {
  it('reads one row or many, sorted by letter, leaving out rows without a size', () => {
    expect(
      parseDrives([
        { DeviceID: 'D:', VolumeName: 'Games', Size: '2000', FreeSpace: 600 },
        { DeviceID: 'c:', VolumeName: '', Size: 1000, FreeSpace: 200 },
        { DeviceID: 'E:', Size: null, FreeSpace: 0 },
        { DeviceID: 'not a drive', Size: 5, FreeSpace: 1 }
      ])
    ).toEqual([
      { root: 'C:\\', label: null, totalBytes: 1000, freeBytes: 200 },
      { root: 'D:\\', label: 'Games', totalBytes: 2000, freeBytes: 600 }
    ])
    expect(parseDrives({ DeviceID: 'C:', Size: 10, FreeSpace: 20 })).toEqual([
      { root: 'C:\\', label: null, totalBytes: 10, freeBytes: 10 }
    ])
    expect(parseDrives(null)).toEqual([])
  })

  it('asks PowerShell for the fixed drives', async () => {
    let script = ''
    const drives = await listFixedDrives({
      run: async (s) => {
        script = s
        return [{ DeviceID: 'C:', Size: 100, FreeSpace: 40 }] as never
      }
    })
    expect(script).toContain('DriveType=3')
    expect(drives).toHaveLength(1)
  })
})
