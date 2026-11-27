// Shared fakes for the account importer tests: a scripted auth window and a fetch stub keyed by URL.
import { vi } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { Logger } from '../logger'
import type { AccountContext, AuthWindow } from './types'

export interface ScriptedPage {
  url: string
  loaded?: boolean
  /** What `executeJavaScript` returns on this page. */
  js?: unknown
  /** `onRequest` details fired while on this page. */
  requests?: { url: string; requestHeaders?: Record<string, string> }[]
}

/** An AuthWindow that replays the given navigation events and resolves with the first capture (or null). */
export function scriptedWindow(pages: ScriptedPage[]): AuthWindow & { runs: number } {
  const win = {
    runs: 0,
    async run<T>(page: {
      onNavigate?: (ctx: {
        url: string
        loaded: boolean
        executeJavaScript<R>(s: string): Promise<R>
      }) => Promise<T | null | undefined> | T | null | undefined
      onRequest?: (d: {
        url: string
        requestHeaders?: Record<string, string>
      }) => T | null | undefined
    }): Promise<T | null> {
      win.runs++
      for (const p of pages) {
        for (const r of p.requests ?? []) {
          const value = page.onRequest?.(r)
          if (value !== null && value !== undefined) return value
        }
        const value = await page.onNavigate?.({
          url: p.url,
          loaded: p.loaded ?? true,
          executeJavaScript: async <R>() => p.js as R
        })
        if (value !== null && value !== undefined) return value
      }
      return null
    }
  }
  return win
}

export const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

export function context(hidden: AuthWindow = scriptedWindow([])): AccountContext {
  return { settings: defaultSettings(), log: silentLog, hidden }
}

export type FetchRoute = (
  url: URL,
  init: RequestInit
) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined

/** Stub `fetch` with a router; returns the mock so tests can inspect the calls. */
export function stubFetch(route: FetchRoute): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const answer = route(url, init)
    if (!answer) return new Response('not found', { status: 404 })
    const body =
      answer.body === undefined
        ? ''
        : typeof answer.body === 'string'
          ? answer.body
          : JSON.stringify(answer.body)
    return new Response(body, {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) }
    })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

export function requestBody(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : ''
}
