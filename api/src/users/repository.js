import { boundedLegacyList, boundedMetadataPage } from '../shared/legacy-list.js'
export function createUserRepository(query, transaction) {
  return {
    async findActiveByEmail(email) {
      return (await query('SELECT * FROM users WHERE email=$1 AND active=true', [email])).rows[0]
    },
    async findActiveById(id) {
      return (await query('SELECT id,email,role,language,theme FROM users WHERE id=$1 AND active=true', [id])).rows[0]
    },
    async preferences(id, language, theme) {
      return (await query('UPDATE users SET language=COALESCE($2,language),theme=COALESCE($3,theme) WHERE id=$1 RETURNING id,email,role,language,theme', [id, language, theme])).rows[0]
    },
    async passwordHash(id) { return (await query('SELECT password_hash FROM users WHERE id=$1', [id])).rows[0].password_hash },
    async password(id, hash, expectedHash) {
      return transaction(async tx => {
        const result = await tx('UPDATE users SET password_hash=$2,auth_version=auth_version+1 WHERE id=$1 AND active=true AND password_hash=$3 RETURNING id', [id, hash, expectedHash])
        if (!result.rowCount) return false
        await tx('UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id])
        return true
      })
    },
    list: () => boundedLegacyList(query, 'SELECT id,email,role,active,created_at FROM users ORDER BY email,id', [], { order: 'r.email,r.id', textFields: ['email','role'] }),
    page: ({ limit, after }) => boundedMetadataPage(query, 'SELECT id,email,role,active,created_at FROM users WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2', [after, limit + 1], { order: 'r.id', textFields: ['email','role'], limit }),
    async create(id, email, hash, role) {
      return (await query('INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,email,role,active', [id, email, hash, role])).rows[0]
    },
    async role(id, role) {
      return (await query('UPDATE users SET role=$2 WHERE id=$1 AND active=true RETURNING id,email,role,active', [id, role])).rows[0]
    },
    async archive(id) {
      await transaction(async tx => {
        await tx('UPDATE users SET active=false,auth_version=auth_version+1 WHERE id=$1', [id])
        await tx('UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id])
      })
    },
  }
}
