import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { parseYaml } from '../model.js'
import { readZip } from '../../test-support/zip.js'

const url = process.env.API_TEST_URL
const databaseUrl = process.env.API_TEST_DATABASE_URL
const bytes = readFileSync(new URL('../../test-support/design-block-fixture.kicad_sch', import.meta.url))
const block = (name, schematic) => ({
  name, function: 'Fixture', category: 'sensores', design_block_kicad: schematic,
  ports: [{ id: 'p', label: 'P', protocol: 'POWER', direction: 'in' }],
})

test('KiCad attachments are versioned with blocks and obey project access and retention', { skip: !url || !databaseUrl }, async t => {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  t.after(() => pool.end())
  const suffix = crypto.randomUUID().slice(0, 8)
  const password = 'synthetic-schematic-password'
  async function request(path, cookie, method = 'GET', body) {
    const response = await fetch(url + path, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const type = response.headers.get('content-type') || ''
    const value = type.includes('json') ? await response.json() : type.startsWith('text/') ? await response.text() : Buffer.from(await response.arrayBuffer())
    return { status: response.status, value, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const api = (path, ...args) => request('/api' + path, ...args)
  const admin = (await api('/login', null, 'POST', { email: 'admin@local', password: 'local-icons-verification-password' })).cookie
  const accounts = []
  for (const role of ['dev','dev','view']) {
    const email = `schematic-${accounts.length}-${suffix}@local`
    const created = await api('/users', admin, 'POST', { email, password, role })
    assert.equal(created.status, 201)
    accounts.push({ ...created.value, cookie: (await api('/login', null, 'POST', { email, password })).cookie })
  }
  const [owner, outsider, reader] = accounts
  const own = (path, ...args) => api(path, owner.cookie, ...args)
  const name = 'KiCad block ' + suffix, projectName = 'KiCad project ' + suffix
  const yaml = JSON.stringify(block(name)), upload = { name: 'Sensor.kicad_sch', data: bytes.toString('base64') }
  for (const [designBlock, expected] of [
    [{ ...upload, name: 'bad.html' },400],
    [{ ...upload, data: Buffer.from('<html/>').toString('base64') },400],
    [{ ...upload, data: Buffer.concat([bytes,Buffer.from('(extra)')]).toString('base64') },400],
    [{ ...upload, data: Buffer.alloc(1_000_001).toString('base64') },413],
  ]) assert.equal((await own('/blocks','POST',{ yaml, designBlock })).status,expected)
  assert.equal((await api('/blocks',reader.cookie,'POST',{ yaml,designBlock:upload })).status,403)
  const created = await own('/blocks','POST',{ yaml,designBlock:upload })
  assert.equal(created.status,201,JSON.stringify(created.value))
  const library = '/blocks/' + created.value.id
  const initial = parseYaml((await own(library)).value.yaml)
  const first = initial.design_block_kicad
  assert.match(first,/^\/api\/schematics\/[a-f0-9-]+\/content$/)
  const original = await request(first,owner.cookie)
  assert.equal(original.status,200)
  assert.deepEqual(original.value,bytes)
  assert.equal(original.headers.get('content-type'),'application/octet-stream')
  assert.match(original.headers.get('content-disposition'),/^attachment;.*Sensor\.kicad_sch/)
  assert.equal(original.headers.get('cache-control'),'private, no-store')
  assert.equal(original.headers.get('x-content-type-options'),'nosniff')
  assert.equal((await request(first)).status,404)
  assert.equal((await request(first,outsider.cookie)).status,404)
  assert.equal((await api('/blocks',outsider.cookie,'POST',{yaml:JSON.stringify(initial)})).status,404)
  assert.equal((await own('/blocks','POST',{yaml:JSON.stringify(block(name,'https://example.invalid/a.kicad_sch'))})).status,400)
  const diagram = file => JSON.stringify({name:projectName,nodes:file ? [{id:'n',position:{x:0,y:0},block:block(name,file)}] : [],edges:[]})
  assert.equal((await api('/projects',outsider.cookie,'POST',{yaml:diagram(first)})).status,404)
  const project = await own('/projects','POST',{yaml:diagram(first)})
  assert.equal(project.status,201)
  const p = '/projects/' + project.value.id
  assert.equal((await own(p+'/members','PUT',{email:reader.email,role:'reader'})).status,200)
  assert.equal((await request(first,reader.cookie)).status,200)
  const shared = await own(p+'/share','POST')
  const token = new URL(shared.value.path,'http://example.invalid').searchParams.get('share')
  const sharedFile = `/api/shared/${token}${first.slice(4)}`
  assert.deepEqual((await request(sharedFile)).value,bytes)

  const replacement = Buffer.from(bytes.toString().replace('Synthetic Sugar fixture','Replacement schematic'))
  assert.equal((await own(library,'PUT',{yaml,expectedVersion:1,designBlock:{...upload,data:replacement.toString('base64')}})).status,200)
  const second = parseYaml((await own(library)).value.yaml).design_block_kicad
  assert.notEqual(second,first)
  assert.deepEqual((await request(second,owner.cookie)).value,replacement)
  assert.deepEqual((await request(first,reader.cookie)).value,bytes)
  assert.equal((await request(`/api/shared/${token}${second.slice(4)}`)).status,404)
  const conflict = await own(library,'PUT',{yaml,expectedVersion:1,designBlock:upload})
  assert.equal(conflict.status,409)
  const blockId = created.value.id
  const refs = await pool.query("SELECT count(*)::int AS total FROM schematic_references WHERE resource_kind='block' AND resource_id=$1",[blockId])
  assert.equal(refs.rows[0].total,2)
  assert.equal(parseYaml((await own(library+'/versions/1')).value).design_block_kicad,first)
  assert.equal((await own(library+'/restore','POST',{version:1,expectedVersion:2})).status,200)
  assert.equal(parseYaml((await own(library)).value.yaml).design_block_kicad,first)
  assert.equal((await own(library,'PUT',{yaml,expectedVersion:3})).status,200)
  assert.equal(parseYaml((await own(library)).value.yaml).design_block_kicad,undefined)

  const archive = await own('/me/export')
  assert.equal(archive.status,200)
  const fileId = path => path.split('/')[3]
  assert.deepEqual(readZip(archive.value).get(`schematics/${fileId(first)}.kicad_sch`),bytes)
  assert.equal((await own(p,'PUT',{yaml:diagram(null),expectedRevision:1})).status,200)
  assert.equal((await request(sharedFile)).status,404)
  assert.equal((await request(first,reader.cookie)).status,200)
  assert.equal((await own(p+'/restore','POST',{revision:1,expectedRevision:2})).status,200)
  assert.equal((await request(sharedFile)).status,200)
  assert.equal((await own(p+'/share','DELETE')).status,200)
  assert.equal((await request(sharedFile)).status,404)
  assert.equal((await own(p+'/settings','PATCH',{visibility:'public',expectedSettingsVersion:1})).status,200)
  assert.equal((await request(first)).status,200)

  assert.equal((await own(library,'DELETE')).status,200)
  await pool.query("UPDATE blocks SET deleted_at=now()-interval '31 days' WHERE id=$1",[blockId])
  assert.equal((await own('/trash/block/'+blockId,'DELETE',{confirm:name})).status,200)
  assert.equal((await request(first)).status,200)
  assert.equal((await request(second,owner.cookie)).status,404)
  assert.equal((await own(p,'DELETE')).status,200)
  await pool.query("UPDATE projects SET deleted_at=now()-interval '31 days' WHERE id=$1",[project.value.id])
  assert.equal((await own('/trash/project/'+project.value.id,'DELETE',{confirm:projectName})).status,200)
  assert.equal((await pool.query('SELECT id FROM schematics WHERE id=ANY($1::uuid[])',[[fileId(first),fileId(second)]])).rowCount,0)
})
