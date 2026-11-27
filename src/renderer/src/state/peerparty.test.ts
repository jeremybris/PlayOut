import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({
  api: { on: () => () => undefined, peerPartySession: async () => null },
  isMock: false
}))

const { peerPartyBusy, peerPartyProgressText, peerPartyTitle } = await import('./peerparty')

describe('PeerParty square text', () => {
  it('says how far a download or start got', () => {
    expect(peerPartyProgressText({ gameId: 'g', phase: 'downloading', percent: 41.6 })).toBe(
      'Downloading PeerParty… 42%'
    )
    expect(peerPartyProgressText({ gameId: 'g', phase: 'downloading' })).toBe(
      'Downloading PeerParty…'
    )
    expect(peerPartyProgressText({ gameId: 'g', phase: 'checking' })).toBe('Checking PeerParty…')
    expect(peerPartyProgressText({ gameId: 'g', phase: 'verifying' })).toBe('Checking PeerParty…')
    expect(peerPartyProgressText({ gameId: 'g', phase: 'starting' })).toBe(
      'Starting with PeerParty…'
    )
  })

  it('names the services found in its tooltip', () => {
    expect(peerPartyTitle({ services: ['steamworks', 'eos'] })).toBe(
      'PeerParty: LAN play (Steamworks, Epic Online Services)'
    )
    expect(peerPartyTitle({ services: [] })).toBe('PeerParty: LAN play')
  })

  it('counts only an unfinished progress as busy', () => {
    expect(peerPartyBusy(null)).toBe(false)
    expect(peerPartyBusy({ gameId: 'g', phase: 'done' })).toBe(false)
    expect(peerPartyBusy({ gameId: 'g', phase: 'failed' })).toBe(false)
    expect(peerPartyBusy({ gameId: null, phase: 'downloading' })).toBe(true)
  })
})
