import test from 'node:test'
import assert from 'node:assert/strict'
import { displayName, person, people, personTextFields } from './identity.js'

const row = { id: 'r', creator_id: 'owner', creator_name: null, creator_email: 'owner@example.invalid' }
test('other readers never receive a private email; self and Admin do when no public name exists', () => {
  assert.deepEqual(person(row, null, 'creator'), { id: 'r', creator: null })
  assert.deepEqual(person(row, { id: 'reader', role: 'dev' }, 'creator'), { id: 'r', creator: null })
  assert.equal(person(row, { id: 'owner', role: 'dev' }, 'creator').creator, 'owner@example.invalid')
  assert.equal(person(row, { id: 'admin', role: 'Admin' }, 'creator').creator, 'owner@example.invalid')
  const named = { ...row, creator_name: 'Ana Ruiz' }
  for (const viewer of [null, { id: 'reader', role: 'view' }, { id: 'owner', role: 'dev' }]) assert.equal(person(named, viewer, 'creator').creator, 'Ana Ruiz')
  assert.deepEqual(people([{ author_id: null, author_name: null, author_email: null, summary: 'Inicial' }], { id: 'x', role: 'dev' }, 'author'), [{ summary: 'Inicial', author: null }])
  assert.deepEqual(personTextFields('author'), ['author_name', 'author_email'])
})
test('public names are normalized, bounded and free of control or format characters', () => {
  assert.equal(displayName('  Ana   Ruiz  '), 'Ana Ruiz')
  assert.equal(displayName('José'), 'José')
  for (const empty of [undefined, null, '', '   ']) assert.equal(displayName(empty), null)
  assert.equal(displayName('ñ'.repeat(60)), 'ñ'.repeat(60))
  assert.equal(displayName('😀'.repeat(60)).length, 120)
  for (const bad of ['a'.repeat(61), 'Ana\u0000', 'Ana‮Ruiz', 'Ana​Ruiz', 42, { name: 'x' }]) assert.throws(() => displayName(bad), { status: 400 })
  assert.equal(displayName('Ana Ruiz'), 'Ana Ruiz')
})
