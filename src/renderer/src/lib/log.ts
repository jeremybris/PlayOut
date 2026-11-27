/**
 * Renderer logger. The renderer has no electron-log; everything goes to the DevTools console with a
 * `[playout:<scope>]` prefix so main-process style scoping is kept.
 */
export interface Log {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Create a scoped logger, e.g. `const log = createLog('gamepad')`. */
export function createLog(scope: string): Log {
  const prefix = `[playout:${scope}]`
  return {
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args)
  }
}
