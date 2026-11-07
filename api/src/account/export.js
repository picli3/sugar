import { error } from '../shared/http.js'
import { person, people } from '../shared/identity.js'
import { createZipWriter } from './zip.js'

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const json = value => JSON.stringify(value, null, 2) + '\n'
const readme = `Sugar — exportación de cuenta / account export

account.json        Datos de la cuenta, sesiones (sin identificadores) / account data, sessions (no identifiers)
collaborations.json Proyectos ajenos en los que colaboras (sólo metadatos) / other people's projects you collaborate on (metadata only)
security-log.json   Tu registro de operaciones sensibles (180 días) / your sensitive-operation log (180 days)
github.json         Cuenta GitHub y destinos propios, sin credenciales / own GitHub account and targets, no credentials
categories.json     Tus categorías / your categories
projects/<id>/      Tus proyectos: current.yaml, revisions/<n>.yaml, revisions.json, settings-history.json, members.json, analyses/<id>.json
blocks/<id>/        Tus bloques personales: block.json, versions/<n>.yaml, versions.json
schematics/         Esquemas de tus bloques y proyectos / schematics in your blocks and projects
images/             Tus imágenes personales (images.json + archivos) / your personal images

"trashed_at" marca elementos en la papelera / marks items in the trash.
No incluye contraseñas, sesiones activas, secretos MFA o GitHub, enlaces privados ni correos de otras personas, salvo los colaboradores que invitaste.
Excludes passwords, active session identifiers, MFA or GitHub secrets, private share links and other people's emails, except collaborators you invited.
`

// Exports only what the account owns or is shown about itself, read in one consistent snapshot.
export function createAccountExport({ transaction, maxConcurrent = 2 }) {
  const running = new Set()
  return {
    begin(user) {
      if (!user) error(401, 'Sesión requerida')
      if (running.has(user.id)) error(429, 'Ya hay una exportación en curso / An export is already running')
      if (running.size >= maxConcurrent) throw Object.assign(new Error('Demasiadas exportaciones simultáneas; inténtalo en un minuto / Too many concurrent exports; try again in a minute'), { status: 429, retryAfter: 60 })
      running.add(user.id)
      return () => running.delete(user.id)
    },
    async write(user, write, now = new Date()) {
      const zip = createZipWriter(write)
      await transaction(async tx => {
        await tx('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        const rows = async (sql, args) => (await tx(sql, args)).rows
        const [account] = await rows('SELECT id,email,role,language,theme,display_name,created_at,email_verified_at FROM users WHERE id=$1 AND active=true', [user.id])
        if (!account) error(404, 'Cuenta no encontrada')
        const sessions = await rows('SELECT created_at,expires_at,revoked_at FROM user_sessions WHERE user_id=$1 ORDER BY created_at', [user.id])
        await zip.add('README.txt', readme, now)
        await zip.add('account.json', json({ exported_at: now.toISOString(), account, sessions }), now)
        await zip.add('security-log.json', json(await rows(`SELECT at,request_id,operation,result,status,resource FROM audit_events
          WHERE actor=$1 ORDER BY id`, [user.id])), now)
        await zip.add('github.json', json({
          account: (await rows('SELECT github_user_id,github_login,created_at,updated_at FROM github_links WHERE user_id=$1 AND access_box IS NOT NULL', [user.id]))[0] || null,
          destinations: await rows(`SELECT g.project_id,g.installation_id,g.repository_id,g.repository,g.branch,g.allow_public,g.created_at
            FROM github_project_grants g JOIN projects p ON p.id=g.project_id WHERE p.created_by=$1 AND g.owner_id=$1 ORDER BY g.project_id`, [user.id]),
        }), now)
        await zip.add('collaborations.json', json(await rows(`SELECT m.project_id,p.name,m.role,m.created_at FROM project_members m
          JOIN projects p ON p.id=m.project_id WHERE m.user_id=$1 AND p.deleted_at IS NULL ORDER BY m.created_at,m.project_id`, [user.id])), now)
        await zip.add('categories.json', json(await rows(`SELECT id,slug,name,parent_id,icon,deleted_at AS trashed_at FROM block_categories
          WHERE owner_id=$1 ORDER BY parent_id NULLS FIRST,name_key,id`, [user.id])), now)
        const author = alias => `${alias}.author_id,u.display_name AS author_name,u.email AS author_email`
        for (const project of await rows(`SELECT id,name,revision,visibility,sync_repository,sync_branch,created_at,deleted_at AS trashed_at,yaml
          FROM projects WHERE created_by=$1 ORDER BY created_at,id`, [user.id])) {
          const base = `projects/${project.id}/`, { yaml, ...metadata } = project
          await zip.add(base + 'project.json', json(metadata), now)
          await zip.add(base + 'current.yaml', yaml, now)
          const revisions = []
          for (const { revision } of await rows('SELECT revision FROM project_revisions WHERE project_id=$1 ORDER BY revision', [project.id])) {
            const [row] = await rows(`SELECT r.revision,r.summary,r.created_at,r.yaml,${author('r')} FROM project_revisions r LEFT JOIN users u ON u.id=r.author_id WHERE r.project_id=$1 AND r.revision=$2`, [project.id, revision])
            const { yaml: content, ...info } = person(row, user, 'author')
            revisions.push(info)
            await zip.add(`${base}revisions/${revision}.yaml`, content, row.created_at)
          }
          await zip.add(base + 'revisions.json', json(revisions), now)
          await zip.add(base + 'settings-history.json', json(people(await rows(`SELECT h.before,h.after,h.created_at,${author('h')} FROM project_settings_history h
            LEFT JOIN users u ON u.id=h.author_id WHERE h.project_id=$1 ORDER BY h.id`, [project.id]), user, 'author')), now)
          await zip.add(base + 'members.json', json(await rows(`SELECT u.email,u.display_name,m.role,m.created_at FROM project_members m JOIN users u ON u.id=m.user_id
            WHERE m.project_id=$1 ORDER BY m.created_at,m.user_id`, [project.id])), now)
          for (const { id } of await rows('SELECT id FROM project_analyses WHERE project_id=$1 ORDER BY created_at,id', [project.id])) {
            // Like the board, exports keep the AI provider and model transparent to users (#30).
            const [row] = await rows(`SELECT a.id,a.action,a.focus,a.language,a.base_revision,a.snapshot_hash,a.snapshot,a.response,a.usage,a.created_at,${author('a')}
              FROM project_analyses a LEFT JOIN users u ON u.id=a.author_id WHERE a.id=$1`, [id])
            await zip.add(`${base}analyses/${id}.json`, json(person(row, user, 'author')), row.created_at)
          }
        }
        for (const block of await rows(`SELECT id,name,latest_version,category_slug,subcategory_slug,deleted_at AS trashed_at FROM blocks
          WHERE owner_id=$1 ORDER BY name,id`, [user.id])) {
          const base = `blocks/${block.id}/`, versions = []
          await zip.add(base + 'block.json', json(block), now)
          for (const { version } of await rows('SELECT version FROM block_versions WHERE block_id=$1 ORDER BY version', [block.id])) {
            const [row] = await rows(`SELECT v.version,v.summary,v.created_at,v.yaml,${author('v')} FROM block_versions v LEFT JOIN users u ON u.id=v.author_id WHERE v.block_id=$1 AND v.version=$2`, [block.id, version])
            const { yaml: content, ...info } = person(row, user, 'author')
            versions.push(info)
            await zip.add(`${base}versions/${version}.yaml`, content, row.created_at)
          }
          await zip.add(base + 'versions.json', json(versions), now)
        }
        const schematics = await rows(`SELECT s.id,s.name FROM schematics s WHERE EXISTS(
          SELECT 1 FROM schematic_references r
          LEFT JOIN blocks b ON r.resource_kind='block' AND b.id=r.resource_id
          LEFT JOIN projects p ON r.resource_kind='project' AND p.id=r.resource_id
          WHERE r.schematic_id=s.id AND (b.owner_id=$1 OR p.created_by=$1)) ORDER BY s.id`, [user.id])
        if (schematics.length) {
          for (const file of schematics) {
            const [{ data }] = await rows('SELECT data FROM schematics WHERE id=$1', [file.id])
            await zip.add(`schematics/${file.id}.kicad_sch`, data, now)
          }
          await zip.add('schematics/index.json', json(schematics), now)
        }
        const images = []
        for (const image of await rows(`SELECT id,name,mime,created_at,deleted_at AS trashed_at FROM images
          WHERE owner_id=$1 AND scope<>'catalog' ORDER BY created_at,id`, [user.id])) {
          const file = `images/${image.id}.${extensions[image.mime] || 'bin'}`
          const [{ data }] = await rows('SELECT data FROM images WHERE id=$1', [image.id])
          images.push({ ...image, file })
          await zip.add(file, data, image.created_at)
        }
        await zip.add('images/images.json', json(images), now)
      })
      await zip.close()
    },
  }
}
