import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { initImageStorage,createImageStorage,defaultImageStorage } from './quotas.js'
import { createImageService } from './service.js'
import { createImageRepository } from './repository.js'
import { replaceEmbeddedImages } from '../images.js'
const url=process.env.API_TEST_DATABASE_URL
const data='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII=',size=Buffer.from(data,'base64').length

test('image storage quotas serialize admissions across instances, isolate accounts and roll back restores', {skip:!url},async t=>{
 const schema='image_storage_'+crypto.randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:url})
 await admin.query('CREATE SCHEMA '+schema)
 const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema}),q=(sql,args)=>pool.query(sql,args),transaction=createTransaction(pool)
 t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()})
 await q('CREATE TABLE images(id uuid PRIMARY KEY,name text,mime text,data bytea NOT NULL,created_by uuid,owner_id uuid,scope text,deleted_at timestamptz)')
 await initImageStorage(q)
 const storage=createImageStorage({q,transaction}),otherStorage=createImageStorage({q,transaction}),service=createImageService(createImageRepository(q),storage),otherService=createImageService(createImageRepository(q),otherStorage)
 const a={id:crypto.randomUUID(),role:'dev'},b={id:crypto.randomUUID(),role:'dev'},root={id:crypto.randomUUID(),role:'Admin'}
 const upload=(owner,scope='personal')=>service.create(owner,{name:'fixture.png',mime:'image/png',data,scope})
 const configure=async patch=>{const current=await storage.configuration();return storage.configure({...defaultImageStorage,...patch,expectedVersion:current.version})}
 await configure({userFiles:1,userBytes:size})
 const outcomes=await Promise.allSettled([upload(a),otherService.create(a,{name:'second.png',mime:'image/png',data})])
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.find(r=>r.status==='rejected').reason.status,409)
 assert.deepEqual((await storage.summary(a.id)).usage,{files:'1',bytes:String(size)})
 await upload(b);assert.equal((await storage.summary(b.id)).usage.files,'1')
 await assert.rejects(upload(a),{status:409})
 const first=(await q('SELECT id FROM images WHERE owner_id=$1',[a.id])).rows[0].id
 await q('UPDATE images SET deleted_at=now() WHERE id=$1',[first]);await assert.rejects(upload(a),{status:409})
 assert.equal((await storage.summary(a.id)).usage.files,'1')
 const old=await storage.configuration();await configure({userFiles:0});await assert.rejects(storage.configure({...defaultImageStorage,expectedVersion:old.version}),{status:409})
 assert.equal((await storage.summary(a.id)).usage.bytes,String(size));await initImageStorage(q);assert.equal((await storage.configuration()).userFiles,0)
 await assert.rejects(upload(root,'personal'),{status:409});await upload(root,'catalog')
 const global=await storage.configuration();assert.equal(global.usage.files,'3')
 await configure({platformFiles:3});await assert.rejects(upload(root,'catalog'),{status:409})
 await configure({platformFiles:100,platformBytes:size*3});await assert.rejects(upload(root,'catalog'),{status:409})
 await configure({userFiles:100,userBytes:size-1});await assert.rejects(upload({id:crypto.randomUUID(),role:'dev'}),{status:409})
 await configure({userFiles:100,userBytes:1000,platformFiles:100,platformBytes:10000})
 const before=(await storage.configuration()).usage
 await assert.rejects(storage.create(a.id,size,async tx=>{await tx('INSERT INTO images(id,data,owner_id,scope) VALUES($1,$2,$3,\'personal\')',[crypto.randomUUID(),Buffer.from(data,'base64'),a.id]);throw Error('synthetic rollback')}),/synthetic rollback/)
 assert.deepEqual((await storage.configuration()).usage,before)
 await configure({userFiles:2,userBytes:1000})
 const yaml='name: Fixture\nnodes:\n'+[0,1].map(i=>`  - id: n${i}\n    block:\n      image: data:image/png;base64,${data}\n`).join('')+'edges: []\n'
 await assert.rejects(transaction(tx=>replaceEmbeddedImages(yaml,'project',tx,{ownerId:a.id,storage})),{status:409})
 assert.deepEqual((await storage.configuration()).usage,before)
 await configure({userFiles:3,userBytes:1000})
 const restored=await transaction(tx=>replaceEmbeddedImages(yaml,'project',tx,{ownerId:a.id,storage}))
 assert.ok(!restored.includes('data:image/'));assert.equal((await storage.summary(a.id)).usage.files,'3')
 const independent=(await storage.summary(b.id)).usage;assert.deepEqual(independent,{files:'1',bytes:String(size)})
 await configure({platformFiles:6})
 let concurrent=await Promise.allSettled([upload({id:crypto.randomUUID(),role:'dev'}),otherService.create({id:crypto.randomUUID(),role:'dev'},{name:'other.png',mime:'image/png',data})])
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal((await storage.configuration()).usage.files,'6')
 await configure({platformBytes:7*size})
 concurrent=await Promise.allSettled([upload({id:crypto.randomUUID(),role:'dev'}),upload({id:crypto.randomUUID(),role:'dev'})])
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal((await storage.configuration()).usage.bytes,String(7*size))
})
