import { defaultImageStorage } from '../src/images/quotas.js'
import { defaultDocumentStorage } from '../src/document-storage/config.js'
export const readyRow = value => ({ value, image_limits: defaultImageStorage, image_version: 1, document_limits: defaultDocumentStorage, document_version: 1, ai_storage_ready: true })
