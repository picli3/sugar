import { defaultImageStorage } from '../src/images/quotas.js'
import { defaultDocumentStorage } from '../src/document-storage/config.js'
import { defaultTotalStorage } from '../src/storage-total/config.js'
import { totalStorageTables } from '../src/storage-total/migration.js'
export const readyRow = value => ({ value, image_limits: defaultImageStorage, image_version: 1, document_limits: defaultDocumentStorage, document_version: 1, total_limits: defaultTotalStorage, total_version: 1, total_usage_ready: true, total_triggers: totalStorageTables.length, block_catalog_ready: true, ai_storage_ready: true, mfa_sessions_ready: true, github_ready: true })
