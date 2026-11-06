import test from 'node:test'
import assert from 'node:assert/strict'
import { hasNotes, notePreview, outdatedVersion, uniqueLibraryIds } from '../src/nodeBadges.ts'

test('only non-empty text notes produce a badge', () => {
  assert.equal(hasNotes({ properties: { notes: 'Revisar consumo' } }), true)
  for (const block of [null, {}, { properties: null }, { properties: { notes: '   \n ' } }, { properties: { notes: 42 } }, { properties: { other: 'x' } }]) assert.equal(hasNotes(block), false)
})
test('previews collapse whitespace and are bounded', () => {
  assert.equal(notePreview({ properties: { notes: '  Línea 1\n\n Línea 2  ' } }), 'Línea 1 Línea 2')
  const long = notePreview({ properties: { notes: 'ñ'.repeat(300) } })
  assert.equal([...long].length, 140); assert.ok(long.endsWith('…'))
})
test('a block is outdated only when the library has a strictly newer version', () => {
  const latest = { a: 4, b: 2 }
  assert.equal(outdatedVersion('a', 2, latest), 4)
  assert.equal(outdatedVersion('b', 2, latest), null)
  assert.equal(outdatedVersion('b', 3, latest), null)
  assert.equal(outdatedVersion('missing', 1, latest), null)
  assert.equal(outdatedVersion(undefined, 1, latest), null)
  assert.equal(outdatedVersion('a', undefined, latest), null)
})
test('library ids are unique, well formed and bounded', () => {
  const id = '11111111-1111-1111-1111-111111111111'
  assert.deepEqual(uniqueLibraryIds([{ libraryId: id }, { libraryId: id }, { libraryId: 'x' }, {}]), [id])
})
