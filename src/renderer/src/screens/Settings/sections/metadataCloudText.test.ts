import { describe, expect, it } from 'vitest'
import { queueLimitText, relayLimit, type MetadataCloudStatus } from '@shared/metadata-cloud'
import { t } from '../../../i18n'
import { editsGoText } from './metadataCloudText'

const base: MetadataCloudStatus = {
  syncing: false,
  lastSyncAt: null,
  generatedAt: null,
  lastError: null,
  cloudGames: 0,
  libraryGames: 0,
  relayUrl: '',
  sharedRelayUrl: 'https://relay.test',
  suggestEdits: true,
  queued: 0,
  queueLimit: null,
  queueNextAt: null,
  token: { state: 'none' },
  owner: false
}

const nextAt = '2026-11-17T01:12:00.000Z'
const time = new Date(nextAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

describe('queueLimitText', () => {
  it('says plainly that the relay takes 30 per hour from one PC and when the rest go', () => {
    expect(queueLimitText(19, 'client', nextAt, t)).toBe(
      `19 edits waiting to be suggested. The suggestion service accepts 30 per hour from one PC; PlayOut sends the rest automatically (next at ${time}).`
    )
    expect(queueLimitText(1, 'client', null, t)).toBe(
      '1 edit waiting to be suggested. The suggestion service accepts 30 per hour from one PC; PlayOut sends the rest automatically.'
    )
    expect(queueLimitText(3, 'service', nextAt, t)).toBe(
      `3 edits waiting to be suggested. The suggestion service is busy right now; PlayOut sends them automatically (next at ${time}).`
    )
    expect(queueLimitText(3, 'network', nextAt, t)).toBe(
      `3 edits waiting to be suggested. The suggestion service has had many suggestions from your internet connection this hour; PlayOut sends the rest automatically (next at ${time}).`
    )
    expect(queueLimitText(3, 'backlog', nextAt, t)).toBe(
      `3 edits waiting to be suggested. The maintainer has many suggestions to review first; PlayOut tries again automatically (next at ${time}).`
    )
  })
})

describe('relayLimit', () => {
  it("reads which limit each of the relay's 429 errors names", () => {
    expect(relayLimit('too many suggestions (client); try again later')).toBe('client')
    expect(relayLimit('too many suggestions (ip); try again later')).toBe('network')
    expect(relayLimit('too many suggestions (ip48); try again later')).toBe('network')
    expect(relayLimit('too many suggestions (global); try again later')).toBe('service')
    expect(relayLimit('too many suggestions wait for review; try again later')).toBe('backlog')
    expect(relayLimit('')).toBe('service')
  })
})

describe('editsGoText', () => {
  it('explains the limit while edits wait for it', () => {
    const limited = { ...base, queued: 19, queueLimit: 'client' as const, queueNextAt: nextAt }
    expect(editsGoText(limited)).toBe(
      `Your edits are suggested to the maintainer when you save them. ${queueLimitText(19, 'client', nextAt, t)}`
    )
  })

  it('keeps the plain lines otherwise', () => {
    expect(editsGoText(base)).toBe('Your edits are suggested to the maintainer when you save them.')
    expect(editsGoText({ ...base, queued: 2 })).toBe(
      'Your edits are suggested to the maintainer when you save them. 2 edits waiting to be suggested.'
    )
  })
})
