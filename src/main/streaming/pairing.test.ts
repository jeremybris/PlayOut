import { describe, expect, it } from 'vitest'
import {
  createPinPairing,
  hashToken,
  newPin,
  newToken,
  PairingLockedError,
  pairingProof,
  tokenMatches
} from './pairing'

const FP = 'ab'.repeat(32)

function setup(): { clock: { t: number }; pairing: ReturnType<typeof createPinPairing> } {
  const clock = { t: 1_000_000 }
  const pairing = createPinPairing({ now: () => clock.t, randomPin: () => '0420' })
  return { clock, pairing }
}

describe('pairing proof', () => {
  it('is an HMAC of the fingerprint and client id keyed by the PIN', () => {
    const a = pairingProof('1234', FP, 'client-1')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(pairingProof('1234', FP.toUpperCase(), 'client-1')).toBe(a)
    expect(pairingProof('1235', FP, 'client-1')).not.toBe(a)
    expect(pairingProof('1234', 'cd'.repeat(32), 'client-1')).not.toBe(a)
    expect(pairingProof('1234', FP, 'client-2')).not.toBe(a)
  })

  it('makes 4-digit PINs', () => {
    for (let i = 0; i < 200; i++) expect(newPin()).toMatch(/^\d{4}$/)
  })
})

describe('createPinPairing', () => {
  it('accepts the right proof once and keeps the PIN readable for Moonlight', () => {
    const { clock, pairing } = setup()
    expect(pairing.verify(pairingProof('0420', FP, 'c'), FP, 'c')).toBe('none')
    const { pin, expiresAt } = pairing.start()
    expect(pin).toBe('0420')
    expect(expiresAt).toBe(clock.t + 5 * 60_000)
    expect(pairing.current()?.pin).toBe('0420')
    expect(pairing.verify(pairingProof(pin, FP, 'c'), FP, 'c')).toBe('ok')
    expect(pairing.current()).toBeNull()
    expect(pairing.verify(pairingProof(pin, FP, 'c'), FP, 'c')).toBe('none')
    expect(pairing.lastPin()).toBe('0420')
    clock.t += 2 * 60_000
    expect(pairing.lastPin()).toBeNull()
  })

  it('refuses a proof made for another certificate or client', () => {
    const { pairing } = setup()
    pairing.start()
    expect(pairing.verify(pairingProof('0420', 'cd'.repeat(32), 'c'), FP, 'c')).toBe('wrong')
    expect(pairing.verify(pairingProof('0420', FP, 'other'), FP, 'c')).toBe('wrong')
    expect(pairing.verify('not hex', FP, 'c')).toBe('wrong')
  })

  it('expires the PIN', () => {
    const { clock, pairing } = setup()
    pairing.start()
    clock.t += 5 * 60_000
    expect(pairing.verify(pairingProof('0420', FP, 'c'), FP, 'c')).toBe('expired')
    expect(pairing.current()).toBeNull()
  })

  it('locks out an address after five wrong PINs, without locking anyone else out', () => {
    const { clock, pairing } = setup()
    pairing.start()
    const bad = pairingProof('9999', FP, 'c')
    for (let i = 0; i < 5; i++) expect(pairing.verify(bad, FP, 'c', '203.0.113.9')).toBe('wrong')
    // Even the right PIN is refused from there now...
    expect(pairing.verify(pairingProof('0420', FP, 'c'), FP, 'c', '203.0.113.9')).toBe('locked')
    // ...but pairing stays open for everyone else, with the same PIN.
    expect(pairing.lockedUntil()).toBeNull()
    expect(pairing.current()?.pin).toBe('0420')
    expect(pairing.verify(pairingProof('0420', FP, 'c'), FP, 'c', '192.168.1.20')).toBe('ok')
    // The address's lock ends after ten minutes.
    pairing.start()
    clock.t += 10 * 60_000
    pairing.start()
    expect(pairing.verify(pairingProof('0420', FP, 'c'), FP, 'c', '203.0.113.9')).toBe('ok')
  })

  it('locks for everyone after twenty wrong PINs in all, for ten minutes, and drops the PIN', () => {
    const { clock, pairing } = setup()
    pairing.start()
    const bad = pairingProof('9999', FP, 'c')
    for (let i = 0; i < 19; i++)
      expect(pairing.verify(bad, FP, 'c', `198.51.100.${Math.floor(i / 4)}`)).toBe('wrong')
    expect(pairing.lockedUntil()).toBeNull()
    expect(pairing.verify(bad, FP, 'c', '198.51.100.9')).toBe('wrong')
    expect(pairing.lockedUntil()).toBe(clock.t + 10 * 60_000)
    expect(pairing.verify(pairingProof('0420', FP, 'c'), FP, 'c', '192.168.1.20')).toBe('locked')
    expect(pairing.current()).toBeNull()
    expect(() => pairing.start()).toThrow(PairingLockedError)
    clock.t += 10 * 60_000
    expect(pairing.lockedUntil()).toBeNull()
    pairing.start()
    // The counts started over with the lock's end.
    for (let i = 0; i < 4; i++) pairing.verify(bad, FP, 'c', '198.51.100.0')
    expect(pairing.lockedUntil()).toBeNull()
    expect(pairing.verify(pairingProof('0420', FP, 'c'), FP, 'c', '198.51.100.0')).toBe('ok')
  })

  it('cancel() ends the pairing window', () => {
    const { pairing } = setup()
    pairing.start()
    pairing.cancel()
    expect(pairing.verify(pairingProof('0420', FP, 'c'), FP, 'c')).toBe('none')
  })
})

describe('tokens', () => {
  it('stores only a hash and compares it', () => {
    const token = newToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const hash = hashToken(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenMatches(token, hash)).toBe(true)
    expect(tokenMatches(newToken(), hash)).toBe(false)
    expect(tokenMatches('', hash)).toBe(false)
    expect(tokenMatches(token, 'zz')).toBe(false)
  })
})
