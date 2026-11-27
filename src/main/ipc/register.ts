import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { API_METHODS, ipcChannel, type ApiMethod, type PlayOutApi } from '../../shared/api'
import { createLogger } from '../logger'
import { isAppUrl } from '../util/app-origin'

const log = createLogger('ipc')

/** Main-process implementation of every invokable PlayOutApi method. */
export type ApiHandlers = {
  [M in ApiMethod]: (...args: Parameters<PlayOutApi[M]>) => ReturnType<PlayOutApi[M]>
}

export interface RegisterIpcOptions {
  /**
   * Decides whether the frame that sent an invoke may use the API. Defaults to {@link isAppUrl}: only the app's own
   * document (dev server origin or packaged index.html) is trusted, so a page the window was navigated to by a dropped
   * link or file gets `Unauthorized` for every call even though the preload exposed `window.playout` to it.
   */
  isTrustedSender?: (url: string) => boolean
}

/** URL of the frame an invoke came from, or '' when the frame is gone or unknown. */
export function senderUrl(event: IpcMainInvokeEvent): string {
  try {
    return event.senderFrame?.url ?? ''
  } catch {
    return ''
  }
}

/**
 * Register `ipcMain.handle` for every method. Invokes from any frame other than the app document are rejected before
 * the handler runs; handler errors are logged and re-thrown with a clean message.
 */
export function registerIpc(handlers: ApiHandlers, options: RegisterIpcOptions = {}): void {
  const trusted = options.isTrustedSender ?? ((url: string) => isAppUrl(url))
  for (const method of API_METHODS) {
    const handler = handlers[method] as (...args: unknown[]) => Promise<unknown>
    ipcMain.handle(ipcChannel(method), async (event, ...args: unknown[]) => {
      const from = senderUrl(event)
      if (!trusted(from)) {
        log.error(`${method} rejected: untrusted sender ${from || '(unknown frame)'}`)
        throw new Error('Unauthorized')
      }
      try {
        return await handler(...args)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error(`${method} failed: ${message}`)
        throw new Error(message, { cause: err })
      }
    })
  }
}
