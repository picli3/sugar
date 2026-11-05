import test from 'node:test'
import assert from 'node:assert/strict'
import { selectedId } from '../src/canvasSelection.ts'

test('keyboard and pointer selections expose the newly selected element', () => {
  assert.equal(selectedId([{ type: 'select', id: 'mcu', selected: true }]), 'mcu')
  assert.equal(selectedId([{ type: 'select', id: 'old', selected: false }, { type: 'select', id: 'imu', selected: true }]), 'imu')
})
test('position, dimension and deselection changes do not change the inspector', () => {
  assert.equal(selectedId([{ type: 'position', id: 'mcu' }, { type: 'dimensions', id: 'mcu' }]), null)
  assert.equal(selectedId([{ type: 'select', id: 'mcu', selected: false }]), null)
  assert.equal(selectedId([{ type: 'select', id: '', selected: true }, { type: 'select', selected: true }]), null)
  assert.equal(selectedId([]), null)
})
