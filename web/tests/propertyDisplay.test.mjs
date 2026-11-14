import test from 'node:test'
import assert from 'node:assert/strict'
import { propertyUrl } from '../src/propertyDisplay.ts'

test('named property links preserve absolute web destinations and query parameters', () => {
  const url = 'https://example.invalid/datasheet.pdf?part=NCP1117&download=1'
  assert.equal(propertyUrl(url), url)
  assert.equal(propertyUrl('http://example.invalid/part'), 'http://example.invalid/part')
})

test('project values cannot become script, data, file or relative navigation links', () => {
  for (const value of [null, {}, [], 42, 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', '//example.invalid', '/api/me', 'LCSC', 'https://example.invalid/' + 'a'.repeat(2048)]) {
    assert.equal(propertyUrl(value), '', String(value))
  }
})
