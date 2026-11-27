function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

/**
 * Recursively merge `patch` into `target` and return a new object. Plain objects merge, everything else (arrays,
 * primitives, null) replaces. `undefined` values in the patch are ignored.
 */
export function deepMerge<T>(target: T, patch: unknown): T {
  if (!isPlainObject(target) || !isPlainObject(patch)) {
    return (patch === undefined ? target : (patch as T)) as T
  }
  const out: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return out as T
}

export function clone<T>(value: T): T {
  return structuredClone(value)
}
