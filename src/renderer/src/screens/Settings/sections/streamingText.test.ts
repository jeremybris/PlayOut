import type { PairedHost } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  countdown,
  hostLine,
  lockedLine,
  pinInput,
  portForwardingLine,
  toolLine
} from './streamingText'

const NOW = Date.parse('2026-11-07T12:00:00.000Z')

describe('Settings > Streaming status lines', () => {
  it('describes a helper program in each state', () => {
    expect(toolLine(undefined, 'Sunshine', 'x')).toBe('Checking…')
    expect(toolLine({ state: 'missing' }, 'Sunshine', 'Downloads later.')).toBe('Downloads later.')
    expect(toolLine({ state: 'downloading', percent: 41.6 }, 'Sunshine', '')).toBe(
      'Downloading Sunshine… 42%'
    )
    expect(toolLine({ state: 'downloading' }, 'Moonlight', '')).toBe('Downloading Moonlight…')
    expect(toolLine({ state: 'running', version: 'v2026.914.233613' }, 'Sunshine', '')).toBe(
      'Sunshine 2026.914.233613 is running'
    )
    expect(toolLine({ state: 'installed', version: 'v6.2.0' }, 'Moonlight', '')).toBe(
      'Moonlight 6.2.0 is ready'
    )
    expect(toolLine({ state: 'error', error: 'Port 47989 is in use' }, 'Sunshine', '')).toBe(
      'Port 47989 is in use'
    )
  })

  it('says whether other networks can reach this PC', () => {
    expect(portForwardingLine({ state: 'checking' })).toBe('Checking…')
    expect(portForwardingLine({ state: 'mapped', externalIp: '203.0.113.42' })).toBe(
      'Reachable over the internet at 203.0.113.42'
    )
    expect(portForwardingLine({ state: 'unavailable' })).toBe(
      'Not available on this network: only computers on the same network can connect'
    )
    expect(
      portForwardingLine({ state: 'unavailable', error: 'This network is behind another router' })
    ).toBe('This network is behind another router: only computers on the same network can connect')
    // No automatic forwarding, but the internet address is known: which ports to forward by hand.
    expect(portForwardingLine({ state: 'unavailable', externalIp: '203.0.113.42' }, 47900)).toBe(
      "This router does not forward ports automatically. To connect from another network, forward TCP port 47900 to this PC on your router (to stream too: TCP 47984, 47989 and 48010, UDP 47998 to 48000). This PC's internet address is 203.0.113.42."
    )
    expect(
      portForwardingLine({
        state: 'mapped',
        externalIp: '203.0.113.42',
        error: 'Streaming ports could not be forwarded'
      })
    ).toBe('Reachable over the internet at 203.0.113.42. Streaming ports could not be forwarded')
  })

  it('counts the PIN down and the lock-out', () => {
    expect(countdown(new Date(NOW + 299_400).toISOString(), NOW)).toBe('5:00')
    expect(countdown(new Date(NOW + 61_000).toISOString(), NOW)).toBe('1:01')
    expect(countdown(new Date(NOW - 5_000).toISOString(), NOW)).toBe('0:00')
    expect(lockedLine(undefined, NOW)).toBeNull()
    expect(lockedLine(new Date(NOW - 1).toISOString(), NOW)).toBeNull()
    expect(lockedLine(new Date(NOW + 9.5 * 60_000).toISOString(), NOW)).toBe(
      'Too many wrong PINs. Pairing is locked for 10 more minutes.'
    )
    expect(lockedLine(new Date(NOW + 10_000).toISOString(), NOW)).toBe(
      'Too many wrong PINs. Pairing is locked for 1 more minute.'
    )
  })

  it('describes a paired host online and offline', () => {
    const host: PairedHost = {
      id: 'h',
      name: 'Living Room PC',
      pairedAt: '2026-10-01T00:00:00.000Z',
      online: true,
      lanAddress: '192.168.1.20',
      port: 47900,
      games: 12
    }
    expect(hostLine(host)).toBe('12 games · 192.168.1.20')
    expect(
      hostLine(
        { ...host, online: false, lastSeen: '2026-11-06T10:00:00.000Z' },
        new Date('2026-11-07T10:00:00.000Z')
      )
    ).toBe('Offline · last seen yesterday')
    expect(hostLine({ ...host, online: false, error: 'Certificate changed' })).toBe(
      'Certificate changed'
    )
    // Online with a problem left (the background Moonlight pairing failed): still shown.
    expect(
      hostLine({ ...host, error: 'Streaming not paired yet: it is retried when you stream' })
    ).toBe('12 games · 192.168.1.20 · Streaming not paired yet: it is retried when you stream')
  })

  it('keeps 4 digits of a typed PIN', () => {
    expect(pinInput('12a3-45')).toBe('1234')
    expect(pinInput('')).toBe('')
  })
})
