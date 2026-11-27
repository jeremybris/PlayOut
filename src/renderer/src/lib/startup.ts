/**
 * One step of a start-up sequence, isolated from the others: a step that throws or rejects is reported to
 * `onError` and resolves to undefined, so the steps after it in the chain (and beside it in a Promise.all)
 * still run. App's initial load uses it: a failed streaming or library read must not skip the questions
 * about kept disc images or the first-start host offer.
 */
export async function isolatedStep<T>(
  label: string,
  run: () => T | Promise<T>,
  onError: (label: string, err: unknown) => void
): Promise<T | undefined> {
  try {
    return await run()
  } catch (err) {
    try {
      onError(label, err)
    } catch {
      // A reporter that throws must not break the isolation either.
    }
    return undefined
  }
}
