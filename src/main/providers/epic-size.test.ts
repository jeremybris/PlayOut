import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { parseEpicManifest } from './epic'

describe('parseEpicManifest InstallSize', () => {
  it('keeps a positive byte count', () => {
    expect(parseEpicManifest({ AppName: 'Min', InstallSize: 15_032_385_536 })?.InstallSize).toBe(
      15_032_385_536
    )
    expect(parseEpicManifest({ AppName: 'Min', InstallSize: 1 })?.InstallSize).toBe(1)
  })

  it('drops missing, zero, negative, non-finite and non-number sizes', () => {
    for (const InstallSize of [undefined, 0, -5, Number.NaN, Infinity, '12345', null, {}]) {
      const parsed = parseEpicManifest({ AppName: 'Min', InstallSize })
      expect(parsed).not.toBeNull()
      expect(parsed?.InstallSize).toBeUndefined()
    }
  })
})
