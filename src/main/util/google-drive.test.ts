import { describe, expect, it } from 'vitest'
import { driveFileUrl, driveListingUrl, parseDriveListing } from './google-drive'

/** Two entries as Drive's embedded folder view writes them (shape checked against a live listing, 2026-11-14). */
const LISTING =
  '<div class="flip-entries">' +
  '<div class="flip-entry" id="entry-1nsn6wUOuIv5W5ZEbXKe5nGqR7K0vlXyF" tabindex="0" role="link"><div class="flip-entry-info">' +
  '<a href="https://drive.google.com/drive/folders/1nsn6wUOuIv5W5ZEbXKe5nGqR7K0vlXyF" target="_blank"><div class="flip-entry-visual">' +
  '<div aria-label="Folder" class="icon-color-1 drive-sprite-folder-grid-shared-icon"></div></div>' +
  '<div class="flip-entry-title">cache</div></a></div><div class="flip-entry-last-modified"><div>4:35 am</div></div></div>' +
  '<div class="flip-entry" id="entry-1BVE8GQ_pAawVnkjUQ5VTg1UnE3gzUFhs" tabindex="0" role="link"><div class="flip-entry-info">' +
  '<a href="https://drive.google.com/file/d/1BVE8GQ_pAawVnkjUQ5VTg1UnE3gzUFhs/view?usp=drive_web" target="_blank">' +
  '<div class="flip-entry-title">Tom &amp; Jerry&#39;s.dll</div></a></div></div>' +
  '</div>'

describe('google drive', () => {
  it('lists files and folders, telling folders apart by their link', () => {
    expect(parseDriveListing(LISTING)).toEqual([
      { id: '1nsn6wUOuIv5W5ZEbXKe5nGqR7K0vlXyF', name: 'cache', folder: true },
      { id: '1BVE8GQ_pAawVnkjUQ5VTg1UnE3gzUFhs', name: "Tom & Jerry's.dll" }
    ])
  })

  it('reads each entry on its own: one without a title or link borrows nothing from the next', () => {
    const html =
      '<div id="entry-A"><div class="flip-entry-title">no-link.txt</div></div>' +
      '<div id="entry-B"></div>' +
      '<div id="entry-C"><a href="https://drive.google.com/drive/folders/C"></a><div class="flip-entry-title">sub</div></div>'
    expect(parseDriveListing(html)).toEqual([
      { id: 'A', name: 'no-link.txt' },
      { id: 'C', name: 'sub', folder: true }
    ])
  })

  it('builds the listing and download links', () => {
    expect(driveListingUrl('abc')).toBe('https://drive.google.com/embeddedfolderview?id=abc')
    expect(driveFileUrl('x y')).toBe(
      'https://drive.usercontent.google.com/download?id=x%20y&export=download&confirm=t'
    )
  })
})
