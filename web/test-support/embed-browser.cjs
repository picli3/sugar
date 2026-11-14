// Run only against deploy/containers/smoke.py --preview (synthetic data on loopback).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const http = require('node:http')
const assert = require('node:assert/strict')
const base = process.env.EMBED_TEST_URL
if (base !== 'http://localhost:8091') throw Error('EMBED_TEST_URL must target the disposable loopback preview on port 8091')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII='
const pages = new Map()
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">' + (pages.get(req.url) || '') + '</body></html>')
})
async function json(response, status = 200) {
  assert.equal(response.status(), status, await response.text())
  return response.json()
}
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const parent = 'http://127.0.0.1:' + server.address().port
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
  try {
    const owner = await browser.newContext({ viewport: { width: 1400, height: 960 } })
    const reader = await browser.newContext({ viewport: { width: 1000, height: 700 } })
    for (const context of [owner, reader]) {
      await context.route('**/*', route => [base, parent].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort())
    }
    const api = owner.request
    await json(await api.post(base + '/api/login', { data: { email: 'admin@example.invalid', password: 'isolated-container-password' } }))
    await json(await api.patch(base + '/api/me', { data: { theme: 'light', language: 'es' } }))
    const prefix = 'embed-' + Date.now()
    const category = await json(await api.post(base + '/api/categories', { data: { name: prefix, icon: 'power', scope: 'catalog' } }), 201)
    const image = await json(await api.post(base + '/api/images', { data: { name: prefix, mime: 'image/png', data: png } }), 201)
    const diagram = {
      name: prefix, nodes: [
        { id: 'power', position: { x: 0, y: 0 }, block: { name: 'Power supply', function: 'Power', model: 'SUPPLY', category: category.slug, color: '#004466', ports: [{ id: 'out', label: '5V', protocol: 'POWER', direction: 'out', color: '#a300ff' }], properties: { notes: '<script>window.injected=true</script>' } } },
        { id: 'sensor', position: { x: 1200, y: 80 }, block: { name: 'Sensor board', function: 'Read sensors', image: image.url, ports: [{ id: 'in', label: '5V', protocol: 'POWER', direction: 'in' }] } },
      ], edges: [{ id: 'wire', source: 'power', target: 'sensor', sourcePort: 'out', targetPort: 'in' }],
    }
    // Upload API returns the stored image URL; fail if this fixture contract changes.
    assert.match(image.url, /^\/api\/images\//)
    let project = await json(await api.post(base + '/api/projects', { data: { yaml: JSON.stringify(diagram) } }), 201)
    const projectPath = base + '/api/projects/' + project.id
    project = await json(await api.get(projectPath))
    project = await json(await api.patch(projectPath + '/settings', { data: { visibility: 'public', sync_repository: '', sync_branch: 'main', expectedSettingsVersion: project.settings_version } }))
    const admin = await owner.newPage(), errors = []
    admin.on('pageerror', error => errors.push(error.message))
    await admin.goto(base)
    await admin.locator('.project-card').filter({ has: admin.getByRole('heading', { name: prefix, exact: true }) }).getByRole('button', { name: 'Configuración', exact: true }).click()
    await admin.getByRole('button', { name: 'Incrustar HTML', exact: true }).click()
    const code = await admin.getByRole('textbox', { name: 'Incrustar HTML', exact: true }).inputValue()
    assert.ok(code.includes('/embed/public/' + project.id))
    assert.ok(code.includes('lang=es&amp;theme=light'))
    pages.set('/public', code)
    const page = await reader.newPage()
    page.on('pageerror', error => errors.push(error.message))
    let writes = 0
    page.on('request', req => { if (new URL(req.url()).origin === base && !['GET', 'HEAD'].includes(req.method())) writes++ })
    await page.goto(parent + '/public')
    const frame = page.frameLocator('iframe')
    await frame.getByText('Power supply', { exact: true }).waitFor()
    assert.equal(await frame.locator('.vue-flow__node').count(), 2)
    assert.equal(await frame.locator('.sidebar, .inspector, input, textarea').count(), 0)
    await frame.locator('.node-symbol svg').first().waitFor()
    const picture = frame.locator('img.block-symbol-image')
    await picture.waitFor()
    await picture.evaluate(img => img.decode())
    assert.equal(await picture.evaluate(img => img.naturalWidth), 2)
    assert.equal(await frame.locator('.node-header').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 68, 102)')
    assert.equal(await frame.locator('.vue-flow__edge-path').first().evaluate(el => getComputedStyle(el).stroke), 'rgb(163, 0, 255)')
    await frame.getByText('Power supply', { exact: true }).click()
    await frame.locator('.embed-details').getByText('<script>window.injected=true</script>', { exact: true }).waitFor()
    assert.equal(await frame.locator('.embed-details script').count(), 0)
    await frame.getByRole('button', { name: 'Cerrar detalles' }).click()
    const viewport = frame.locator('.vue-flow__transformationpane')
    const initial = await viewport.getAttribute('style')
    await frame.getByRole('button', { name: 'Acercar', exact: true }).click()
    await page.waitForTimeout(400)
    assert.notEqual(await viewport.getAttribute('style'), initial)
    await frame.getByRole('button', { name: 'Ajustar a la vista', exact: true }).click()
    for (const width of [320, 1200]) {
      await page.setViewportSize({ width, height: 700 })
      await page.waitForTimeout(300)
      const size = await frame.locator('.embed-view').boundingBox()
      assert.equal(Math.round(size.width), width)
      assert.ok(size.height >= 320)
      for (const node of await frame.locator('.vue-flow__node').all()) {
        const box = await node.boundingBox()
        assert.ok(box.x >= -1 && box.x + box.width <= width + 1, JSON.stringify({ width, box }))
      }
      assert.ok(await frame.locator('body').evaluate(el => el.scrollWidth <= innerWidth && el.scrollHeight <= innerHeight))
    }
    // The iframe is anonymous, even when the parent has an authenticated Sugar cookie.
    const authenticatedParent = await owner.newPage()
    await authenticatedParent.goto(parent + '/public')
    await authenticatedParent.frameLocator('iframe').getByText('Power supply', { exact: true }).waitFor()
    await authenticatedParent.waitForTimeout(200)
    const anonFetch = await authenticatedParent.frameLocator('iframe').locator('.embed-view').evaluate(async () => {
      const original = window.fetch
      window.requests = []
      window.fetch = (...args) => { window.requests.push(args[1]); return original(...args) }
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise(resolve => setTimeout(resolve, 500))
      return window.requests
    })
    assert.ok(anonFetch.length > 0)
    assert.ok(anonFetch.every(options => options.credentials === 'omit'))
    await authenticatedParent.close()
    // Changes saved after embedding appear without reloading the post.
    diagram.nodes[0].block.name = 'Updated power'
    await json(await api.put(projectPath, { data: { yaml: JSON.stringify(diagram), expectedRevision: project.revision, summary: 'Synthetic update' } }))
    await frame.getByText('Updated power', { exact: true }).waitFor({ timeout: 35000 })
    assert.equal(writes, 0)
    // Transient provider/network errors preserve the last diagram and show retry.
    await reader.route('**/api/public/projects/' + project.id, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
    await frame.locator('.embed-view').evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await frame.getByRole('button', { name: 'Reintentar', exact: true }).waitFor()
    await frame.getByText('Updated power', { exact: true }).waitFor()
    await reader.unroute('**/api/public/projects/' + project.id)
    await frame.getByRole('button', { name: 'Reintentar', exact: true }).click()
    await frame.getByRole('button', { name: 'Reintentar', exact: true }).waitFor({ state: 'hidden' })
    // Public access closes when made private; the already-open iframe clears its data.
    project = await json(await api.get(projectPath))
    project = await json(await api.patch(projectPath + '/settings', { data: { visibility: 'private', sync_repository: '', sync_branch: 'main', expectedSettingsVersion: project.settings_version } }))
    await frame.locator('.embed-view').evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await frame.locator('.vue-flow__node').first().waitFor({ state: 'hidden' })
    await admin.reload()
    await admin.locator('.project-card').filter({ has: admin.getByRole('heading', { name: prefix, exact: true }) }).getByRole('button', { name: 'Configuración', exact: true }).click()
    await admin.getByRole('button', { name: 'Incrustar HTML', exact: true }).click()
    const privateCode = await admin.getByRole('textbox', { name: 'Incrustar HTML', exact: true }).inputValue()
    assert.ok(privateCode.includes('/embed/shared?token='))
    await admin.getByText(/El código contiene el enlace privado/).waitFor()
    pages.set('/private', privateCode.replace('lang=es', 'lang=en').replace('theme=light', 'theme=dark'))
    await page.goto(parent + '/private')
    await frame.getByText('Updated power', { exact: true }).waitFor()
    await frame.getByRole('button', { name: 'Zoom in', exact: true }).waitFor()
    assert.equal(await frame.locator('.embed-view.dark').count(), 1)
    await frame.locator('img.block-symbol-image').evaluate(img => img.decode())
    assert.match(await frame.locator('img.block-symbol-image').getAttribute('src'), /^\/api\/shared\/[A-Za-z0-9_-]{43}\/images\//)
    await json(await api.delete(projectPath + '/share'))
    await frame.locator('.embed-view').evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await frame.locator('.vue-flow__node').first().waitFor({ state: 'hidden' })
    // Authenticated routes remain unframeable at a different origin.
    pages.set('/blocked', '<iframe src="' + base + '/?privacy"></iframe>')
    await page.goto(parent + '/blocked')
    await page.waitForTimeout(500)
    assert.equal(await frame.locator('#app .app-shell').count(), 0)
    assert.deepEqual(errors, [])
    console.log('PASS: real cross-origin embeds, generated HTML, anonymous access, read-only interaction, images/icons/colors, mobile/desktop, ES/EN, polling, transient errors, privacy and revocation')
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1 })
