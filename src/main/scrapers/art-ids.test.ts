import { describe, expect, it } from 'vitest'
import { artIdsOf } from './art-ids'
import { fakeGame } from './test-helpers'

describe('artIdsOf for ROMs', () => {
  it('names the sub-folder a ROM is sorted into, and none for a ROM at the top of its system folder', () => {
    const nested = artIdsOf({
      ...fakeGame('rom', 'ps2/Favorites 1/Okami (USA).iso'),
      platformId: 'ps2'
    })
    expect(nested).toMatchObject({
      romSystemId: 'ps2',
      romName: 'Okami (USA)',
      romRelDir: 'Favorites 1'
    })
    const deeper = artIdsOf({ ...fakeGame('rom', 'ps2\\A\\B\\Ico.iso'), platformId: 'ps2' })
    expect(deeper.romRelDir).toBe('A/B')
    const flat = artIdsOf({ ...fakeGame('rom', 'ps2/Ico.iso'), platformId: 'ps2' })
    expect(flat.romRelDir).toBeUndefined()
  })
})
