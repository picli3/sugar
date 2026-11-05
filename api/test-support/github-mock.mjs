// Synthetic preview/CI only: never copied into the production image.
// Fixed GitHub URLs are intercepted; unexpected provider calls fail closed.
const original = globalThis.fetch
const token = 'ghu_' + 'a'.repeat(40)
let publication
const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url)
  if (!['api.github.com','github.com'].includes(target.hostname)) return original(url, options)
  if (target.pathname === '/login/oauth/access_token') return json({ token_type:'bearer',scope:'',access_token:token })
  if (options.method === 'DELETE') return json(null,204)
  if (options.headers.Authorization !== 'Bearer ' + token) throw Error('Synthetic GitHub token required')
  if (target.pathname === '/user') return json({id:111,login:'fixture-user',type:'User'})
  if (target.pathname === '/user/installations') return json({total_count:1,installations:[{id:7,account:{id:9,login:'fixture'},permissions:{contents:'write'},suspended_at:null}]})
  if (target.pathname === '/user/installations/7/repositories') return json({total_count:2,repositories:[{id:8,owner:{id:9},full_name:'fixture/private',private:true,default_branch:'main',permissions:{push:true},archived:false,disabled:false},{id:10,owner:{id:9},full_name:'fixture/public',private:false,default_branch:'main',permissions:{push:true},archived:false,disabled:false}]})
  if (/^\/repos\/fixture\/(private|public)\/branches\/main$/.test(target.pathname)) return json({name:'main'})
  if (target.pathname.includes('/branches/')) return json(null,404)
  if (/^\/repos\/fixture\/(private|public)\/contents\/projects\/[a-f0-9-]+\/revision-[0-9]+\.yaml$/.test(target.pathname)) {
    if (options.method === 'PUT') {publication={path:target.pathname,...JSON.parse(options.body)};return json({commit:{sha:'a'.repeat(40)}})}
    // Preview tests use different repository/revisions; client idempotence has its own transport tests.
    if (publication?.path === target.pathname) {
      const crypto=await import('node:crypto'),content=Buffer.from(publication.content,'base64')
      return json({type:'file',sha:crypto.createHash('sha1').update('blob '+content.length+'\0').update(content).digest('hex')})
    }
    return json(null,404)
  }
  throw Error('Unexpected synthetic GitHub request')
}
