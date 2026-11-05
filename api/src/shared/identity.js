import { error } from './http.js'

// People are shown to others by their optional public name only. Private email reaches
// the person themselves and Admin; everyone else gets null and the UI shows "Sugar user".
export const personColumns = (userAlias, idExpression, as) =>
  `${idExpression} AS ${as}_id,${userAlias}.display_name AS ${as}_name,${userAlias}.email AS ${as}_email`
export const personTextFields = as => [`${as}_name`, `${as}_email`]

export function person(row, viewer, as) {
  if (!row) return row
  const { [`${as}_id`]: id, [`${as}_name`]: name, [`${as}_email`]: email, ...rest } = row
  const privileged = !!viewer && (viewer.role === 'Admin' || (!!id && viewer.id === id))
  return { ...rest, [as]: name || (privileged ? email || null : null) }
}
export const people = (rows, viewer, as) => rows.map(row => person(row, viewer, as))

export const displayNameLimit = 60
// Returns a normalized name, or null to clear it. Rejects control/format characters so a
// public name cannot hide or spoof text around it.
export function displayName(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') error(400, 'Nombre público inválido / Invalid public name')
  const name = value.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (!name) return null
  if ([...name].length > displayNameLimit || /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) error(400, `El nombre público admite hasta ${displayNameLimit} caracteres visibles / Public names allow up to ${displayNameLimit} visible characters`)
  return name
}

export async function initProfileDb(q) {
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text')
  await q(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='users_display_name_bounds' AND conrelid='users'::regclass) THEN
      ALTER TABLE users ADD CONSTRAINT users_display_name_bounds CHECK(display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND ${displayNameLimit} AND display_name=btrim(display_name)));
    END IF; END $$`)
}
