import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PeerPartyInviteResult, PeerPartyOverlayStatus } from '@shared/peerparty'

// The store as a plain object (a server render reads a zustand store's initial state only).
const { state } = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('./peerPartyStore', () => ({
  usePeerPartyOverlayStore: (select: (s: Record<string, unknown>) => unknown) => select(state)
}))

const { PeerPartyTab } = await import('./PeerPartyTab')
const { inviteText, playersText } = await import('./peerparty')

function tab(
  status: PeerPartyOverlayStatus | null,
  options: { inviting?: boolean; invite?: PeerPartyInviteResult | null } = {}
): string {
  for (const k of Object.keys(state)) delete state[k]
  Object.assign(state, {
    status,
    inviting: options.inviting ?? false,
    invite: options.invite ?? null,
    watch: () => () => undefined,
    sendInvite: async () => undefined
  })
  return renderToStaticMarkup(<PeerPartyTab />)
}

const on: PeerPartyOverlayStatus = {
  active: true,
  gameTitle: 'Spelunky 2',
  lan: 'on',
  players: 2
}

describe('PeerParty tab', () => {
  it('shows LAN play, the players and the invite (the panel header names PeerParty and the game)', () => {
    const html = tab(on)
    expect(html).not.toContain('<h3')
    expect(html).toContain('ov-peerparty__status--on')
    expect(html).toContain('LAN play is on')
    expect(html).toContain('Players of this game on your network: 2')
    expect(html).toContain('Invite everyone on the LAN')
    expect(html).toContain('Player names and invites to one player need a newer PeerParty.')
    // No names, no addresses: only the count.
    expect(html).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
  })

  it('says Starting… and LAN play is off, without a count', () => {
    const starting = tab({ active: true, gameTitle: 'Spelunky 2', lan: 'starting' })
    expect(starting).toContain('Starting…')
    expect(starting).not.toContain('Players of this game')
    const off = tab({ active: true, gameTitle: 'Spelunky 2', lan: 'off', players: 3 })
    expect(off).toContain('LAN play is off')
    expect(off).not.toContain('Players of this game')
    expect(off).toContain('Invite everyone on the LAN')
  })

  it('shows the count only when PeerParty gave one', () => {
    expect(tab({ active: true, gameTitle: 'X', lan: 'on' })).not.toContain('Players of this game')
  })

  it('says what the invite did', () => {
    expect(tab(on, { invite: { result: 'sent' } })).toContain('Invite sent')
    expect(tab(on, { invite: { result: 'none' } })).toContain('No PeerParty game took the invite')
    expect(tab(on, { invite: { result: 'error', message: 'Access is denied' } })).toContain(
      'Access is denied'
    )
    const inviting = tab(on, { inviting: true })
    expect(inviting).toContain('Inviting…')
    expect(inviting).toContain('aria-disabled="true"')
  })

  it('shows the loading and no-session states', () => {
    expect(tab(null)).toContain('Checking PeerParty…')
    const none = tab({ active: false, lan: 'off' })
    expect(none).toContain('No game runs through PeerParty now.')
    expect(none).not.toContain('Invite everyone')
  })

  it('has the words for each answer', () => {
    expect(playersText(on)).toBe('Players of this game on your network: 2')
    expect(playersText({ ...on, players: 0 })).toBeNull()
    expect(inviteText({ result: 'error' })).toBe('The invite could not be sent')
  })
})
