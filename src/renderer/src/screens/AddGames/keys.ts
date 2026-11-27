/** Focus key of a store card's Sign in / Sign out button in Add Games (Library Import). */
export function accountFocusKey(sourceId: string, control: 'signin' | 'signout'): string {
  return `addgames:${control}:${sourceId}`
}
