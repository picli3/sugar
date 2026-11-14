const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

export function embedTarget(pathname: string, search: string) {
  const params = new URLSearchParams(search)
  const publicId = new RegExp('^/embed/public/(' + uuid + ')$').exec(pathname)?.[1]
  if (publicId) return { apiPath: '/public/projects/' + publicId, shareToken: null, openPath: '/?public=' + publicId }
  const token = params.get('token')
  if (pathname === '/embed/shared' && token && tokenPattern.test(token)) {
    return { apiPath: '/shared/' + token, shareToken: token, openPath: '/?share=' + token }
  }
  return null
}

export function embedMarkup(origin: string, sharePath: string, name: string, language: 'es' | 'en', theme: 'light' | 'dark') {
  const base = new URL(origin)
  const shared = new URL(sharePath, base)
  if (!['http:', 'https:'].includes(base.protocol) || shared.origin !== base.origin || shared.pathname !== '/') throw Error('Invalid share URL')
  const id = shared.searchParams.get('public'), token = shared.searchParams.get('share')
  let path
  if (id && new RegExp('^' + uuid + '$').test(id)) path = '/embed/public/' + id
  else if (token && tokenPattern.test(token)) path = '/embed/shared?token=' + token
  else throw Error('Invalid share URL')
  const url = new URL(path, base)
  url.searchParams.set('lang', language)
  url.searchParams.set('theme', theme)
  return '<div style="position:relative;width:100%;aspect-ratio:16/9;min-height:320px">\n' +
    '  <iframe src="' + escapeAttribute(url.href) + '" title="' + escapeAttribute(name) + '"\n' +
    '    style="position:absolute;inset:0;width:100%;height:100%;border:0;display:block"\n' +
    '    loading="lazy" referrerpolicy="no-referrer" allowfullscreen></iframe>\n</div>'
}
