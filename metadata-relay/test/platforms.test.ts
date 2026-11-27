// The platforms the relay takes rows for must be exactly 'pc' and the systems PlayOut scans ROMs for: a system PlayOut
// gains must be added here too, or its games are refused.
import { describe, expect, it } from 'vitest'
import { DB_PLATFORMS } from '../src/platforms'
import catalog from '../../resources/systems/systems.json'

describe('DB_PLATFORMS', () => {
  it("is 'pc' and every system of PlayOut's resources/systems/systems.json", () => {
    const systems = (catalog as unknown as { systems: { id: string }[] }).systems.map((s) => s.id)
    expect([...DB_PLATFORMS].sort()).toEqual([...new Set(['pc', ...systems])].sort())
  })
})
