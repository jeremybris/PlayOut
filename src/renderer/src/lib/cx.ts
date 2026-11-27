/** Join class names, skipping falsy entries: `cx('btn', focused && 'is-focused', className)`. */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  let out = ''
  for (const part of parts) {
    if (!part) continue
    out = out ? `${out} ${part}` : part
  }
  return out
}
