import { X509Certificate } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CERT_FILE,
  certificateFingerprint,
  ensureHostCertificate,
  KEY_FILE,
  sameFingerprint
} from './tls'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'playout-tls-'))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('ensureHostCertificate', () => {
  it('creates a ten-year RSA-2048 certificate once and reuses it', async () => {
    const dir = await tempDir()
    const [a, b] = await Promise.all([ensureHostCertificate(dir), ensureHostCertificate(dir)])
    expect(b).toEqual(a)
    const x509 = new X509Certificate(a.cert)
    expect(x509.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048)
    const years = (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / (365 * 86_400_000)
    expect(years).toBeGreaterThan(9.9)
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(a.fingerprint).toBe(x509.fingerprint256.replace(/:/g, '').toLowerCase())
    expect(await fs.readFile(join(dir, CERT_FILE), 'utf8')).toBe(a.cert)
    expect(await fs.readFile(join(dir, KEY_FILE), 'utf8')).toBe(a.key)

    const again = await ensureHostCertificate(dir)
    expect(again.fingerprint).toBe(a.fingerprint)
  })

  it('makes a new certificate when the files are damaged', async () => {
    const dir = await tempDir()
    const first = await ensureHostCertificate(dir)
    await fs.writeFile(join(dir, CERT_FILE), 'garbage')
    const second = await ensureHostCertificate(dir)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(certificateFingerprint(second.cert)).toBe(second.fingerprint)
  })
})

describe('sameFingerprint', () => {
  it('ignores case and separators', () => {
    const fp = 'ab'.repeat(32)
    expect(sameFingerprint(fp, fp.toUpperCase().match(/../g)!.join(':'))).toBe(true)
    expect(sameFingerprint(fp, 'cd'.repeat(32))).toBe(false)
    expect(sameFingerprint('', '')).toBe(false)
  })
})
