import test from 'node:test'
import assert from 'node:assert/strict'
import { useCategoryContext } from '../src/categoryContext.ts'
const row=(id,parent=null)=>({id,slug:id,name:id,parent_id:parent,icon:'cube',deleted_at:null,owner_id:null})
test('category context resolves only needed slugs/parents in bounded packets without enumerating the catalog',async()=>{
  const calls=[],ctx=useCategoryContext(async(path,method,body)=>{
    calls.push({path,method,body})
    if(path.startsWith('/categories/page'))return{items:[row('child','parent')],nextCursor:'next'}
    return body.slugs.flatMap(slug=>slug==='child'?[row('child','parent'),row('parent')]:[row(slug)])
  })
  await ctx.pages.first();await ctx.ensure(['child']);assert.deepEqual(ctx.items.value.map(i=>i.id).sort(),['child','parent'])
  const count=calls.length;await ctx.ensure(['child','parent']);assert.equal(calls.length,count)
  await ctx.ensure(Array.from({length:130},(_,i)=>'cat-'+i));assert.deepEqual(calls.filter(c=>c.method==='POST').map(c=>c.body.slugs.length),[1,64,64,2])
  assert.equal(calls.filter(c=>c.path.startsWith('/categories/page')).length,1)
})
test('reset discards old category results/errors and stops subsequent packets for another identity',async()=>{
  const pending=[],ctx=useCategoryContext(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})))
  const old=ctx.ensure(Array.from({length:100},(_,i)=>'private-'+i));ctx.reset()
  const current=ctx.ensure(['current']);pending[1].resolve([row('current')]);await current
  pending[0].resolve([row('old-private')]);await old;assert.equal(pending.length,2);assert.deepEqual(ctx.items.value.map(i=>i.id),['current']);assert.equal(ctx.loading.value,false)
  const stale=ctx.ensure(['old']);ctx.reset();pending[2].reject(Error('old private failure'));await stale;assert.deepEqual(ctx.items.value,[])
})
