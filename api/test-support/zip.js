import assert from 'node:assert/strict'
import zlib from 'node:zlib'

// Minimal reader: walks the central directory and inflates each entry, verifying CRCs.
export function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'end of central directory')
  const count = buffer.readUInt16LE(end + 10), start = buffer.readUInt32LE(end + 16), entries = new Map()
  let at = start
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50)
    const crc = buffer.readUInt32LE(at + 16), compressed = buffer.readUInt32LE(at + 20), nameLength = buffer.readUInt16LE(at + 28), local = buffer.readUInt32LE(at + 42)
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    assert.equal(buffer.readUInt32LE(local), 0x04034b50)
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const data = zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressed))
    assert.equal(zlib.crc32(data), crc, name)
    entries.set(name, data)
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32)
  }
  return entries
}

