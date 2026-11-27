import { createHash, createPrivateKey, X509Certificate } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { generate } from 'selfsigned'
import { tMain } from '../i18n'

/**
 * The host's TLS identity. A self-signed certificate is enough: clients never trust it through a CA, they pin its
 * SHA-256 fingerprint when they pair (the PIN proof is bound to it), so the certificate has to stay the same for as
 * long as the pairings should last. That is why it is made once, valid for ten years, and kept in userData.
 */

export const KEY_FILE = 'host-key.pem'
export const CERT_FILE = 'host-cert.pem'
const VALID_DAYS = 3650

export interface HostCertificate {
  key: string
  cert: string
  /** SHA-256 of the DER certificate, lowercase hex without separators. */
  fingerprint: string
}

/** SHA-256 of a certificate (PEM text or DER bytes), lowercase hex: the value clients pin. */
export function certificateFingerprint(cert: string | Buffer): string {
  const der = typeof cert === 'string' ? new X509Certificate(cert).raw : cert
  return createHash('sha256').update(der).digest('hex')
}

/** Whether two fingerprints are the same, whatever their case or separators ("AB:CD..." from other tools). */
export function sameFingerprint(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/[^0-9a-f]/gi, '').toLowerCase()
  return norm(a).length === 64 && norm(a) === norm(b)
}

const inFlight = new Map<string, Promise<HostCertificate>>()

/** The host certificate in `dir`, created on first use (or again when the files are unreadable or expired). */
export function ensureHostCertificate(dir: string): Promise<HostCertificate> {
  const running = inFlight.get(dir)
  if (running) return running
  const job = loadOrCreate(dir).finally(() => inFlight.delete(dir))
  inFlight.set(dir, job)
  return job
}

async function loadOrCreate(dir: string): Promise<HostCertificate> {
  const existing = await readExisting(dir)
  if (existing) return existing
  const made = await generateCertificate()
  await fs.mkdir(dir, { recursive: true })
  // Key first, certificate last: a crash in between leaves no certificate, so the next start makes a new pair
  // instead of serving a certificate whose key is missing.
  await writeAtomic(join(dir, KEY_FILE), made.key)
  await writeAtomic(join(dir, CERT_FILE), made.cert)
  return made
}

async function readExisting(dir: string): Promise<HostCertificate | null> {
  try {
    const [key, cert] = await Promise.all([
      fs.readFile(join(dir, KEY_FILE), 'utf8'),
      fs.readFile(join(dir, CERT_FILE), 'utf8')
    ])
    const x509 = new X509Certificate(cert)
    if (Date.parse(x509.validTo) <= Date.now()) return null
    // A certificate that does not belong to the key would fail every TLS handshake: treat it as missing.
    if (!x509.checkPrivateKey(createPrivateKey(key))) return null
    return { key, cert, fingerprint: certificateFingerprint(x509.raw) }
  } catch {
    return null
  }
}

function generateCertificate(): Promise<HostCertificate> {
  return new Promise((resolve, reject) => {
    // The callback form lets node-forge use Node's native RSA key generation instead of blocking the main process
    // for seconds in pure JavaScript.
    generate(
      [
        { name: 'commonName', value: 'PlayOut host' },
        { name: 'organizationName', value: 'PlayOut' }
      ],
      {
        keySize: 2048,
        days: VALID_DAYS,
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true }
        ]
      },
      (err, result) => {
        if (err || !result) {
          reject(err ?? new Error(tMain('mainStreaming.host.hostCertificate')))
          return
        }
        try {
          resolve({
            key: result.private,
            cert: result.cert,
            fingerprint: certificateFingerprint(result.cert)
          })
        } catch (e) {
          reject(e)
        }
      }
    )
  })
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}
