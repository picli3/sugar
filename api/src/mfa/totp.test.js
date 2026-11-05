import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeSecret, decodeSecret, generateSecret, hotp, matchTotp, enrollmentUri } from './totp.js'

// Public reference vectors, not credentials: RFC 4226 Appendix D / RFC 6238 Appendix B.
const key = Buffer.from('12345678901234567890'), secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
test('canonical Base32 round-trips and generated seeds contain 160 bits', () => {
  assert.equal(encodeSecret(key), secret); assert.deepEqual(decodeSecret(secret), key)
  const seeds = Array.from({ length: 20 }, generateSecret)
  assert.equal(new Set(seeds).size, seeds.length)
  for (const seed of seeds) { assert.match(seed, /^[A-Z2-7]{32}$/); assert.equal(decodeSecret(seed).length, 20); assert.equal(encodeSecret(decodeSecret(seed)), seed) }
  for (const bad of [null,'',secret.toLowerCase(),secret+'=',secret.slice(1),'0'.repeat(32)]) assert.throws(() => decodeSecret(bad), TypeError)
  assert.throws(() => encodeSecret(Buffer.alloc(19)), TypeError)
})
test('HOTP matches all ten RFC 4226 vectors, using an unsigned 64-bit moving factor', () => {
  const expected = ['755224','287082','359152','969429','338314','254676','287922','162583','399871','520489']
  assert.deepEqual(expected.map((_, counter) => hotp(key, counter)), expected)
  assert.equal(hotp(key, 2n ** 40n), hotp(key, 2 ** 40))
  for (const counter of [-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1,-1n,2n**64n,'1']) assert.throws(() => hotp(key,counter), TypeError)
  for (const options of [{digits:4},{algorithm:'md5'}]) assert.throws(() => hotp(key,1,options), TypeError)
})
test('TOTP matches RFC 6238 SHA1/SHA256/SHA512 vectors, including times beyond 2038', () => {
  const keys = [key,Buffer.from('12345678901234567890123456789012'),Buffer.from('1234567890123456789012345678901234567890123456789012345678901234')]
  const vectors = [
    [59,'94287082','46119246','90693936'],
    [1111111109,'07081804','68084774','25091201'],
    [1111111111,'14050471','67062674','99943326'],
    [1234567890,'89005924','91819424','93441116'],
    [2000000000,'69279037','90698825','38618901'],
    [20000000000,'65353130','77737706','47863826'],
  ]
  for (const [seconds,...codes] of vectors) for (const [i,algorithm] of ['sha1','sha256','sha512'].entries()) assert.equal(hotp(keys[i],Math.floor(seconds/30),{algorithm,digits:8}),codes[i])
})
test('verification preserves leading zeroes, bounds skew, and requires a newer consumed step', () => {
  const step = Math.floor(1111111109/30), now = step*30000+15000
  assert.equal(matchTotp(secret,'081804',{now}),step)
  for (const delta of [-1,0,1]) {
    const code = hotp(key,step+delta)
    assert.equal(matchTotp(secret,code,{now}),step+delta)
    assert.equal(matchTotp(secret,code,{now,after:step+delta}),null)
    assert.equal(matchTotp(secret,code,{now,after:step+2}),null)
  }
  for (const delta of [-3,-2,2,3]) assert.equal(matchTotp(secret,hotp(key,step+delta),{now}),null)
  for (const code of [81804,'81804',' 081804','081804\n',null,{},'1234567']) assert.equal(matchTotp(secret,code,{now}),null)
  for (const options of [{now:-1},{now:Infinity},{now:NaN},{now:Number.MAX_SAFE_INTEGER+1},{now,after:'1'},{now,after:-2}]) assert.equal(matchTotp(secret,'081804',options),null)
  assert.equal(matchTotp(secret,hotp(key,0),{now:0}),0)
})
test('enrollment URI uses fixed Sugar issuer and encodes account text as a label, never extra parameters', () => {
  const account='fixture+test/ñ@example.invalid?issuer=other&secret=ignored',uri=new URL(enrollmentUri(secret,account))
  assert.equal(uri.protocol,'otpauth:');assert.equal(uri.hostname,'totp');assert.equal(decodeURIComponent(uri.pathname.slice(1)),'Sugar:'+account)
  assert.deepEqual(Object.fromEntries(uri.searchParams),{secret,issuer:'Sugar',algorithm:'SHA1',digits:'6',period:'30'})
  for(const label of ['',null,'a:b','a\n@example.invalid','a'.repeat(255)])assert.throws(()=>enrollmentUri(secret,label),TypeError)
})
