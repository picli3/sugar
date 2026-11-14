import test from 'node:test'
import assert from 'node:assert/strict'
import { embedMarkup, embedTarget } from '../src/embed.ts'
import { parseHardwareYaml } from '../src/hardwareYaml.ts'

const id = '01234567-89ab-cdef-0123-456789abcdef'
const token = 'a'.repeat(43)
const origin = 'https://sugar.example.invalid'
const source = html => new URL(html.match(/src="([^"]+)"/)[1].replaceAll('&amp;', '&'))

test('public embed uses a stable responsive viewer with safely escaped attributes', () => {
  const html = embedMarkup(origin, '/?public=' + id, 'Diagram "<script>&\' test', 'en', 'dark')
  assert.ok(html.includes('width:100%;aspect-ratio:16/9;min-height:320px'))
  assert.ok(html.includes('title="Diagram &quot;&lt;script&gt;&amp;&#39; test"'))
  assert.ok(html.includes('referrerpolicy="no-referrer"'))
  const url = source(html)
  assert.equal(url.origin, origin)
  assert.equal(url.searchParams.get('lang'), 'en')
  assert.equal(url.searchParams.get('theme'), 'dark')
  assert.deepEqual(embedTarget(url.pathname, url.search), {
    apiPath: '/public/projects/' + id, shareToken: null, openPath: '/?public=' + id,
  })
})

test('private embed keeps access token out of the logged path and reuses shared access', () => {
  const url = source(embedMarkup(origin, origin + '/?share=' + token, 'Private', 'es', 'light'))
  assert.equal(url.pathname, '/embed/shared')
  assert.equal(url.searchParams.get('token'), token)
  assert.deepEqual(embedTarget(url.pathname, url.search), {
    apiPath: '/shared/' + token, shareToken: token, openPath: '/?share=' + token,
  })
})

test('embed targets cannot open editor or account routes and invalid credentials are rejected', () => {
  for (const [path, query] of [
    ['/', '?public=' + id], ['/login', ''], ['/embed/shared', ''],
    ['/embed/shared', '?token=../../me'], ['/embed/public/not-a-uuid', ''],
    ['/embed/public/' + id + '/login', ''], ['/embed/shared/../', '?token=' + token],
  ]) assert.equal(embedTarget(path, query), null)
  for (const path of ['/?public=bad', '/?share=bad', '/login?share=' + token, 'https://other.invalid/?public=' + id, 'javascript:alert(1)']) {
    assert.throws(() => embedMarkup(origin, path, 'Invalid', 'es', 'light'))
  }
})

test('shared YAML parser preserves legacy unquoted hardware colors', () => {
  const result = parseHardwareYaml('name: Sensor\ncolor: #ff0044\nports:\n  - id: p\n    color: #123abc # legacy\n')
  assert.equal(result.color, '#ff0044')
  assert.equal(result.ports[0].color, '#123abc')
})
