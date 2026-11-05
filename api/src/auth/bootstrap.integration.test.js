import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { bootstrapAdmin } from './bootstrap.js'
const databaseUrl=process.env.API_TEST_DATABASE_URL

test('initial administrator is explicit, race-safe, never logged and never reset on restart', {skip:!databaseUrl},async t=>{
  const root=new pg.Pool({connectionString:databaseUrl}),schema='bootstrap_'+crypto.randomUUID().replaceAll('-','');await root.query(`CREATE SCHEMA ${schema}`)
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`}),q=(sql,args)=>pool.query(sql,args),transaction=createTransaction(pool)
  t.after(async()=>{await pool.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end()})
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text UNIQUE,password_hash text,role text)')
  const logs=[],log=text=>logs.push(text)
  for(const env of [{},{ADMIN_PASSWORD:'short'},{ADMIN_PASSWORD:'x'.repeat(73)},{ADMIN_EMAIL:'invalid',ADMIN_PASSWORD:'valid-fixture-password'}])await assert.rejects(bootstrapAdmin({transaction,env,log}),{code:'BOOTSTRAP_CONFIG'})
  assert.equal((await q('SELECT count(*)::int n FROM users')).rows[0].n,0);assert.equal(logs.length,0)
  const passwords=['first-isolated-password','second-isolated-password'],envs=passwords.map((ADMIN_PASSWORD,i)=>({ADMIN_PASSWORD,ADMIN_EMAIL:`bootstrap-${i}@local`}))
  const result=await Promise.all(envs.map(env=>bootstrapAdmin({transaction,env,log})));assert.equal(result.filter(Boolean).length,1)
  const row=(await q('SELECT * FROM users')).rows[0];assert.equal(row.role,'Admin');assert.equal(bcrypt.getRounds(row.password_hash),12)
  assert.equal((await q('SELECT count(*)::int n FROM users')).rows[0].n,1)
  assert.ok(await bcrypt.compare(passwords[Number(row.email.match(/bootstrap-(\d)/)[1])],row.password_hash))
  assert.equal(logs.length,1);for(const value of [...passwords,row.email,row.password_hash])assert.equal(logs.join('').includes(value),false)
  assert.equal(await bootstrapAdmin({transaction,env:{ADMIN_PASSWORD:'replacement-fixture-password'},log}),false)
  assert.equal(await bootstrapAdmin({transaction,env:{},log}),false)
  assert.equal((await q('SELECT password_hash FROM users')).rows[0].password_hash,row.password_hash)
})
