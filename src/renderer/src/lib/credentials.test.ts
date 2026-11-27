import { describe, expect, it } from 'vitest'
import {
  credentialsReady,
  credentialsSignature,
  igdbMissingHalf,
  screenScraperNeedsDev
} from './credentials'

describe('credentialsReady', () => {
  it('needs a non-blank key for the single-key services', () => {
    expect(credentialsReady('steamgriddb', { apiKey: ' ' })).toBe(false)
    expect(credentialsReady('steamgriddb', { apiKey: 'k' })).toBe(true)
    expect(credentialsReady('thegamesdb', { apiKey: 'k' })).toBe(true)
  })

  it('waits for both IGDB fields', () => {
    expect(credentialsReady('igdb', { clientId: 'id', clientSecret: '' })).toBe(false)
    expect(credentialsReady('igdb', { clientId: 'id', clientSecret: 's' })).toBe(true)
  })

  it('tests ScreenScraper only for complete pairs', () => {
    const empty = { devId: '', devPassword: '', user: '', password: '' }
    expect(credentialsReady('screenscraper', empty)).toBe(false)
    expect(credentialsReady('screenscraper', { ...empty, devId: 'd' })).toBe(false)
    expect(credentialsReady('screenscraper', { ...empty, devId: 'd', devPassword: 'p' })).toBe(true)
    // Developer pair done, user login half typed: wait.
    expect(
      credentialsReady('screenscraper', { devId: 'd', devPassword: 'p', user: 'me', password: '' })
    ).toBe(false)
    expect(
      credentialsReady('screenscraper', { devId: 'd', devPassword: 'p', user: 'me', password: 'x' })
    ).toBe(true)
    // A full user login without any developer field: tested, the answer asks for the developer pair.
    expect(credentialsReady('screenscraper', { ...empty, user: 'me', password: 'x' })).toBe(true)
    // ...but not while the developer pair is half typed.
    expect(
      credentialsReady('screenscraper', { devId: 'd', devPassword: '', user: 'me', password: 'x' })
    ).toBe(false)
  })

  it('waits while a SteamID64 is still being typed', () => {
    expect(credentialsReady('steam', { apiKey: 'k', steamId64: '' })).toBe(true)
    expect(credentialsReady('steam', { apiKey: 'k', steamId64: '7656119' })).toBe(false)
    expect(credentialsReady('steam', { apiKey: 'k', steamId64: '76561198000000001' })).toBe(true)
    expect(credentialsReady('steam', { apiKey: 'k', steamId64: '7656x' })).toBe(true)
    expect(credentialsReady('steam', { apiKey: '', steamId64: '76561198000000001' })).toBe(false)
  })
})

describe('credentialsSignature', () => {
  it('ignores surrounding spaces except in passwords', () => {
    expect(credentialsSignature({ apiKey: ' k ' })).toBe(credentialsSignature({ apiKey: 'k' }))
    const ss = { devId: 'd', devPassword: 'p', user: 'u', password: 'x' }
    expect(credentialsSignature({ ...ss, password: ' x' })).not.toBe(credentialsSignature(ss))
  })
})

describe('igdbMissingHalf', () => {
  it('names the missing IGDB field only when exactly one is filled in', () => {
    expect(igdbMissingHalf({ clientId: 'id', clientSecret: ' ' })).toMatch(/client secret/)
    expect(igdbMissingHalf({ clientId: '', clientSecret: 'secret' })).toMatch(/client ID/)
    expect(igdbMissingHalf({ clientId: '', clientSecret: '' })).toBeNull()
    expect(igdbMissingHalf({ clientId: 'id', clientSecret: 'secret' })).toBeNull()
  })
})

describe('screenScraperNeedsDev', () => {
  const ss = (
    user: string,
    password: string,
    devId: string,
    devPassword: string
  ): { user: string; password: string; devId: string; devPassword: string } => ({
    user,
    password,
    devId,
    devPassword
  })
  it('warns only for a user account without the developer ID and password', () => {
    expect(screenScraperNeedsDev(ss('me', 'pw', '', ''))).toMatch(/developer ID and password/)
    expect(screenScraperNeedsDev(ss('me', 'pw', 'dev', ''))).toMatch(/developer ID/)
    expect(screenScraperNeedsDev(ss('me', 'pw', 'dev', 'devpw'))).toBeNull()
    expect(screenScraperNeedsDev(ss('', '', '', ''))).toBeNull()
    expect(screenScraperNeedsDev(ss('me', '', '', ''))).toBeNull()
    expect(screenScraperNeedsDev(ss('', '', 'dev', 'devpw'))).toBeNull()
  })
})
