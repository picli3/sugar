import { defaultDocumentStorage } from './config.js'
export async function initDocumentStorage(q) {
  await q('CREATE TABLE IF NOT EXISTS document_storage_config(id boolean PRIMARY KEY DEFAULT true CHECK(id),value jsonb NOT NULL,version integer NOT NULL DEFAULT 1)')
  await q('INSERT INTO document_storage_config(id,value) VALUES(true,$1::jsonb) ON CONFLICT(id) DO NOTHING', [JSON.stringify(defaultDocumentStorage)])
  await q('CREATE INDEX IF NOT EXISTS projects_storage_owner ON projects(created_by)')
  await q('CREATE INDEX IF NOT EXISTS blocks_storage_owner ON blocks(owner_id)')
  await q('CREATE INDEX IF NOT EXISTS sync_jobs_storage_resource ON sync_jobs(kind,record_id)')
  await q('CREATE INDEX IF NOT EXISTS categories_storage_owner ON block_categories(owner_id)')
}
