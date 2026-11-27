// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { TAG_FILTERS } from '../lib/steamTags'
import { GenreIcon } from './GenreIcon'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(id: string): HTMLElement {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<GenreIcon genreId={id} />))
  return host
}

/** Genres with one of the user's pictures (scripts/build-genre-icons.ps1) instead of a line icon. */
const MASKS = [
  '2d',
  'anime',
  'immersive sim',
  'jrpg',
  'metroidvania',
  'minimalist',
  'platformer',
  'puzzle platformer',
  'rts',
  'shooter'
]

describe('GenreIcon', () => {
  it('has an icon or a picture for every genre', () => {
    for (const f of TAG_FILTERS) {
      const host = render(f.id)
      expect(host.querySelector('.genre-icon'), f.id).not.toBeNull()
    }
  })

  it('paints every picture in the text colour, like the line icons', () => {
    for (const id of MASKS) {
      const mask = render(id).querySelector<HTMLElement>('.genre-icon--mask')
      expect(mask?.style.maskImage, id).toMatch(/^url\(/)
      expect(render(id).querySelector('img'), id).toBeNull()
    }
  })

  it('draws Roguelike itself', () => {
    expect(render('roguelike').querySelector('svg.genre-icon')).not.toBeNull()
  })

  it('keeps an empty box for an unknown genre, so the names line up', () => {
    const host = render('not a genre')
    expect(host.querySelector('.console-icon')).not.toBeNull()
    expect(host.querySelector('.genre-icon')).toBeNull()
  })
})
