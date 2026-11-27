import { describe, expect, it } from 'vitest'
import {
  VIDEO_CONTROLLER_SCRIPT,
  nvidiaDriverVersion,
  parseVideoControllers,
  primaryGpu,
  rtxSeriesOf
} from './gpu'

const intelB390 = {
  Name: 'Intel(R) Arc(TM) B390 GPU',
  PNPDeviceID: 'PCI\\VEN_8086&DEV_B080&SUBSYS_14B41043&REV_04\\3&11583659&0&10',
  DriverVersion: '32.0.101.9150',
  AdapterCompatibility: 'Intel Corporation',
  CurrentHorizontalResolution: 1920,
  ConfigManagerErrorCode: 0,
  DedicatedVideoMemory: '134217728',
  LocationInfo: 'PCI bus 0, device 2, function 0'
}

const rtx4070 = {
  Name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
  PNPDeviceID: 'PCI\\VEN_10DE&DEV_2820&SUBSYS_00000000&REV_A1\\4&1',
  DriverVersion: '31.0.15.6156',
  AdapterCompatibility: 'NVIDIA',
  CurrentHorizontalResolution: null,
  ConfigManagerErrorCode: 0,
  DedicatedVideoMemory: '8585740288',
  LocationInfo: 'PCI bus 1, device 0, function 0'
}

describe('parseVideoControllers', () => {
  it('reads a single object (one adapter) as well as an array', () => {
    const one = parseVideoControllers(JSON.stringify(intelB390))
    expect(one).toEqual([
      {
        vendor: 'intel',
        name: 'Intel(R) Arc(TM) B390 GPU',
        rtxSeries: null,
        driver: '32.0.101.9150'
      }
    ])
    expect(parseVideoControllers(JSON.stringify([intelB390, rtx4070]))).toHaveLength(2)
  })

  it('converts the NVIDIA driver version and reads the RTX series', () => {
    const [gpu] = parseVideoControllers(JSON.stringify([rtx4070]))
    expect(gpu).toEqual({
      vendor: 'nvidia',
      name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
      rtxSeries: 40,
      driver: '561.56'
    })
  })

  it('accepts JSON wrapped in a JSON string (a runner that converts output to JSON)', () => {
    const twice = JSON.stringify(JSON.stringify([rtx4070]))
    expect(parseVideoControllers(twice)).toHaveLength(1)
  })

  it('skips basic, virtual, non-PCI and failed adapters', () => {
    const rows = [
      { ...intelB390, ConfigManagerErrorCode: 22 },
      {
        Name: 'Microsoft Basic Display Adapter',
        PNPDeviceID: 'PCI\\VEN_1414&DEV_008C\\0',
        ConfigManagerErrorCode: 0
      },
      {
        Name: 'Virtual Display Driver',
        PNPDeviceID: 'ROOT\\DISPLAY\\0000',
        ConfigManagerErrorCode: 0
      },
      { Name: 'Parsec Virtual Display Adapter', PNPDeviceID: 'ROOT\\DISPLAY\\0001' }
    ]
    expect(parseVideoControllers(JSON.stringify(rows))).toEqual([])
  })

  it('gives an empty list for unreadable or empty output', () => {
    expect(parseVideoControllers('')).toEqual([])
    expect(parseVideoControllers('not json')).toEqual([])
    expect(parseVideoControllers('null')).toEqual([])
    expect(parseVideoControllers('[]')).toEqual([])
  })

  it('reads AMD vendor ids and keeps other drivers raw', () => {
    const [gpu] = parseVideoControllers(
      JSON.stringify({
        Name: 'AMD Radeon RX 7800 XT',
        PNPDeviceID: 'PCI\\VEN_1002&DEV_747E\\0',
        DriverVersion: '32.0.12011.1036'
      })
    )
    expect(gpu).toEqual({
      vendor: 'amd',
      name: 'AMD Radeon RX 7800 XT',
      rtxSeries: null,
      driver: '32.0.12011.1036'
    })
  })
})

describe('primaryGpu', () => {
  it('picks the NVIDIA card over the built-in graphics driving the screen', () => {
    const gpus = parseVideoControllers(JSON.stringify([intelB390, rtx4070]))
    expect(primaryGpu(gpus)?.vendor).toBe('nvidia')
  })

  it('picks a dedicated AMD card over Intel built-in graphics by memory', () => {
    const amd = {
      Name: 'AMD Radeon RX 6600M',
      PNPDeviceID: 'PCI\\VEN_1002&DEV_73FF\\0',
      DedicatedVideoMemory: String(8 * 1024 ** 3)
    }
    const gpus = parseVideoControllers(JSON.stringify([intelB390, amd]))
    expect(primaryGpu(gpus)?.name).toBe('AMD Radeon RX 6600M')
  })

  it('picks a discrete Intel Arc card over AMD built-in graphics by name when memory is unknown', () => {
    const apu = { Name: 'AMD Radeon(TM) 780M', PNPDeviceID: 'PCI\\VEN_1002&DEV_15BF\\0' }
    const arc = { Name: 'Intel(R) Arc(TM) B580 Graphics', PNPDeviceID: 'PCI\\VEN_8086&DEV_E20B\\0' }
    const gpus = parseVideoControllers(JSON.stringify([apu, arc]))
    expect(primaryGpu(gpus)?.vendor).toBe('intel')
  })

  it('prefers AMD over Intel among built-in graphics, then the one driving a display', () => {
    const apu = { Name: 'AMD Radeon(TM) Graphics', PNPDeviceID: 'PCI\\VEN_1002&DEV_1681\\0' }
    const igpu = { ...intelB390, DedicatedVideoMemory: null }
    expect(primaryGpu(parseVideoControllers(JSON.stringify([igpu, apu])))?.vendor).toBe('amd')
    const a = { ...apu, CurrentHorizontalResolution: 0 }
    const b = { ...apu, Name: 'AMD Radeon(TM) Graphics', CurrentHorizontalResolution: 2560 }
    const gpus = parseVideoControllers(JSON.stringify([a, b]))
    expect(primaryGpu(gpus)).toBe(gpus[1])
  })

  it('does not rank a Ryzen APU with a large BIOS frame buffer above the NVIDIA card', () => {
    const apu = {
      Name: 'AMD Radeon(TM) 780M Graphics',
      PNPDeviceID: 'PCI\\VEN_1002&DEV_15BF\\0',
      CurrentHorizontalResolution: 2560,
      DedicatedVideoMemory: String(8 * 1024 ** 3)
    }
    const nv = {
      Name: 'NVIDIA GeForce RTX 4050 Laptop GPU',
      PNPDeviceID: 'PCI\\VEN_10DE&DEV_28A1\\0',
      DedicatedVideoMemory: String(6 * 1024 ** 3)
    }
    expect(primaryGpu(parseVideoControllers(JSON.stringify([apu, nv])))?.rtxSeries).toBe(40)
    const noRow = { ...nv, DedicatedVideoMemory: null }
    expect(primaryGpu(parseVideoControllers(JSON.stringify([apu, noRow])))?.vendor).toBe('nvidia')
    const strix = { ...apu, Name: 'AMD Radeon(TM) 8060S Graphics' }
    const uhd = {
      Name: 'Intel(R) UHD Graphics 770',
      PNPDeviceID: 'PCI\\VEN_8086&DEV_4680\\0',
      DedicatedVideoMemory: String(16 * 1024 ** 3)
    }
    expect(primaryGpu(parseVideoControllers(JSON.stringify([strix, noRow])))?.vendor).toBe('nvidia')
    expect(primaryGpu(parseVideoControllers(JSON.stringify([uhd, noRow])))?.vendor).toBe('nvidia')
  })

  it('ranks an unknown AMD name by memory, but below a card known by name', () => {
    const unknown = {
      Name: 'AMD Radeon Mystery 9000',
      PNPDeviceID: 'PCI\\VEN_1002&DEV_7000\\0',
      DedicatedVideoMemory: String(12 * 1024 ** 3)
    }
    const uhd = { Name: 'Intel(R) UHD Graphics', PNPDeviceID: 'PCI\\VEN_8086&DEV_9A49\\0' }
    const gtx = { Name: 'NVIDIA GeForce GTX 1650', PNPDeviceID: 'PCI\\VEN_10DE&DEV_1F99\\0' }
    expect(primaryGpu(parseVideoControllers(JSON.stringify([uhd, unknown])))?.vendor).toBe('amd')
    expect(primaryGpu(parseVideoControllers(JSON.stringify([unknown, gtx])))?.vendor).toBe('nvidia')
  })

  it('knows Radeon VII and RX Vega cards by name, so a copied list still ranks them', () => {
    const vega = { Name: 'Radeon RX Vega 64', PNPDeviceID: 'PCI\\VEN_1002&DEV_687F\\0' }
    const vii = { Name: 'AMD Radeon VII', PNPDeviceID: 'PCI\\VEN_1002&DEV_66AF\\0' }
    const igpu = { ...intelB390, Name: 'Intel(R) UHD Graphics 630' }
    for (const card of [vega, vii]) {
      const gpus = parseVideoControllers(JSON.stringify([igpu, card]))
      const copied = structuredClone(gpus)
      expect(primaryGpu(copied)?.vendor).toBe('amd')
    }
  })

  it('loses memory, display and slot on a copied list (pass the parsed array itself)', () => {
    const unknown = {
      Name: 'AMD Radeon Mystery 9000',
      PNPDeviceID: 'PCI\\VEN_1002&DEV_7000\\0',
      DedicatedVideoMemory: String(12 * 1024 ** 3)
    }
    const arcIgpu = { ...intelB390, Name: 'Intel(R) Arc(TM) Pro Something' }
    const gpus = parseVideoControllers(JSON.stringify([arcIgpu, unknown]))
    expect(primaryGpu(gpus)?.vendor).toBe('amd')
    // A copy has no memory hint: both rank as built-in graphics and AMD wins on vendor alone.
    expect(primaryGpu(gpus.map((g) => ({ ...g })))?.vendor).toBe('amd')
    const a = { ...unknown, Name: 'AMD Radeon Mystery A', DedicatedVideoMemory: String(1024 ** 3) }
    const pair = parseVideoControllers(JSON.stringify([a, unknown]))
    expect(primaryGpu(pair)).toBe(pair[1])
    expect(primaryGpu(JSON.parse(JSON.stringify(pair)))?.name).toBe('AMD Radeon Mystery A')
  })

  it('works on GpuInfo objects it did not parse, and gives null for none', () => {
    expect(primaryGpu([])).toBeNull()
    const intel = {
      vendor: 'intel' as const,
      name: 'Intel(R) UHD Graphics',
      rtxSeries: null,
      driver: null
    }
    const nv = {
      vendor: 'nvidia' as const,
      name: 'NVIDIA GeForce GTX 1650',
      rtxSeries: null,
      driver: null
    }
    expect(primaryGpu([intel, nv])).toBe(nv)
  })
})

describe('nvidiaDriverVersion', () => {
  it('converts Windows driver versions', () => {
    expect(nvidiaDriverVersion('31.0.15.6156')).toBe('561.56')
    expect(nvidiaDriverVersion('32.0.15.7680')).toBe('576.80')
    expect(nvidiaDriverVersion('30.0.14.7212')).toBe('472.12')
    expect(nvidiaDriverVersion('31.0.15.560')).toBe('505.60')
  })

  it('gives null for anything else', () => {
    expect(nvidiaDriverVersion('')).toBeNull()
    expect(nvidiaDriverVersion('561.56')).toBeNull()
    expect(nvidiaDriverVersion('31.0.x.6156')).toBeNull()
  })
})

describe('rtxSeriesOf', () => {
  it.each([
    ['NVIDIA GeForce RTX 2060', 20],
    ['NVIDIA GeForce RTX 3080 Ti', 30],
    ['NVIDIA GeForce RTX 4070 Laptop GPU', 40],
    ['NVIDIA GeForce RTX 5090', 50],
    ['NVIDIA TITAN RTX', 20],
    ['Quadro RTX 4000', 20],
    ['NVIDIA RTX A4000', 30],
    ['NVIDIA RTX 2000 Ada Generation', 40],
    ['NVIDIA RTX PRO 6000 Blackwell Workstation Edition', 50],
    ['NVIDIA GeForce GTX 1660 SUPER', null],
    ['NVIDIA GeForce MX450', null],
    ['NVIDIA GeForce RTX 6090', null]
  ])('%s -> %s', (name, series) => {
    expect(rtxSeriesOf(name)).toBe(series)
  })
})

describe('VIDEO_CONTROLLER_SCRIPT', () => {
  it('prints a JSON array of the fields parseVideoControllers reads', () => {
    expect(VIDEO_CONTROLLER_SCRIPT).toContain('Win32_VideoController')
    expect(VIDEO_CONTROLLER_SCRIPT).toContain('ConvertTo-Json -InputObject $out')
    for (const field of ['PNPDeviceID', 'DriverVersion', 'DedicatedVideoMemory', 'LocationInfo']) {
      expect(VIDEO_CONTROLLER_SCRIPT).toContain(field)
    }
  })
})
