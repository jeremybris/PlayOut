import { describe, expect, it } from 'vitest'
import { eraIcon } from './eraIcons'
import { RELEASE_ERAS } from './releaseEras'

/** Filters > Release's era pictures (scripts/build-era-icons.ps1). */
describe('eraIcon', () => {
  it('has a picture for every era', () => {
    for (const era of RELEASE_ERAS) expect(eraIcon(era.id), era.id).toBeTruthy()
  })

  it('has none for an unknown era', () => {
    expect(eraIcon('y-1970-1980')).toBeUndefined()
    expect(eraIcon(undefined)).toBeUndefined()
  })
})
