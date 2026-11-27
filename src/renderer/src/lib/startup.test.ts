import { describe, expect, it, vi } from 'vitest'
import { isolatedStep } from './startup'

describe('isolatedStep', () => {
  it('resolves to the step result', async () => {
    const onError = vi.fn()
    expect(await isolatedStep('a', () => 1, onError)).toBe(1)
    expect(await isolatedStep('b', async () => 'x', onError)).toBe('x')
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a rejection and resolves to undefined', async () => {
    const onError = vi.fn()
    const err = new Error('ipc down')
    expect(await isolatedStep('streaming', () => Promise.reject(err), onError)).toBeUndefined()
    expect(onError).toHaveBeenCalledWith('streaming', err)
  })

  it('reports a synchronous throw and resolves to undefined', async () => {
    const onError = vi.fn()
    const err = new Error('not a function')
    const run = (): number => {
      throw err
    }
    expect(await isolatedStep('offers', run, onError)).toBeUndefined()
    expect(onError).toHaveBeenCalledWith('offers', err)
  })

  it('survives a reporter that throws', async () => {
    const onError = (): void => {
      throw new Error('log failed')
    }
    await expect(isolatedStep('x', () => Promise.reject(new Error('no')), onError)).resolves.toBe(
      undefined
    )
  })

  it('keeps a chain going: the steps after and beside a failed one still run', async () => {
    const ran: string[] = []
    const failed: string[] = []
    const step = <T>(label: string, run: () => T | Promise<T>): Promise<T | undefined> =>
      isolatedStep(label, run, (name) => failed.push(name))
    const ok = (name: string) => async (): Promise<string> => {
      ran.push(name)
      return name
    }
    const hosts = await step('settings', ok('settings'))
      .then(() =>
        Promise.all([
          step('library', ok('library')),
          step('streaming', () => Promise.reject(new Error('no'))),
          step('installs', ok('installs'))
        ])
      )
      .then(() =>
        step('offers', (): Promise<void> => {
          throw new Error('sync')
        })
      )
      .then(() => step('held', ok('held')))
      .then(() => step('hosts', ok('hosts')))
    expect(ran).toEqual(['settings', 'library', 'installs', 'held', 'hosts'])
    expect(failed).toEqual(['streaming', 'offers'])
    expect(hosts).toBe('hosts')
  })
})
