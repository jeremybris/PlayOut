import type { ControllerWakeStatus } from '@shared/controller-wake'
import { describe, expect, it } from 'vitest'
import { controllerWakeText, showControllerWakeText } from './controllerWakeText'

const A = 'Xbox Wireless Adapter for Windows'
const status = (patch: Partial<ControllerWakeStatus> = {}): ControllerWakeStatus => ({
  enabled: true,
  capable: [],
  armed: [],
  programmable: [],
  readable: true,
  adapter: false,
  step: 'idle',
  ...patch
})

describe('controllerWakeText', () => {
  it('names the devices that wake the PC, and one Windows did not allow beside them', () => {
    expect(controllerWakeText(status({ armed: [A], programmable: [A] }))).toBe(
      `Wakes the PC: ${A}.`
    )
    expect(
      controllerWakeText(
        status({ armed: [A], programmable: [A, 'Xbox Controller'], step: 'failed' })
      )
    ).toMatch(/^Wakes the PC: .*Windows did not allow Xbox Controller/)
  })
  it('says what to do when nothing can wake it, the lists are unknown, or a prompt was declined', () => {
    expect(controllerWakeText(status())).toMatch(/No Xbox Wireless Adapter/)
    expect(controllerWakeText(status({ adapter: true }))).toMatch(/does not list it as able/)
    expect(controllerWakeText(status({ readable: false }))).toMatch(/could not be read/)
    expect(controllerWakeText(status({ step: 'declined' }))).toMatch(/off and on again/)
    expect(controllerWakeText(status({ step: 'working' }))).toMatch(/approval/)
  })
  it('while off, shows only a step to report', () => {
    expect(showControllerWakeText(status({ enabled: false }))).toBe(false)
    expect(showControllerWakeText(status({ enabled: false, step: 'failed' }))).toBe(true)
    expect(controllerWakeText(status({ enabled: false, step: 'declined' }))).toMatch(
      /on and off again/
    )
  })
})
