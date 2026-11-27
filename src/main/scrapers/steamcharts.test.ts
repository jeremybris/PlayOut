import { afterEach, describe, expect, it, vi } from 'vitest'

const httpJson = vi.fn()
vi.mock('./http', async (importOriginal) => {
  const real = await importOriginal<typeof import('./http')>()
  return {
    ...real,
    httpJson: (...args: unknown[]) => httpJson(...args),
    RateLimiter: class {
      take(): Promise<void> {
        return Promise.resolve()
      }
    }
  }
})

const { HttpError } = await import('./http')
const { peakOfChart, playersOfChart, steamChartsPeak, steamChartsPlayers, STEAMCHARTS_CHART_URL } =
  await import('./steamcharts')

afterEach(() => httpJson.mockReset())

describe('peakOfChart', () => {
  it('is the highest player count of the history', () => {
    expect(
      peakOfChart([
        [1643673600000, 807951],
        [1646092800000, 952523],
        [1794776561000, 23690]
      ])
    ).toBe(952523)
  })

  it('skips malformed points and is null without any usable one', () => {
    expect(peakOfChart([[1, 'x'], [2], null, [3, -5], [4, 12.6]])).toBe(13)
    expect(peakOfChart([])).toBeNull()
    expect(peakOfChart({ peak: 5 })).toBeNull()
    expect(peakOfChart([[1, Number.NaN]])).toBeNull()
  })
})

describe('steamChartsPeak', () => {
  it("reads the game's SteamCharts history", async () => {
    httpJson.mockResolvedValue([
      [1, 100],
      [2, 6731]
    ])
    expect(await steamChartsPeak(1245620)).toBe(6731)
    expect(httpJson.mock.calls[0]![0]).toBe(`${STEAMCHARTS_CHART_URL}/1245620/chart-data.json`)
  })

  it('is 0 for a game SteamCharts does not track (404) or has no points for', async () => {
    httpJson.mockRejectedValue(new HttpError('not found', { status: 404, url: 'x' }))
    expect(await steamChartsPeak(10)).toBe(0)
    httpJson.mockResolvedValue([])
    expect(await steamChartsPeak(10)).toBe(0)
  })

  it('is null when SteamCharts cannot be read, and for a bad app id', async () => {
    httpJson.mockRejectedValue(new HttpError('down', { status: 503, url: 'x' }))
    expect(await steamChartsPeak(10)).toBeNull()
    httpJson.mockRejectedValue(new Error('offline'))
    expect(await steamChartsPeak(10)).toBeNull()
    expect(await steamChartsPeak(0)).toBeNull()
    expect(await steamChartsPeak(1.5)).toBeNull()
  })
})

describe('playersOfChart', () => {
  it("is the last point's count and time, and the peak", () => {
    expect(
      playersOfChart([
        [1341100800000, 1642],
        [1795644122000, 667694],
        [1795651271000, 500886.4]
      ])
    ).toEqual({ current: 500886, at: new Date(1795651271000).toISOString(), peak: 667694 })
  })

  it('takes the last usable point, and has no current without a usable time', () => {
    expect(playersOfChart([[1000, 5], [2000, 7], [3000, 'x'], [Number.NaN, 9], [4000]])).toEqual({
      current: 7,
      at: new Date(2000).toISOString(),
      peak: 9
    })
    expect(playersOfChart([['when', 9]])).toEqual({ current: null, at: null, peak: 9 })
  })

  it('is null for garbage or a history without points', () => {
    expect(playersOfChart([])).toBeNull()
    expect(playersOfChart('<html>')).toBeNull()
    expect(playersOfChart({ current: 5 })).toBeNull()
    expect(playersOfChart([[1, -1], null])).toBeNull()
  })
})

describe('steamChartsPlayers', () => {
  it("reads the game's SteamCharts history once", async () => {
    httpJson.mockResolvedValue([
      [1000, 10],
      [2000, 4]
    ])
    expect(await steamChartsPlayers(730)).toEqual({
      current: 4,
      at: new Date(2000).toISOString(),
      peak: 10
    })
    expect(httpJson).toHaveBeenCalledTimes(1)
    expect(httpJson.mock.calls[0]![0]).toBe(`${STEAMCHARTS_CHART_URL}/730/chart-data.json`)
  })

  it('is untracked for a 404 or a history without points, null when it cannot be read', async () => {
    httpJson.mockRejectedValue(new HttpError('not found', { status: 404, url: 'x' }))
    expect(await steamChartsPlayers(10)).toBe('untracked')
    httpJson.mockResolvedValue([])
    expect(await steamChartsPlayers(10)).toBe('untracked')
    httpJson.mockRejectedValue(new HttpError('down', { status: 503, url: 'x' }))
    expect(await steamChartsPlayers(10)).toBeNull()
    httpJson.mockRejectedValue(new Error('offline'))
    expect(await steamChartsPlayers(10)).toBeNull()
    expect(await steamChartsPlayers(-3)).toBeNull()
  })

  it('never has two requests in flight at once', async () => {
    let active = 0
    let most = 0
    httpJson.mockImplementation(async () => {
      active++
      most = Math.max(most, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return [[1, 1]]
    })
    await Promise.all([steamChartsPlayers(1), steamChartsPeak(2), steamChartsPlayers(3)])
    expect(most).toBe(1)
    expect(httpJson).toHaveBeenCalledTimes(3)
  })
})
