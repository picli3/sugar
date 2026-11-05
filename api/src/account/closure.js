import bcrypt from 'bcryptjs'
import { error } from '../shared/http.js'
import { requireAdmin } from '../auth/policies.js'
import { trashRetentionDays } from '../trash/repository.js'

// Owner decision (#24): closing deactivates the account, revokes every session and pending
// account action, and moves owned projects, personal blocks and images to the trash. Admin can
// reopen within the trash retention window, restoring exactly what the closure trashed.
export async function initAccountClosureDb(q) {
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS closed_at timestamptz')
}

export function createAccountClosure({ query, transaction, runCredential = task => task() }) {
  return {
    async close(user, input = {}) {
      const password = input.currentPassword, confirm = input.confirm
      if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) error(400, 'Contraseña actual obligatoria / Current password required')
      if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== String(user.email).toLowerCase()) error(400, 'Escribe tu correo para confirmar el cierre / Type your email to confirm closing')
      // Verify outside the transaction (bcrypt is slow), then require the same hash under lock.
      const expected = await runCredential(async () => {
        const hash = (await query('SELECT password_hash FROM users WHERE id=$1 AND active=true', [user.id])).rows[0]?.password_hash
        if (!hash || !(await bcrypt.compare(password, hash))) error(400, 'Contraseña actual incorrecta / Current password is incorrect')
        return hash
      })
      return transaction(async tx => {
        const account = (await tx('SELECT id,role,active,password_hash FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0]
        if (!account?.active || account.password_hash !== expected) error(409, 'La cuenta cambió; vuelve a intentarlo / The account changed; try again')
        if (account.role === 'Admin') {
          // Lock every active Admin in a fixed order so two Admins cannot both leave.
          const admins = (await tx("SELECT id FROM users WHERE role='Admin' AND active=true ORDER BY id FOR UPDATE")).rows
          if (!admins.some(admin => admin.id !== user.id)) error(409, 'Eres el último administrador activo; nombra otro antes de cerrar tu cuenta / You are the last active Admin; appoint another before closing your account')
        }
        const closed = (await tx('UPDATE users SET active=false,closed_at=now(),auth_version=auth_version+1 WHERE id=$1 RETURNING closed_at', [user.id])).rows[0].closed_at
        await tx('UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user.id])
        await tx('DELETE FROM account_actions WHERE user_id=$1', [user.id])
        // now() is the transaction timestamp, so trashed rows carry exactly closed_at.
        await tx('UPDATE projects SET deleted_at=now(),share_token=NULL,share_expires_at=NULL WHERE created_by=$1 AND deleted_at IS NULL', [user.id])
        await tx('UPDATE blocks SET deleted_at=now() WHERE owner_id=$1 AND deleted_at IS NULL', [user.id])
        await tx("UPDATE images SET deleted_at=now() WHERE owner_id=$1 AND scope<>'catalog' AND deleted_at IS NULL", [user.id])
        return { closed: true, closed_at: closed, retentionDays: trashRetentionDays }
      })
    },
    async reopen(admin, id) {
      requireAdmin(admin)
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) error(404, 'Usuario no encontrado / User not found')
      return transaction(async tx => {
        const account = (await tx(`SELECT id,email,closed_at,(closed_at > now() - interval '${trashRetentionDays} days') AS reopenable FROM users WHERE id=$1 FOR UPDATE`, [id])).rows[0]
        if (!account) error(404, 'Usuario no encontrado / User not found')
        if (!account.closed_at) error(409, 'La cuenta no está cerrada / The account is not closed')
        if (!account.reopenable) error(409, `Sólo se puede reabrir durante ${trashRetentionDays} días tras el cierre / Accounts can be reopened only within ${trashRetentionDays} days of closing`)
        const restored = {}
        for (const [kind, table, owner] of [['projects', 'projects', 'created_by'], ['blocks', 'blocks', 'owner_id'], ['images', 'images', 'owner_id']]) {
          // Compare in SQL: a JS Date round trip would drop PostgreSQL microseconds.
          restored[kind] = (await tx(`UPDATE ${table} SET deleted_at=NULL WHERE ${owner}=$1 AND deleted_at=(SELECT closed_at FROM users WHERE id=$1)`, [id])).rowCount
        }
        await tx('UPDATE users SET active=true,closed_at=NULL WHERE id=$1', [id])
        return { id, email: account.email, reopened: true, restored }
      })
    },
  }
}
