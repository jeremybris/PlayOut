// The suggestion relay's limits are written down in three places that cannot import one another (the deployed
// wrangler.toml, the relay's defaults, the number PlayOut tells its user): they have to say the same.
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { RELAY_SUGGESTIONS_PER_HOUR } from '../../shared/metadata-cloud'

const RELAY = resolve(__dirname, '../../../metadata-relay')
const read = (path: string): string => readFileSync(resolve(RELAY, path), 'utf8')

/** A number a source file states as `name: 12`, `name = 12` or `name = "12"`. */
function stated(text: string, name: string): number {
  const m = text.match(new RegExp(`^\\s*(?:export const )?${name}\\s*[:=]\\s*"?(\\d+)"?`, 'm'))
  if (!m) throw new Error(`${name} not found`)
  return Number(m[1])
}

describe('suggestion relay limits', () => {
  const deployed = read('wrangler.toml')

  it('the relay defaults to the limits it is deployed with', () => {
    const defaults = read('src/ratelimit.ts')
    expect({
      ip: stated(defaults, 'ipPerHour'),
      ip48: stated(defaults, 'ip48PerHour'),
      client: stated(defaults, 'clientPerHour'),
      global: stated(defaults, 'globalPerHour'),
      open: stated(read('src/index.ts'), 'DEFAULT_MAX_OPEN_SUGGESTIONS')
    }).toEqual({
      ip: stated(deployed, 'RATE_IP_PER_HOUR'),
      ip48: stated(deployed, 'RATE_IP48_PER_HOUR'),
      client: stated(deployed, 'RATE_CLIENT_PER_HOUR'),
      global: stated(deployed, 'RATE_GLOBAL_PER_HOUR'),
      open: stated(deployed, 'MAX_OPEN_SUGGESTIONS')
    })
  })

  it('PlayOut tells its user the per-install limit the relay enforces', () => {
    expect(RELAY_SUGGESTIONS_PER_HOUR).toBe(stated(deployed, 'RATE_CLIENT_PER_HOUR'))
  })
})
