import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'
import sharp from 'sharp'
import { normalizeImage } from './normalization.js'
import { imageBytes, replaceEmbeddedImages } from '../images.js'
import { documentLimits, stringify } from '../model.js'
import { createImageService } from './service.js'

const create = (width = 3, height = 2) => sharp({ create: { width, height, channels: 4, background: { r: 32, g: 128, b: 224, alpha: 0.5 } } })
const oldPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6X6sAAAAASUVORK5CYII=', 'base64')

test('accepted formats decode fully, rotate EXIF orientation and strip source metadata', async () => {
  for (const format of ['png','jpeg','webp']) {
    const source = await create().withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: 'Synthetic author', Copyright: 'Synthetic private metadata' } }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">fixture</x:xmpmeta>').toFormat(format).toBuffer()
    const mime = 'image/' + format, output = await normalizeImage(mime, imageBytes(mime, source.toString('base64')))
    const metadata = await sharp(output).metadata()
    assert.equal(metadata.format, format); assert.equal(metadata.width, 2); assert.equal(metadata.height, 3)
    for (const field of ['exif','xmp','icc','iptc','orientation']) assert.equal(metadata[field], undefined)
    if (format !== 'jpeg') {
      assert.equal(metadata.hasAlpha, true)
      const alpha = await sharp(output).extractChannel('alpha').raw().toBuffer()
      assert.ok(alpha.every(value => value === 128))
    }
    assert.equal(output.includes(Buffer.from('Synthetic author')), false)
    assert.equal(output.includes(Buffer.from('Synthetic private metadata')), false)
  }
})

test('signatures alone, corrupt/truncated pixels, fake MIME and unsupported input are rejected safely', async () => {
  for (const format of ['png','jpeg','webp']) {
    const valid = await create().toFormat(format).toBuffer()
    for (const bad of [valid.subarray(0, 16), valid.subarray(0, Math.floor(valid.length / 2))]) {
      await assert.rejects(normalizeImage('image/' + format, bad), error => error.status === 400 && error.message.includes('Cannot decode image'))
    }
  }
  await assert.rejects(normalizeImage('image/png', oldPng), { status: 400 })
  await assert.rejects(normalizeImage('image/jpeg', await create().png().toBuffer()), { status: 400 })
  for (const data of ['not base64', 'A'.repeat(Math.ceil(documentLimits.imageBytes / 3) * 4 + 4)]) assert.throws(() => imageBytes('image/png', data), { status: 400 })
  assert.throws(() => imageBytes('image/svg+xml', Buffer.from('<svg/>').toString('base64')), { status: 400 })
})

test('dimension and pixel budgets reject small compressed excesses and accept exact boundaries', async () => {
  for (const [width, height] of [[4097,1],[1,4097],[2001,2000]]) {
    const source = await create(width, height).png().toBuffer()
    assert.ok(source.length < documentLimits.imageBytes)
    await assert.rejects(normalizeImage('image/png', source), { status: 413 })
  }
  for (const [width, height] of [[4096,1],[2000,2000]]) {
    const output = await normalizeImage('image/png', await create(width, height).png().toBuffer())
    const metadata = await sharp(output).metadata()
    assert.equal(metadata.width, width); assert.equal(metadata.height, height)
  }
})

test('animations are explicitly rejected rather than silently retaining only the first frame', async () => {
  const frames = await Promise.all([create().png().toBuffer(), create().negate({ alpha: false }).png().toBuffer()])
  const webp = await sharp(frames, { join: { animated: true } }).webp().toBuffer()
  await assert.rejects(normalizeImage('image/webp', webp), error => error.status === 400 && error.message.includes('animations'))
  const png = frames[0], chunk = Buffer.alloc(20)
  chunk.writeUInt32BE(8); chunk.write('acTL', 4); chunk.writeUInt32BE(2, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4,16)),16)
  const apng = Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)])
  await assert.rejects(normalizeImage('image/png', apng), error => error.status === 400 && error.message.includes('animations'))
})

test('normalization has bounded admission and releases capacity after successful and failed jobs', async () => {
  const png = await create().png().toBuffer()
  const results = await Promise.allSettled([normalizeImage('image/png',png), normalizeImage('image/png',oldPng), normalizeImage('image/png',png)])
  assert.deepEqual(results.map(result => result.status === 'rejected' ? result.reason.status : 200), [200,400,429])
  assert.ok(await normalizeImage('image/png',png))
})

test('a valid packed input that expands past the stored-byte budget is rejected without truncation', async () => {
  const pixels = Buffer.alloc(1980 * 2000)
  let seed = 123456
  for (let i = 0; i < pixels.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[i] = (seed & 3) * 85 }
  const source = await sharp(pixels, { raw: { width: 1980, height: 2000, channels: 1 } }).png({ palette: true, colours: 4 }).toBuffer()
  assert.ok(source.length < documentLimits.imageBytes)
  await assert.rejects(normalizeImage('image/png', source), error => error.status === 413 && error.message.includes('Normalized image exceeds'))
})

test('runtime restores reject corrupt legacy content while maintenance conserves its original bytes', async () => {
  const block = { name: 'Fixture', function: '', ports: [], image: 'data:image/png;base64,' + oldPng.toString('base64') }, writes = []
  await assert.rejects(replaceEmbeddedImages(stringify(block), 'block', async (...args) => writes.push(args)), { status: 400 })
  assert.equal(writes.length, 0)
  const yaml = await replaceEmbeddedImages(stringify(block), 'block', async (...args) => writes.push(args), { maintenance: true })
  assert.match(yaml, /\/api\/images\//)
  assert.deepEqual(writes[0][1][3], oldPng)
})

test('authorization precedes decoding; uploads cannot request the maintenance bypass and stored bytes are normalized', async () => {
  let stored, admitted
  const images = { create: async (...args) => { stored = args; return {} } }, storage = { create: async (_owner, size, write) => { admitted = size; return write(() => {}) } }
  const service = createImageService(images, storage), bad = { name: 'Fixture', mime: 'image/png', data: oldPng.toString('base64'), maintenance: true }
  await assert.rejects(service.create({ id: 'a', role: 'view' }, bad), { status: 403 })
  await assert.rejects(service.create({ id: 'a', role: 'dev' }, { ...bad, scope: 'catalog' }), { status: 403 })
  await assert.rejects(service.create({ id: 'a', role: 'dev' }, bad), { status: 400 })
  assert.equal(stored, undefined)
  const source = await create().withExif({ IFD0: { Artist: 'Synthetic author' } }).png().toBuffer()
  await service.create({ id: 'a', role: 'dev' }, { ...bad, data: source.toString('base64') })
  assert.equal(admitted, stored[3].length); assert.equal(stored[5], 'a'); assert.equal(stored[6], 'personal')
  assert.equal((await sharp(stored[3]).metadata()).exif, undefined)
})
