// Synthetic disc images for tests (disc-id, texture packs): tiny ISO 9660 volumes with chosen files, no game data.

const SECTOR = 2048

function dirRecord(name: string, lba: number, size: number, dir: boolean): Buffer {
  const nameBytes = Buffer.from(name, 'latin1')
  let len = 33 + nameBytes.length
  if (len % 2) len++
  const r = Buffer.alloc(len)
  r[0] = len
  r.writeUInt32LE(lba, 2)
  r.writeUInt32BE(lba, 6)
  r.writeUInt32LE(size, 10)
  r.writeUInt32BE(size, 14)
  r[25] = dir ? 2 : 0
  r[32] = nameBytes.length
  nameBytes.copy(r, 33)
  return r
}

/**
 * An ISO 9660 image (2048-byte sectors) holding `files`, by path ('SYSTEM.CNF', 'PSP_GAME/PARAM.SFO'; one folder
 * level at most). `sectors`: the image's length.
 */
export function syntheticIso(files: Record<string, Buffer | string>, sectors = 64): Buffer {
  const img = Buffer.alloc(sectors * SECTOR)
  let next = 18
  const alloc = (bytes: number): number => {
    const at = next
    next += Math.max(1, Math.ceil(bytes / SECTOR))
    return at
  }
  const rootLba = alloc(SECTOR)
  const folders = new Map<string, { lba: number; records: Buffer[] }>()
  const root: Buffer[] = [
    dirRecord('\0', rootLba, SECTOR, true),
    dirRecord('\x01', rootLba, SECTOR, true)
  ]
  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content, 'latin1') : content
    const parts = path.split('/')
    let records = root
    if (parts.length === 2) {
      let folder = folders.get(parts[0])
      if (!folder) {
        const lba = alloc(SECTOR)
        folder = {
          lba,
          records: [dirRecord('\0', lba, SECTOR, true), dirRecord('\x01', rootLba, SECTOR, true)]
        }
        folders.set(parts[0], folder)
        root.push(dirRecord(parts[0], lba, SECTOR, true))
      }
      records = folder.records
    }
    const lba = alloc(data.length)
    data.copy(img, lba * SECTOR)
    records.push(dirRecord(`${parts[parts.length - 1]};1`, lba, data.length, false))
  }
  Buffer.concat(root).copy(img, rootLba * SECTOR)
  for (const folder of folders.values())
    Buffer.concat(folder.records).copy(img, folder.lba * SECTOR)
  const pvd = img.subarray(16 * SECTOR)
  pvd[0] = 1
  pvd.write('CD001', 1, 'latin1')
  pvd[6] = 1
  dirRecord('\0', rootLba, SECTOR, true).copy(pvd, 156)
  const end = img.subarray(17 * SECTOR)
  end[0] = 255
  end.write('CD001', 1, 'latin1')
  end[6] = 1
  return img
}

/** The same image as raw CD frames: 2352 bytes each (sync, header, Mode 2 Form 1 user data at 24), or Mode 1 (16). */
export function rawCdImage(iso: Buffer, mode: 1 | 2 = 2, frame = 2352): Buffer {
  const count = iso.length / SECTOR
  const out = Buffer.alloc(count * frame)
  for (let i = 0; i < count; i++) {
    const f = out.subarray(i * frame, (i + 1) * frame)
    f.fill(255, 1, 11)
    f[15] = mode
    iso.copy(f, mode === 2 ? 24 : 16, i * SECTOR, (i + 1) * SECTOR)
  }
  return out
}

/** A PARAM.SFO with these text values (PSP / PS3 game info). */
export function syntheticSfo(values: Record<string, string>): Buffer {
  const entries = Object.entries(values)
  const keyTable = 20 + entries.length * 16
  const keys = Buffer.concat(entries.map(([k]) => Buffer.from(`${k}\0`, 'latin1')))
  const dataTable = keyTable + keys.length + ((4 - ((keyTable + keys.length) % 4)) % 4)
  const datas = entries.map(([, v]) => {
    const raw = Buffer.from(`${v}\0`, 'latin1')
    const padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4)
    raw.copy(padded)
    return padded
  })
  const out = Buffer.alloc(dataTable + datas.reduce((s, d) => s + d.length, 0))
  out.writeUInt32BE(0x00505346, 0)
  out.writeUInt32LE(0x101, 4)
  out.writeUInt32LE(keyTable, 8)
  out.writeUInt32LE(dataTable, 12)
  out.writeUInt32LE(entries.length, 16)
  let keyAt = 0
  let dataAt = 0
  entries.forEach(([k], i) => {
    const at = 20 + i * 16
    out.writeUInt16LE(keyAt, at)
    out.writeUInt16LE(0x0204, at + 2)
    out.writeUInt32LE(Buffer.byteLength(values[k], 'latin1') + 1, at + 4)
    out.writeUInt32LE(datas[i].length, at + 8)
    out.writeUInt32LE(dataAt, at + 12)
    keyAt += k.length + 1
    datas[i].copy(out, dataTable + dataAt)
    dataAt += datas[i].length
  })
  keys.copy(out, keyTable)
  return out
}

/** A GameCube (or Wii) disc header with this GameID. */
export function gameCubeHeader(id: string, wii = false): Buffer {
  const head = Buffer.alloc(0x440)
  head.write(id, 0, 'latin1')
  if (wii) head.writeUInt32BE(0x5d1c9ea3, 0x18)
  else head.writeUInt32BE(0xc2339f3d, 0x1c)
  return head
}
