import type { UpdateStatus } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { updateView } from './updates'

const base: UpdateStatus = {
  state: 'idle',
  currentVersion: '0.1.0',
  manual: false,
  releaseUrl: 'https://github.com/o/r/releases/latest'
}

describe('updateView', () => {
  it('offers the check when nothing is going on', () => {
    expect(updateView(base)).toMatchObject({ label: 'Check for Updates', action: 'check' })
    expect(updateView({ ...base, state: 'up-to-date' }).text).toBe(
      'PlayOut 0.1.0 is the latest version.'
    )
    expect(updateView({ ...base, state: 'error', message: 'Could not' })).toMatchObject({
      action: 'check',
      text: 'Could not',
      progress: null
    })
  })

  it('shows the bar with the download figures and takes no action meanwhile', () => {
    expect(
      updateView({
        ...base,
        state: 'downloading',
        version: '0.2.0',
        percent: 41.6,
        bytesDone: 50 * 1024 * 1024,
        bytesTotal: 120 * 1024 * 1024,
        bytesPerSecond: 3 * 1024 * 1024
      })
    ).toEqual({
      label: 'Downloading 42%',
      action: null,
      text: 'Downloading version 0.2.0 · 50.0 MB of 120.0 MB · 3.0 MB/s',
      progress: 41.6
    })
    expect(updateView({ ...base, state: 'checking' }).progress).toBe('indeterminate')
  })

  it('follows the steps of an update', () => {
    const version = '0.2.0'
    expect(updateView({ ...base, state: 'available', version }).action).toBe('download')
    expect(updateView({ ...base, state: 'downloaded', version })).toMatchObject({
      action: 'install',
      progress: 100
    })
    expect(updateView({ ...base, state: 'available', version, manual: true }).action).toBe(
      'release'
    )
  })
})
