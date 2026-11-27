// The metadata cloud in the mock (main metadata-cloud/): no network and no cloud entries. A token that is not empty
// counts as a working owner token (login 'owner'), which lists two made-up suggestions to approve or reject. A saved
// edit reports what main would: published (owner), suggested (a relay URL is set) or saved here and queued.
import type { PlayOutApi } from '@shared/api'
import {
  diffMetadataFields,
  normalizeRelayUrl,
  type MetadataCloudStatus,
  type MetadataSuggestion
} from '@shared/metadata-cloud'
import type { MetadataEdit } from '@shared/metadata-edit'
import { t } from '../../i18n'
import type { MockEmitter } from './emitter'

export type MetadataCloudApi = Pick<
  PlayOutApi,
  | 'getMetadataCloudStatus'
  | 'setMetadataCloudConfig'
  | 'checkMetadataCloudToken'
  | 'syncMetadataCloud'
  | 'listMetadataSuggestions'
  | 'resolveMetadataSuggestion'
  | 'shareMetadataRelayUrl'
>

export interface MetadataCloudMock {
  api: MetadataCloudApi
  /** A metadata edit was saved (setMetadataEdit): publish, suggest or queue it like main. */
  edited(title: string, set: MetadataEdit | undefined): void
}

function sampleSuggestions(): MetadataSuggestion[] {
  return [
    {
      number: 12,
      url: 'https://github.com/jeremybris/PlayOut-metadata/pull/12',
      title: 'Suggestion: Hades',
      key: 'steam-1145360',
      gameTitle: 'Hades',
      createdAt: '2026-11-14T18:20:00.000Z',
      headSha: '1c0ffee0000000000000000000000000000000a1',
      changes: diffMetadataFields(
        { genres: ['Action'], localPlayers: 0 },
        { genres: ['Action', 'Roguelike'], localPlayers: 1, hltb: { main: 22, completionist: 95 } },
        t
      )
    },
    {
      number: 15,
      url: 'https://github.com/jeremybris/PlayOut-metadata/pull/15',
      title: 'Suggestion: Celeste',
      key: 'steam-504230',
      gameTitle: 'Celeste',
      createdAt: '2026-11-15T09:05:00.000Z',
      headSha: '1c0ffee0000000000000000000000000000000b2',
      changes: diffMetadataFields(
        { releaseDate: '2018-01-26' },
        {
          releaseDate: '2018-01-25',
          controls: { controller: 'full', vr: 'none', keyboard: true }
        },
        t
      )
    }
  ]
}

export function createMetadataCloudMock(deps: { emitter: MockEmitter }): MetadataCloudMock {
  const status: MetadataCloudStatus = {
    syncing: false,
    lastSyncAt: null,
    generatedAt: null,
    lastError: null,
    cloudGames: 0,
    libraryGames: 0,
    relayUrl: '',
    sharedRelayUrl: '',
    suggestEdits: true,
    queued: 0,
    queueLimit: null,
    queueNextAt: null,
    token: { state: 'none' },
    owner: false
  }
  let suggestions = sampleSuggestions()
  const snapshot = (): MetadataCloudStatus => structuredClone(status)
  const emit = (): void => deps.emitter.emit('metadata-cloud:status', snapshot())

  const api: MetadataCloudApi = {
    async getMetadataCloudStatus() {
      return snapshot()
    },
    async setMetadataCloudConfig(patch) {
      if (patch.relayUrl !== undefined) {
        const relay = normalizeRelayUrl(patch.relayUrl)
        if (relay === null)
          throw new Error('The relay URL must be an https:// address (http:// only for localhost)')
        status.relayUrl = relay
        if (relay && status.queued) status.queued = 0
      }
      if (patch.suggestEdits !== undefined) status.suggestEdits = patch.suggestEdits
      if (patch.token !== undefined) {
        const token = (patch.token ?? '').trim()
        status.token = token
          ? { state: 'ok', login: 'owner', checkedAt: new Date().toISOString() }
          : { state: 'none' }
        status.owner = !!token
        if (token) suggestions = sampleSuggestions()
      }
      emit()
      return snapshot()
    },
    async checkMetadataCloudToken() {
      if (status.token.state !== 'none') status.token.checkedAt = new Date().toISOString()
      emit()
      return snapshot()
    },
    async syncMetadataCloud() {
      status.lastSyncAt = new Date().toISOString()
      status.lastError = null
      emit()
      return snapshot()
    },
    async listMetadataSuggestions() {
      if (!status.owner)
        throw new Error('Add a GitHub token that can write to the metadata repository first')
      return structuredClone(suggestions)
    },
    async resolveMetadataSuggestion(number, _action, headSha) {
      if (!status.owner)
        throw new Error('Add a GitHub token that can write to the metadata repository first')
      const open = suggestions.find((s) => s.number === number)
      if (!open) throw new Error(`#${number} is not open`)
      if (open.headSha !== headSha)
        throw new Error(
          `#${number} changed after it was reviewed; refresh the list and review it again`
        )
      suggestions = suggestions.filter((s) => s.number !== number)
    },
    async shareMetadataRelayUrl() {
      if (!status.owner)
        throw new Error('Add a GitHub token that can write to the metadata repository first')
      if (!status.relayUrl) throw new Error('Enter the relay URL first')
      status.sharedRelayUrl = status.relayUrl
      emit()
    }
  }

  return {
    api,
    edited(title, set) {
      if (!set || !Object.keys(set).length) return
      if (status.owner) {
        deps.emitter.emit('metadata-cloud:notice', {
          kind: 'published',
          title,
          message: `${title}: published to the PlayOut metadata cloud`
        })
      } else if (!status.suggestEdits) {
        return
      } else if (status.relayUrl || status.sharedRelayUrl) {
        deps.emitter.emit('metadata-cloud:notice', {
          kind: 'suggested',
          title,
          message: `${title}: suggested to the PlayOut metadata maintainer`
        })
      } else {
        status.queued++
        deps.emitter.emit('metadata-cloud:notice', {
          kind: 'queued',
          title,
          message: `${title}: saved here; will be suggested when the suggestion service is available`
        })
        emit()
      }
    }
  }
}
