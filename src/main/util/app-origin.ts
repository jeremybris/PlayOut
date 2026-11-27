import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { pathToFileURL } from 'url'

/**
 * The one document allowed to drive the main process: the electron-vite dev server origin in development
 * (`http://localhost:5173`) or the packaged renderer entry (`file:///.../out/renderer/index.html`).
 *
 * Shared by the IPC layer (every invoke must come from this document) and the window (navigation anywhere else is
 * blocked), so a URL or HTML file dropped onto the window can never reach `window.playout`.
 */
export function appOrigin(): string {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && dev) return new URL(dev).origin
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

let cached: string | null = null

/**
 * Is `url` the app document? For an http(s) origin the URL's origin must match exactly (any path, query or hash);
 * for the file:// entry the URL without query/hash must be the index.html itself. Note `new URL('file:...').origin`
 * is the string 'null', so file URLs are compared by href prefix, case-insensitively on Windows.
 */
export function isAppUrl(url: string | null | undefined, origin?: string): boolean {
  if (!url) return false
  const allowed = origin ?? (cached ??= appOrigin())
  if (/^https?:\/\//i.test(allowed)) {
    try {
      return new URL(url).origin === allowed
    } catch {
      return false
    }
  }
  const document = url.split(/[?#]/, 1)[0] ?? ''
  return normalizeFileUrl(document) === normalizeFileUrl(allowed)
}

function normalizeFileUrl(url: string): string {
  let out = url
  try {
    out = decodeURIComponent(url)
  } catch {
    /* keep the raw form */
  }
  return process.platform === 'win32' ? out.toLowerCase() : out
}
