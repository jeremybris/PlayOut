/** A public Google Drive folder, read without a key or sign-in: its listing page and its files' download links. */

export interface DriveFile {
  id: string
  name: string
  /** Set (true) for a subfolder: its link is a /drive/folders/ link, a file's is /file/d/. */
  folder?: true
}

/** The listing page of a public folder (its files and subfolders, by id and name). */
export function driveListingUrl(folderId: string): string {
  return `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`
}

/** A public file's download link (`confirm=t` skips the virus-scan page Drive shows for large files). */
export function driveFileUrl(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`
}

/**
 * The (id, name) pairs of a folder's listing page. Each entry is read on its own (from its `id="entry-..."` up to the
 * next one), so an entry without a title or link never borrows the next entry's.
 */
export function parseDriveListing(html: string): DriveFile[] {
  const out: DriveFile[] = []
  const starts: { at: number; id: string }[] = []
  const re = /id="entry-([\w-]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) starts.push({ at: m.index, id: m[1]! })
  for (const [i, s] of starts.entries()) {
    const chunk = html.slice(s.at, starts[i + 1]?.at ?? html.length)
    const title = /class="flip-entry-title">([^<]+)</.exec(chunk)
    if (!title) continue
    const href = /href="([^"]*)"/.exec(chunk)?.[1] ?? ''
    const folder =
      /\/drive\/(?:u\/\d+\/)?folders\//.test(href) ||
      (!/\/file\/d\//.test(href) && /aria-label="(?:Shared )?Folder"/i.test(chunk))
    out.push({ id: s.id, name: decodeHtml(title[1]!.trim()), ...(folder ? { folder: true } : {}) })
  }
  return out
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
