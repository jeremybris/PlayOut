import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../shared/types'
import { createUpdateService, UPDATE_REPO, type UpdaterLike, type UpdateService } from '.'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  logger: unknown = null
  setFeedURL = vi.fn()
  checkForUpdates = vi.fn(async (): Promise<unknown> => ({}))
  downloadUpdate = vi.fn(async (): Promise<unknown> => [])
  quitAndInstall = vi.fn()
}

let fake: FakeUpdater
let emitted: UpdateStatus[]

function service(overrides: { packaged?: boolean; portable?: boolean } = {}): UpdateService {
  return createUpdateService({
    events: { emit: (_name: string, payload: unknown) => emitted.push(payload as UpdateStatus) },
    log,
    currentVersion: '0.1.0',
    packaged: overrides.packaged ?? true,
    portable: overrides.portable ?? false,
    updater: () => fake as unknown as UpdaterLike
  })
}

function announce(version = '0.2.0'): void {
  fake.checkForUpdates.mockImplementation(async () => {
    fake.emit('update-available', { version })
    return {}
  })
}

beforeEach(() => {
  fake = new FakeUpdater()
  emitted = []
})

describe('update service', () => {
  it('reports the check, the download with its progress, and the install', async () => {
    announce()
    fake.downloadUpdate.mockImplementation(async () => {
      fake.emit('download-progress', {
        percent: 42.5,
        transferred: 425,
        total: 1000,
        bytesPerSecond: 10
      })
      fake.emit('update-downloaded', { version: '0.2.0' })
      return []
    })
    const updates = service()
    expect(updates.status().state).toBe('idle')

    expect(await updates.check()).toMatchObject({ state: 'available', version: '0.2.0' })
    expect(fake.autoDownload).toBe(false)
    expect(fake.autoInstallOnAppQuit).toBe(false)
    expect(fake.setFeedURL).toHaveBeenCalledWith({ provider: 'github', ...UPDATE_REPO })

    expect(await updates.download()).toMatchObject({ state: 'downloaded', percent: 100 })
    expect(emitted.map((s) => s.state)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloading',
      'downloaded'
    ])
    expect(emitted[3]).toMatchObject({ percent: 42.5, bytesDone: 425, bytesTotal: 1000 })

    expect(updates.install().state).toBe('installing')
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('says so when this is the latest version', async () => {
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit('update-not-available', {})
      return {}
    })
    expect((await service().check()).state).toBe('up-to-date')
  })

  it.each([
    [{ code: 'ERR_XML_MISSED_ELEMENT' }],
    [{ code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }],
    [{ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: 'HttpError: 404 Not Found' }],
    [{ statusCode: 404 }]
  ])('treats a repository without releases as nothing to update to: %o', async (fields) => {
    fake.checkForUpdates.mockRejectedValue(Object.assign(new Error('nope'), fields))
    expect(await service().check()).toMatchObject({
      state: 'up-to-date',
      message: 'No updates have been published yet.'
    })
  })

  it('reports an outage of the latest-release lookup as an error, not as no updates', async () => {
    fake.checkForUpdates.mockRejectedValue(
      Object.assign(new Error('Unable to find latest version: 503 Service Unavailable'), {
        code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
      })
    )
    expect((await service().check()).state).toBe('error')
  })

  it('reports one short error when the updater both emits and rejects', async () => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED\nHeaders: a long dump')
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit('error', err)
      throw err
    })
    const updates = service()
    expect(await updates.check()).toMatchObject({
      state: 'error',
      message: 'Could not check for updates: net::ERR_INTERNET_DISCONNECTED'
    })
    expect(emitted.filter((s) => s.state === 'error')).toHaveLength(1)
  })

  it('reports a failed download and lets the user check again', async () => {
    announce()
    fake.downloadUpdate.mockRejectedValue(new Error('sha512 checksum mismatch'))
    const updates = service()
    await updates.check()
    expect(await updates.download()).toMatchObject({
      state: 'error',
      message: 'Could not download the update: sha512 checksum mismatch'
    })
    expect((await updates.check()).state).toBe('available')
  })

  it('does not touch the updater in a development run', async () => {
    const factory = vi.fn(() => fake as unknown as UpdaterLike)
    const updates = createUpdateService({
      events: { emit: () => undefined },
      log,
      currentVersion: '0.1.0',
      packaged: false,
      portable: false,
      updater: factory
    })
    expect((await updates.check()).state).toBe('unsupported')
    expect(factory).not.toHaveBeenCalled()
  })

  it('never downloads in the portable build', async () => {
    announce()
    const updates = service({ portable: true })
    expect(await updates.check()).toMatchObject({ state: 'available', manual: true })
    expect((await updates.download()).state).toBe('available')
    expect(fake.downloadUpdate).not.toHaveBeenCalled()
  })

  it('ignores steps out of order', async () => {
    const updates = service()
    expect((await updates.download()).state).toBe('idle')
    expect(updates.install().state).toBe('idle')
    expect(fake.quitAndInstall).not.toHaveBeenCalled()

    let finish!: () => void
    fake.checkForUpdates.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    const first = updates.check()
    await updates.check()
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    finish()
    await first
  })

  it('matches the repository electron-builder publishes to', () => {
    const yml = readFileSync('electron-builder.yml', 'utf8')
    expect(yml).toContain(`owner: ${UPDATE_REPO.owner}`)
    expect(yml).toContain(`repo: ${UPDATE_REPO.repo}`)
  })
})
