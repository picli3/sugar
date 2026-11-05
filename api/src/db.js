import { initGithubLinkDb } from './github-link/migration.js'
import { initSessionDb } from './auth/sessions.js'
import { migrateImageAccess } from './images/migration.js'
import { imageIds, recordImageReferences } from './images/references.js'
import { initAiDb } from './ai.js'
import { migrateLibraryOwnership } from './library/migration.js'
import pg from 'pg'
import { bootstrapAdmin } from './auth/bootstrap.js'
import crypto from 'node:crypto'
import { stringify } from './model.js'
import { replaceEmbeddedImages } from './images.js'
import { reportFailure } from './shared/logging.js'
import { initRegistrationDb } from './registration/repository.js'
import { initRecoveryDb } from './recovery/repository.js'
import { initGalleryPaginationDb } from './images/pagination.js'
import { initProjectPaginationDb } from './projects/pagination.js'
import { initBlockPaginationDb } from './blocks/pagination.js'
import { initImageStorage } from './images/quotas.js'
import { initDocumentStorage } from './document-storage/migration.js'
import { initTotalStorage } from './storage-total/migration.js'
import { initTrashDb } from './trash/repository.js'
import { initProfileDb } from './shared/identity.js'
import { initAccountClosureDb } from './account/closure.js'
import { initCategoryPaginationDb } from './categories/pagination.js'

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
pool.on('error', error => reportFailure('Database pool error', error))
export const q = (sql, args = []) => pool.query(sql, args)
// Use the same transaction boundary with the production pool or an isolated test pool.
export function createTransaction(connectionPool) {
  return async function transaction(fn) {
    const client = await connectionPool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn((sql, args = []) => client.query(sql, args))
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally { client.release() }
  }
}
export const transaction = createTransaction(pool)
export async function signingSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  await q("INSERT INTO settings(key,value) VALUES('jwt_secret',$1::jsonb) ON CONFLICT(key) DO NOTHING", [JSON.stringify(crypto.randomBytes(48).toString('base64url'))])
  return (await q("SELECT value FROM settings WHERE key='jwt_secret'")).rows[0].value
}
export async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('view','dev','Admin')), language text NOT NULL DEFAULT 'es', theme text NOT NULL DEFAULT 'light', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`)
  await q(`ALTER TABLE users ALTER COLUMN theme SET DEFAULT 'light'`)
  await initSessionDb(q)
  await initRegistrationDb(q)
  await initRecoveryDb(q)
  await q(`CREATE TABLE IF NOT EXISTS images (id uuid PRIMARY KEY, name text NOT NULL, mime text NOT NULL, data bytea NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)` )
  await q(`CREATE TABLE IF NOT EXISTS blocks (id uuid PRIMARY KEY, name text NOT NULL, latest_version integer NOT NULL DEFAULT 0, deleted_at timestamptz)`)
  await q(`CREATE TABLE IF NOT EXISTS block_categories (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, name_key text NOT NULL, parent_id uuid REFERENCES block_categories(id), deleted_at timestamptz)`)
  await q(`ALTER TABLE block_categories ADD COLUMN IF NOT EXISTS icon text`)
  await q(`UPDATE block_categories SET icon=CASE slug WHEN 'alimentacion' THEN 'power' WHEN 'controladores' THEN 'cpu' WHEN 'sensores' THEN 'sensor' ELSE 'cube' END WHERE parent_id IS NULL AND icon IS NULL`)
  await migrateLibraryOwnership(transaction)
  await initCategoryPaginationDb(q)
  await initBlockPaginationDb(q)
  await q(`ALTER TABLE blocks ADD COLUMN IF NOT EXISTS category_slug text`)
  await q(`ALTER TABLE blocks ADD COLUMN IF NOT EXISTS subcategory_slug text`)
  await q(`CREATE TABLE IF NOT EXISTS block_versions (block_id uuid NOT NULL REFERENCES blocks(id), version integer NOT NULL, yaml text NOT NULL, author_id uuid REFERENCES users(id), summary text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(block_id, version))`)
  await q(`CREATE TABLE IF NOT EXISTS projects (id uuid PRIMARY KEY, name text NOT NULL, revision integer NOT NULL DEFAULT 0, yaml text NOT NULL, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`)
  await q(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id)`)
  await q(`CREATE TABLE IF NOT EXISTS project_members (project_id uuid NOT NULL REFERENCES projects(id), user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('editor','reader')), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,user_id))`)
  await q('CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user_id,project_id)')
  await q(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('public','private'))`)
  await q(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS share_token text UNIQUE`)
  await q(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS sync_repository text`)
  await q(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS sync_branch text NOT NULL DEFAULT 'main'`)
  await q(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS settings_version integer NOT NULL DEFAULT 1`)
  await q(`CREATE TABLE IF NOT EXISTS project_revisions (project_id uuid NOT NULL REFERENCES projects(id), revision integer NOT NULL, yaml text NOT NULL, author_id uuid REFERENCES users(id), summary text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id, revision))`)
  await q(`UPDATE projects p SET created_by=(SELECT author_id FROM project_revisions r WHERE r.project_id=p.id ORDER BY revision LIMIT 1) WHERE p.created_by IS NULL`)
  await q(`CREATE TABLE IF NOT EXISTS project_settings_history (id bigserial PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), author_id uuid REFERENCES users(id), before jsonb NOT NULL, after jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`)
  await q('CREATE INDEX IF NOT EXISTS project_settings_history_page ON project_settings_history(project_id,id DESC)')
  await q(`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL)`)
  await q("INSERT INTO settings(key,value) VALUES('registration_schema_version','1'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  await q("INSERT INTO settings(key,value) VALUES('recovery_schema_version','1'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  await q(`CREATE TABLE IF NOT EXISTS sync_jobs (id bigserial PRIMARY KEY, kind text NOT NULL, record_id uuid NOT NULL, revision integer NOT NULL, yaml text NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, error text, next_attempt_at timestamptz NOT NULL DEFAULT now(), commit_sha text, created_at timestamptz NOT NULL DEFAULT now())`)
  await q(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS target_repository text`)
  await q(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS target_branch text`)
  await q(`UPDATE sync_jobs SET status='skipped',error='Configura un repositorio en el proyecto para sincronizar' WHERE kind='project' AND target_repository IS NULL AND status='pending'`)
  await q(`UPDATE sync_jobs SET status='skipped',error='La sincronización global de la biblioteca fue retirada' WHERE kind='block' AND status='pending'`)
  await initAiDb(q)
  await bootstrapAdmin({ transaction })
  await migrateImageAccess(transaction)
  await initGalleryPaginationDb(q)
  await initImageStorage(q)
  await initDocumentStorage(q)
  await initProjectPaginationDb(q)
  // Convert current documents once; historical revisions remain intact for audit.
  for (const row of (await q("SELECT id,revision,yaml,sync_repository,sync_branch,created_by FROM projects WHERE deleted_at IS NULL AND yaml LIKE '%data:image/%'")).rows) {
    await transaction(async tx => {
      const yaml = await replaceEmbeddedImages(row.yaml, 'project', tx, { ownerId: row.created_by, maintenance: true })
      if (yaml === row.yaml) return
      const revision = row.revision + 1
      await tx('UPDATE projects SET yaml=$2,revision=$3 WHERE id=$1', [row.id, yaml, revision])
      await tx('INSERT INTO project_revisions(project_id,revision,yaml,summary) VALUES($1,$2,$3,$4)', [row.id, revision, yaml, 'Imágenes trasladadas a la galería'])
      await recordImageReferences(tx, 'project', row.id, imageIds(yaml, 'project'))
    })
  }
  for (const row of (await q("SELECT b.id,b.latest_version,b.owner_id,v.yaml FROM blocks b JOIN block_versions v ON v.block_id=b.id AND v.version=b.latest_version WHERE b.deleted_at IS NULL AND v.yaml LIKE '%data:image/%'")).rows) {
    await transaction(async tx => {
      const yaml = await replaceEmbeddedImages(row.yaml, 'block', tx, { ownerId: row.owner_id, catalog: !row.owner_id, maintenance: true })
      if (yaml === row.yaml) return
      const version = row.latest_version + 1
      await tx('UPDATE blocks SET latest_version=$2 WHERE id=$1', [row.id, version])
      await tx('INSERT INTO block_versions(block_id,version,yaml,summary) VALUES($1,$2,$3,$4)', [row.id, version, yaml, 'Imagen trasladada a la galería'])
      await recordImageReferences(tx, 'block', row.id, imageIds(yaml, 'block'))
    })
  }
  const examples = await q('SELECT count(*)::int AS n FROM blocks')
  const categoryCount = await q('SELECT count(*)::int AS n FROM block_categories')
  if (categoryCount.rows[0].n === 0) {
    const roots = [
      ['sensores', 'Sensores', 'temperatura', 'Temperatura'],
      ['controladores', 'Controladores', 'mcu', 'MCU'],
      ['alimentacion', 'Alimentación', 'fuentes', 'Fuentes'],
    ]
    for (const [slug, name, childSlug, childName] of roots) {
      const id = crypto.randomUUID()
      await q('INSERT INTO block_categories(id,slug,name,name_key,icon) VALUES($1,$2,$3,$4,$5) ON CONFLICT(slug) DO NOTHING', [id, slug, name, name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(), { sensores: 'sensor', controladores: 'cpu', alimentacion: 'power' }[slug]])
      const root = (await q('SELECT id FROM block_categories WHERE slug=$1', [slug])).rows[0]
      await q('INSERT INTO block_categories(id,slug,name,name_key,parent_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(slug) DO NOTHING', [crypto.randomUUID(), childSlug, childName, childName.toLowerCase(), root.id])
    }
  }
  if (examples.rows[0].n === 0) {
    const templates = [
      { name: 'Sensor de temperatura', function: 'Medir temperatura', model: 'BME280', category: 'sensores', subcategory: 'temperatura', properties: { range: '-40..85 °C' }, ports: [{ id: 'i2c', label: 'I²C', protocol: 'I2C', direction: 'bidirectional', maxConnections: 1 }, { id: 'power', label: 'Alimentación', protocol: 'POWER', direction: 'in', maxConnections: 1 }] },
      { name: 'Controlador', function: 'Procesar lecturas', model: 'MCU genérico', category: 'controladores', subcategory: 'mcu', properties: {}, ports: [{ id: 'i2c', label: 'I²C', protocol: 'I2C', direction: 'bidirectional', maxConnections: 16 }, { id: 'spi', label: 'SPI', protocol: 'SPI', direction: 'bidirectional', maxConnections: 4 }, { id: 'uart', label: 'UART', protocol: 'UART', direction: 'bidirectional', maxConnections: 2 }, { id: 'power', label: 'Alimentación', protocol: 'POWER', direction: 'in', maxConnections: 1 }] },
      { name: 'Fuente de alimentación', function: 'Proveer energía', model: '', category: 'alimentacion', subcategory: 'fuentes', properties: { voltage: '3.3 V' }, ports: [{ id: 'power', label: 'Salida', protocol: 'POWER', direction: 'out', maxConnections: 20 }] }
    ]
    for (const b of templates) {
      const id = crypto.randomUUID()
      await q('INSERT INTO blocks(id,name,latest_version,category_slug,subcategory_slug) VALUES($1,$2,1,$3,$4)', [id, b.name, b.category, b.subcategory])
      await q('INSERT INTO block_versions(block_id,version,yaml,summary) VALUES($1,1,$2,$3)', [id, stringify(b), 'Bloque inicial'])
    }
  }
  await initTrashDb(q)
  await initProfileDb(q)
  await initAccountClosureDb(q)
  await initGithubLinkDb(q)
  await initTotalStorage(q, transaction)
}
