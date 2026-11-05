import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { error, requiredText } from '../shared/http.js'
import { requireAdmin } from '../auth/policies.js'
import { identifierPageInput, identifierPageResult } from '../shared/pagination.js'

export function createUserService(users, { runCredential = task => task(), passwordChanged = async () => {} } = {}) {
  return {
    async preferences(user, input) {
      const language = input.language ?? null, theme = input.theme ?? null
      if ((language !== null && !['es', 'en'].includes(language)) || (theme !== null && !['dark', 'light'].includes(theme))) error(400, 'Preferencia inválida')
      return users.preferences(user.id, language, theme)
    },
    async password(user, input) {
      await runCredential(async () => {
        const old = input?.currentPassword, fresh = input?.newPassword
        if (typeof old !== 'string' || !old || typeof fresh !== 'string' || !fresh) error(400, 'Contraseña actual y nueva obligatorias')
        if (Buffer.byteLength(old) > 1024 || Buffer.byteLength(fresh) > 72) error(400, 'Contraseña demasiado larga')
        if (fresh.length < 12) error(400, 'La nueva contraseña debe tener al menos 12 caracteres')
        const expectedHash = await users.passwordHash(user.id)
        if (!(await bcrypt.compare(old, expectedHash))) error(400, 'Contraseña actual incorrecta')
        if (!(await users.password(user.id, await bcrypt.hash(fresh, 12), expectedHash))) error(409, 'La contraseña cambió; vuelve a entrar')
      })
      await passwordChanged(user)
    },
    async list(user) { requireAdmin(user); return users.list() },
    async page(user, query) {
      requireAdmin(user)
      const input = identifierPageInput(query), page = await users.page(input)
      return identifierPageResult(page.rows, input.limit, item => item, page.more)
    },
    async create(user, input) {
      requireAdmin(user)
      const email = requiredText(input.email, 'Email').toLowerCase(), password = requiredText(input.password, 'Contraseña'), role = input.role
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email) || Buffer.byteLength(password) > 72) error(400, 'Email o contraseña inválidos')
      if (password.length < 12 || !['view', 'dev', 'Admin'].includes(role)) error(400, 'Contraseña mínima de 12 caracteres y rol válido requeridos')
      return runCredential(async () => users.create(crypto.randomUUID(), email, await bcrypt.hash(password, 12), role))
    },
    async role(user, id, input) {
      requireAdmin(user)
      if (!['view', 'dev', 'Admin'].includes(input.role)) error(400, 'Rol inválido')
      if (id === user.id) error(400, 'No puedes cambiar tu propio rol')
      const saved = await users.role(id, input.role)
      if (!saved) error(404, 'Usuario no encontrado')
      return saved
    },
    async archive(user, id) {
      requireAdmin(user)
      if (id === user.id) error(400, 'No puedes eliminar tu propia cuenta')
      await users.archive(id)
    },
  }
}
