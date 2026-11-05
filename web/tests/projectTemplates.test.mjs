import test from 'node:test'
import assert from 'node:assert/strict'
import { templateDiagram, templateIds, templateInfo } from '../src/projectTemplates.ts'
import { stringify, validateProject } from '../../api/src/model.js'

test('every template is accepted by the real project validator in both languages', () => {
  for (const id of templateIds) for (const language of ['es', 'en']) {
    const diagram = templateDiagram(id, language)
    assert.doesNotThrow(() => validateProject(stringify(diagram)), `${id}/${language}`)
    assert.equal(diagram.name, templateInfo(id, language).name)
  }
})
test('templates are self-contained: no library, gallery or other-project references', () => {
  for (const id of templateIds) {
    const text = JSON.stringify(templateDiagram(id, 'es'))
    assert.doesNotMatch(text, /\/api\/|https?:|"image"|"category"|owner|created_by/)
  }
})
test('a custom name is kept, and both languages describe the same structure', () => {
  assert.equal(templateDiagram('sensor-node', 'en', '  Board A ').name, 'Board A')
  for (const id of templateIds) {
    const shape = language => JSON.stringify(templateDiagram(id, language).nodes.map(n => [n.id, n.block.ports.map(p => [p.id, p.protocol, p.direction])]))
    assert.equal(shape('es'), shape('en'))
  }
  assert.deepEqual(templateDiagram('empty', 'es'), { name: 'Proyecto vacío', nodes: [], edges: [] })
})
