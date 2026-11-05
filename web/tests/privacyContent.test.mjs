import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { privacyContent, retention, supportEmail, vulnerabilityUrl } from '../src/privacyContent.ts'
import { trashRetentionDays } from '../../api/src/trash/repository.js'

const source = path => readFileSync(new URL('../../api/src/' + path, import.meta.url), 'utf8')

test('both languages describe the same sections with the same shape', () => {
  const shape = language => privacyContent[language].sections.map(s => [s.id, s.paragraphs.length, s.items?.length ?? 0])
  assert.deepEqual(shape('es'), shape('en'))
  for (const language of ['es', 'en']) {
    const text = JSON.stringify(privacyContent[language])
    assert.ok(text.includes(supportEmail) && text.includes(vulnerabilityUrl), language)
    assert.doesNotMatch(text, /\bTODO\b|\bTBD\b|[Ll]orem ipsum|\{[a-zA-Z]+\}/)
  }
})
test('stated retention periods match the running code', () => {
  assert.equal(retention.trashDays, trashRetentionDays)
  assert.equal(retention.reopenDays, trashRetentionDays)
  assert.match(source('auth/service.js'), new RegExp(`sessionLifetime = ${retention.sessionDays} \\* 24 \\* 60 \\* 60`))
  assert.match(source('recovery/repository.js'), new RegExp(`interval '${retention.recoveryMinutes} minutes'`))
  assert.match(source('registration/repository.js'), new RegExp(`interval '${retention.registrationMinutes} minutes'`))
  assert.match(source('projects/repository.js'), new RegExp(`interval '${retention.shareLinkDays} days'`))
})
test('AI disclosure matches the provider and the omitted fields', () => {
  const ai = source('ai.js')
  assert.match(ai, /https:\/\/api\.deepseek\.com\//)
  assert.match(ai, /token\|secret\|password\|credential\|authorization\|api\[_-\]\?key\|image\|email\|user/)
  assert.match(JSON.stringify(privacyContent.es), /DeepSeek/)
})
