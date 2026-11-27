import { PEERPARTY_LOCAL_TAGS, PEERPARTY_MULTIPLAYER_TAGS } from '@shared/peerparty'
import { describe, expect, it } from 'vitest'
import { LOCAL_MULTIPLAYER_TAGS } from './localMultiplayer'

describe('PeerParty multiplayer tags', () => {
  it('keeps its local tags equal to the Local Multiplayer filter’s', () => {
    expect([...PEERPARTY_LOCAL_TAGS]).toEqual([...LOCAL_MULTIPLAYER_TAGS])
  })

  it('counts every Local Multiplayer tag as multiplayer', () => {
    for (const tag of LOCAL_MULTIPLAYER_TAGS) expect(PEERPARTY_MULTIPLAYER_TAGS).toContain(tag)
  })
})
