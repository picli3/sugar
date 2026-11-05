import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch } from 'diff'
import { documentDiff } from './document-diff.js'
import { documentLimits } from '../model.js'
import { createProjectService } from '../projects/service.js'
import { createBlockService } from '../blocks/service.js'

test('bounded diffs remain applicable and preserve byte/line boundaries', () => {
  const before = 'name: ñ\nports:\n  - A\n', after = 'name: ñ\nports:\n  - B\n'
  const patch = documentDiff('fixture.yaml', before, after, 'first', 'second')
  assert.equal(applyPatch(before, patch), after)
  for (const exact of ['ñ'.repeat(documentLimits.yamlBytes / 2), Array(documentLimits.diffLines).fill('a').join('\n')]) assert.equal(typeof documentDiff('fixture', exact, exact), 'string')
  for (const excessive of ['ñ'.repeat(documentLimits.yamlBytes / 2 + 1), Array(documentLimits.diffLines + 1).fill('a').join('\n')]) {
    assert.throws(() => documentDiff('fixture', excessive, 'small'), { status: 413 })
    assert.throws(() => documentDiff('fixture', 'small', excessive), { status: 413 })
  }
})
test('large unrelated versions fail explicitly instead of returning an empty successful patch', () => {
  const one = Array.from({ length: documentLimits.diffEdits + 1 }, (_, i) => 'old-' + i).join('\n')
  const two = one.replaceAll('old-', 'new-')
  assert.throws(() => documentDiff('fixture', one, two), { status: 413 })
})
test('both histories authorize before comparing and keep raw versions available after a budget rejection', async () => {
  let allowed = false, reads = 0
  const user = { id: 'owner', role: 'dev' }, huge = 'ñ'.repeat(documentLimits.yamlBytes / 2 + 1)
  const projects = createProjectService({ projects: {
    find: async () => ({ id: 'p', created_by: allowed ? user.id : 'other', visibility: 'private' }),
    comparison: async () => { reads++; return [{ revision: 1, yaml: huge }, { revision: 2, yaml: 'small' }] },
    revision: async () => ({ yaml: huge }),
  } })
  const blocks = createBlockService({ blocks: {
    find: async () => ({ id: 'b', owner_id: allowed ? user.id : 'other' }),
    comparison: async () => { reads++; return [{ version: 1, yaml: huge }, { version: 2, yaml: 'small' }] },
    version: async () => ({ yaml: huge }),
  } })
  await assert.rejects(projects.diff('p', user, { from: 1, to: 2 }), { status: 403 })
  await assert.rejects(blocks.diff('b', { from: 1, to: 2 }, user), { status: 404 })
  assert.equal(reads, 0)
  allowed = true
  await assert.rejects(projects.diff('p', user, { from: 1, to: 2 }), { status: 413 })
  await assert.rejects(blocks.diff('b', { from: 1, to: 2 }, user), { status: 413 })
  assert.equal(await projects.revision('p', user, 1), huge)
  assert.equal(await blocks.version('b', 1, user), huge)
})
