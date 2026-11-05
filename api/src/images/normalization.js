import sharp from 'sharp'
import { documentLimits } from '../model.js'
import { error } from '../shared/http.js'

sharp.cache(false)
sharp.concurrency(1)
const formats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }
const tooLarge = () => error(413, 'Imagen demasiado grande: máximo 4096 por lado y 4 millones de píxeles / Image too large: 4096 per side and 4 million pixels maximum')
let active = 0

// APNG can otherwise be decoded as just its first frame. Inspect chunk names,
// not arbitrary compressed bytes; full pixel validation belongs to the decoder.
function animatedPng(bytes) {
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(at)
    if (bytes.toString('ascii', at + 4, at + 8) === 'acTL') return true
    if (length > bytes.length - at - 12) break
    at += length + 12
  }
  return false
}

export async function normalizeImage(mime, bytes) {
  if (active >= documentLimits.imageConcurrent) throw Object.assign(Error('Procesamiento de imágenes ocupado; vuelve a intentar / Image processing busy; try again'), { status: 429, retryAfter: 1 })
  active++
  try {
    if (!formats[mime] || !Buffer.isBuffer(bytes) || bytes.length > documentLimits.imageBytes) error(400, 'Imagen inválida / Invalid image')
    // Metadata reads parse headers without allocating a decoded pixel image.
    const metadata = await sharp(bytes, { failOn: 'warning', limitInputPixels: documentLimits.imagePixels }).metadata()
    if (metadata.format !== formats[mime]) error(400, 'El contenido no coincide con el tipo de imagen / Content does not match image type')
    const { width, height } = metadata
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) error(400, 'Dimensiones inválidas / Invalid dimensions')
    if (width > documentLimits.imageSide || height > documentLimits.imageSide || width * height > documentLimits.imagePixels) tooLarge()
    if ((metadata.pages || 1) > 1 || (mime === 'image/png' && animatedPng(bytes))) error(400, 'Usa una imagen estática; no se admiten animaciones / Use a static image; animations are not supported')
    const output = await sharp(bytes, { failOn: 'warning', limitInputPixels: documentLimits.imagePixels })
      .rotate().toColourspace('srgb').toFormat(formats[mime], mime === 'image/png' ? { compressionLevel: 6 } : { quality: 90 }).timeout({ seconds: 5 }).toBuffer()
    if (output.length > documentLimits.imageBytes) error(413, 'La imagen normalizada supera 1 MB; reduce resolución o complejidad / Normalized image exceeds 1 MB; reduce resolution or complexity')
    return output
  } catch (e) {
    if (e.status) throw e
    if (/exceeds pixel limit/i.test(e.message || '')) tooLarge()
    error(400, 'No se pudo decodificar la imagen; archivo corrupto o incompleto / Cannot decode image; corrupt or incomplete file')
  } finally { active-- }
}
