/**
 * GitHub App authentication for the relay.
 *
 * The relay signs in as a GitHub App the owner creates in their own account (SETUP.md, step 5): no second GitHub
 * account. With the app's id and private key it signs a short-lived JWT (RS256, WebCrypto), exchanges it for an
 * installation access token limited to one repository and the permissions it needs there (contents + pull requests
 * on the metadata repository for suggestions; contents only on the PlayOut database), and keeps that token in memory
 * until about five minutes before it expires. Pull requests it opens show as `<app name>[bot]`.
 *
 * Secrets and tokens are never logged or put into error messages.
 */

import { GitHubError } from './github'

const API = 'https://api.github.com'

export interface AppAuthConfig {
  appId: string
  /** The PEM GitHub hands out (PKCS#1 "BEGIN RSA PRIVATE KEY"), or PKCS#8 "BEGIN PRIVATE KEY". */
  privateKey: string
  /** Optional; discovered from the repository otherwise. */
  installationId?: string
  owner: string
  repo: string
  /**
   * What the token may do (a subset of what the app was granted, or GitHub answers 422). Default
   * DEFAULT_APP_PERMISSIONS, what /suggest needs; the database token asks for contents only.
   */
  permissions?: AppPermissions
}

export type AppPermissions = Readonly<Record<string, 'read' | 'write'>>

/** The permissions of the metadata repository's token (/suggest: commit to suggest/ branches, open pull requests). */
export const DEFAULT_APP_PERMISSIONS: AppPermissions = { contents: 'write', pull_requests: 'write' }

export interface AppAuthDeps {
  fetch?: typeof fetch
  /** Milliseconds since the epoch. */
  now?: () => number
}

/** Refresh a cached installation token this long before GitHub's expires_at. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

export class PrivateKeyError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// PEM -> PKCS#8

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** version 0 + AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL } of a PKCS#8 PrivateKeyInfo. */
const PKCS8_RSA_PREFIX = [
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00
]

/** Wraps a PKCS#1 RSAPrivateKey (DER) in a PKCS#8 PrivateKeyInfo, the form WebCrypto's importKey takes. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const octet = concat([0x04, ...derLength(pkcs1.length)], pkcs1)
  const inner = concat(PKCS8_RSA_PREFIX, octet)
  return concat([0x30, ...derLength(inner.length)], inner)
}

/**
 * The PKCS#8 DER of a PEM private key. Accepts PKCS#1 ("RSA PRIVATE KEY") and PKCS#8 ("PRIVATE KEY"), with real
 * line breaks, CRLF or literal "\n" sequences (a key pasted as one line).
 */
export function pemToPkcs8(pem: string): Uint8Array {
  const text = pem.replace(/\\n/g, '\n').trim()
  const m = text.match(/-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]*?)-----END \1-----/)
  if (!m) throw new PrivateKeyError('GITHUB_APP_PRIVATE_KEY is not a PEM private key')
  let der: Uint8Array
  try {
    der = base64ToBytes(m[2].replace(/\s+/g, ''))
  } catch {
    throw new PrivateKeyError('GITHUB_APP_PRIVATE_KEY is not valid base64')
  }
  return m[1] === 'RSA PRIVATE KEY' ? pkcs1ToPkcs8(der) : der
}

// ---------------------------------------------------------------------------------------------------------------
// JWT

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)))
}

async function importSigningKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = pemToPkcs8(pem)
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    )
  } catch {
    throw new PrivateKeyError('GITHUB_APP_PRIVATE_KEY could not be imported as an RSA key')
  }
}

/** The app's JWT: RS256, issued 60 s in the past (clock drift), valid 9 minutes (GitHub allows at most 10). */
export async function signAppJwt(
  appId: string,
  privateKey: string,
  nowMs: number
): Promise<string> {
  const now = Math.floor(nowMs / 1000)
  const iss = /^\d+$/.test(appId) ? Number(appId) : appId
  const signingInput = `${base64urlJson({ alg: 'RS256', typ: 'JWT' })}.${base64urlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss
  })}`
  const key = await importSigningKey(privateKey)
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  )
  return `${signingInput}.${base64url(new Uint8Array(sig))}`
}

// ---------------------------------------------------------------------------------------------------------------
// Installation token

async function appRequest<T>(
  doFetch: typeof fetch,
  jwt: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await doFetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'PlayOut-metadata-relay',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { message?: string }).message ?? ''
    } catch {
      // no JSON body
    }
    // The path holds ids only, never a secret.
    throw new GitHubError(
      `GitHub app ${method} ${path}: ${res.status} ${detail}`.trim(),
      res.status
    )
  }
  return (await res.json()) as T
}

interface CachedToken {
  token: string
  /** Milliseconds since the epoch at which the cache stops using it. */
  refreshAt: number
}

const tokenCache = new Map<string, CachedToken>()
const installationCache = new Map<string, string>()

/** Forgets cached tokens and installation ids (tests; or after GitHub refuses a cached token). */
export function clearAppTokenCache(): void {
  tokenCache.clear()
  installationCache.clear()
}

function permissionsOf(cfg: AppAuthConfig): AppPermissions {
  return cfg.permissions ?? DEFAULT_APP_PERMISSIONS
}

function cacheKey(cfg: AppAuthConfig): string {
  const perms = Object.entries(permissionsOf(cfg))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, level]) => `${name}:${level}`)
    .join(',')
  return `${cfg.appId}|${cfg.installationId ?? ''}|${cfg.owner}/${cfg.repo}|${perms}`
}

/** The installation lookup is per repository, whatever the token's permissions. */
function installationKey(cfg: AppAuthConfig): string {
  return `${cfg.appId}|${cfg.installationId ?? ''}|${cfg.owner}/${cfg.repo}`
}

/**
 * An installation access token for `cfg.owner/cfg.repo`, from the in-memory cache while it has more than
 * TOKEN_REFRESH_MARGIN_MS left, otherwise a fresh one (limited to that repository and cfg.permissions,
 * contents + pull requests write by default).
 */
export async function installationToken(
  cfg: AppAuthConfig,
  deps: AppAuthDeps = {}
): Promise<string> {
  const now = deps.now?.() ?? Date.now()
  const key = cacheKey(cfg)
  const cached = tokenCache.get(key)
  if (cached && now < cached.refreshAt) return cached.token

  const doFetch = deps.fetch ?? fetch
  const jwt = await signAppJwt(cfg.appId, cfg.privateKey, now)

  let installationId = cfg.installationId || installationCache.get(installationKey(cfg))
  if (!installationId) {
    const inst = await appRequest<{ id: number }>(
      doFetch,
      jwt,
      'GET',
      `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/installation`
    )
    if (typeof inst?.id !== 'number') {
      throw new GitHubError('GitHub did not name the app installation', 502)
    }
    installationId = String(inst.id)
    installationCache.set(installationKey(cfg), installationId)
  }

  const r = await appRequest<{ token?: string; expires_at?: string }>(
    doFetch,
    jwt,
    'POST',
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      repositories: [cfg.repo],
      permissions: { ...permissionsOf(cfg) }
    }
  )
  if (typeof r?.token !== 'string' || !r.token) {
    throw new GitHubError('GitHub returned no installation token', 502)
  }
  const expires = Date.parse(r.expires_at ?? '')
  // Installation tokens last an hour; assume that when GitHub leaves expires_at out.
  const expiresAt = Number.isFinite(expires) ? expires : now + 60 * 60 * 1000
  tokenCache.set(key, { token: r.token, refreshAt: expiresAt - TOKEN_REFRESH_MARGIN_MS })
  return r.token
}
