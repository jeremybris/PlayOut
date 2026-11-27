import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { tMain } from '../i18n'

/**
 * PIN pairing between two PlayOut PCs. The host shows a one-time 4-digit PIN; the client proves it knows the PIN
 * without sending it, with an HMAC keyed by the PIN over the host certificate's fingerprint (the one the client saw)
 * and the client's id. Five wrong proofs lock out that address for ten minutes and twenty from anywhere lock pairing for
 * everyone, so the 10 000 PINs cannot be tried online (and one stranger cannot keep everyone from pairing), and
 * a machine that only watches the network learns nothing (the proof travels inside TLS).
 *
 * What this does NOT stop: a machine actively in the middle during the pairing minutes. It presents its own
 * certificate, receives the proof for that certificate, tries all 10 000 PINs offline in milliseconds and then pairs
 * with the real host in one attempt. Against that, pairing is trust-on-first-use; closing it needs a PAKE (SPAKE2 or
 * CPace with the fingerprint in the transcript), which changes the /v1/pair exchange and the service's pair handler.
 *
 * Pure apart from the crypto: the clock is injected, the service turns the numbers into status and events.
 */

export type PinVerifyResult = 'ok' | 'wrong' | 'expired' | 'locked' | 'none'

export interface PinPairingOptions {
  now?: () => number
  /** How long a PIN can be used (default 5 minutes). */
  ttlMs?: number
  /** Wrong proofs from one address before that address is locked out (default 5). */
  maxFailures?: number
  /** Wrong proofs from all addresses together before pairing locks for everyone (default 20). */
  maxTotalFailures?: number
  /** How long the lock lasts (default 10 minutes). */
  lockMs?: number
  /** How long the PIN of a successful pairing stays readable for Moonlight's pairing (default 2 minutes). */
  lastPinMs?: number
  /** PIN source (tests); defaults to a crypto-random 0000-9999. */
  randomPin?: () => string
}

export interface PinPairing {
  /** Show a new PIN (replaces the current one). Throws while pairing is locked. */
  start(): { pin: string; expiresAt: number }
  cancel(): void
  /** The PIN that can be used now, or null (none started, expired, used or locked). */
  current(): { pin: string; expiresAt: number } | null
  /** When the lock for everyone ends (ms since epoch), or null when pairing is not locked. */
  lockedUntil(): number | null
  /** The PIN of the pairing that just succeeded, for a short while (Moonlight pairs with the same PIN). */
  lastPin(): string | null
  /** `source` is the caller's address: its wrong PINs lock out that address first, everyone only at the total cap. */
  verify(proofHex: string, fingerprint: string, clientId: string, source?: string): PinVerifyResult
}

export class PairingLockedError extends Error {
  constructor(readonly until: number) {
    super(tMain('mainStreaming.pair.lockedHost'))
    this.name = 'PairingLockedError'
  }
}

export function createPinPairing(options: PinPairingOptions = {}): PinPairing {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 5 * 60_000
  const maxFailures = options.maxFailures ?? 5
  const maxTotalFailures = Math.max(maxFailures, options.maxTotalFailures ?? 20)
  const lockMs = options.lockMs ?? 10 * 60_000
  const lastPinMs = options.lastPinMs ?? 2 * 60_000
  const randomPin = options.randomPin ?? newPin

  let active: { pin: string; expiresAt: number } | null = null
  let failures = 0
  let lockEnd: number | null = null
  let last: { pin: string; until: number } | null = null
  /**
   * Wrong proofs per address. Anyone who reaches the port could otherwise lock pairing for everyone with five bad
   * proofs each time the user shows a PIN; per address, such a caller only locks out itself, and the total cap still
   * bounds how many of the 10 000 PINs can be tried.
   */
  const bySource = new Map<string, { failures: number; lockEnd: number | null }>()

  const lockedNow = (): boolean => {
    if (lockEnd === null) return false
    if (now() < lockEnd) return true
    // The lock is over: wrong guesses from before it no longer count.
    lockEnd = null
    failures = 0
    bySource.clear()
    return false
  }

  const sourceLocked = (source: string): boolean => {
    const s = bySource.get(source)
    if (!s || s.lockEnd === null) return false
    if (now() < s.lockEnd) return true
    bySource.delete(source)
    return false
  }

  const countSource = (source: string): void => {
    // A bounded table: when it is full, entries that are not locked out are forgotten first.
    if (!bySource.has(source) && bySource.size >= 4096)
      for (const [key, s] of bySource) if (s.lockEnd === null) bySource.delete(key)
    const s = bySource.get(source) ?? { failures: 0, lockEnd: null }
    s.failures++
    if (s.failures >= maxFailures) s.lockEnd = now() + lockMs
    bySource.set(source, s)
  }

  const dropExpired = (): void => {
    if (active && now() >= active.expiresAt) active = null
  }

  return {
    start() {
      if (lockedNow()) throw new PairingLockedError(lockEnd as number)
      active = { pin: randomPin(), expiresAt: now() + ttlMs }
      return { ...active }
    },
    cancel() {
      active = null
    },
    current() {
      if (lockedNow()) return null
      dropExpired()
      return active ? { ...active } : null
    },
    lockedUntil() {
      return lockedNow() ? lockEnd : null
    },
    lastPin() {
      if (last && now() >= last.until) last = null
      return last?.pin ?? null
    },
    verify(proofHex, fingerprint, clientId, source = '') {
      if (lockedNow() || sourceLocked(source)) return 'locked'
      if (!active) return 'none'
      if (now() >= active.expiresAt) {
        active = null
        return 'expired'
      }
      if (proofMatches(proofHex, pairingProof(active.pin, fingerprint, clientId))) {
        last = { pin: active.pin, until: now() + lastPinMs }
        active = null
        failures = 0
        bySource.delete(source)
        return 'ok'
      }
      failures++
      countSource(source)
      if (failures >= maxTotalFailures) {
        // The PIN is gone too: after the lock the user starts a new one, so guesses made before it are worthless.
        active = null
        lockEnd = now() + lockMs
      }
      return 'wrong'
    }
  }
}

/** A crypto-random 4-digit PIN, '0000'-'9999'. */
export function newPin(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0')
}

/**
 * A PIN Moonlight and Sunshine pair with: exactly 4 digits (what `newPin` makes). The one rule for the host service,
 * the streaming service and the Sunshine call, so a PIN one of them takes is never refused by the next.
 */
export function isMoonlightPin(pin: string): boolean {
  return /^\d{4}$/.test(pin)
}

/** HMAC-SHA256(key = pin, message = `${fingerprint}|${clientId}`), lowercase hex. */
export function pairingProof(pin: string, fingerprint: string, clientId: string): string {
  return createHmac('sha256', pin).update(`${fingerprint.toLowerCase()}|${clientId}`).digest('hex')
}

function proofMatches(given: string, expected: string): boolean {
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/i.test(given)) return false
  return timingSafeEqual(Buffer.from(given.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'))
}

/** A client's access token: 32 random bytes, base64url. The host keeps only its hash. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/** SHA-256 of a token, lowercase hex: what the host stores for each paired client. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function tokenMatches(token: string, hashHex: string): boolean {
  if (typeof token !== 'string' || !token || !/^[0-9a-f]{64}$/i.test(hashHex)) return false
  return timingSafeEqual(
    Buffer.from(hashToken(token), 'hex'),
    Buffer.from(hashHex.toLowerCase(), 'hex')
  )
}
