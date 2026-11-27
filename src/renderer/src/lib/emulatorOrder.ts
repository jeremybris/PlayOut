const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Names compared alphabetically, ignoring case and reading digits as numbers ("PCSX2" after "PCSX"). */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b)
}

/**
 * The emulators the Emulators tab lists: the ones this PC has (detected or given a path) first, then the missing
 * ones, each group in alphabetical order.
 */
export function orderEmulators<T extends { name: string; path: string | null }>(
  emulators: readonly T[]
): T[] {
  return [...emulators].sort(
    (a, b) => Number(!a.path) - Number(!b.path) || compareNames(a.name, b.name)
  )
}

/** The systems (platforms) in alphabetical order by name. */
export function orderSystems<T extends { name: string }>(systems: readonly T[]): T[] {
  return [...systems].sort((a, b) => compareNames(a.name, b.name))
}

/** A system's emulator choices: the ones this PC has first, then the missing ones, each group alphabetical. */
export function orderChoices<T extends { id: string; label: string }>(
  choices: readonly T[],
  available: ReadonlySet<string>
): T[] {
  return [...choices].sort(
    (a, b) =>
      Number(!available.has(a.id)) - Number(!available.has(b.id)) || compareNames(a.label, b.label)
  )
}
