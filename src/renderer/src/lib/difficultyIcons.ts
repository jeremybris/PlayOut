/**
 * Difficulty pictures for Filters > Difficulty (the user's "Difficulty Icons" set, scaled to 96 px;
 * scripts/build-difficulty-icons.ps1 makes them), one per shared/difficulty.ts DIFFICULTY_IDS id, from "Story" to
 * "Impossible".
 */
const files = import.meta.glob<string>('../assets/difficulty-icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
})

const urlByDifficulty = new Map(
  Object.entries(files).map(([path, url]) => [
    path.slice(path.lastIndexOf('/') + 1, -'.png'.length),
    url
  ])
)

/** The picture of a Filters > Difficulty level id, or undefined when it has none. */
export function difficultyIcon(difficultyId: string | undefined): string | undefined {
  return difficultyId ? urlByDifficulty.get(difficultyId) : undefined
}
