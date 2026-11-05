import test from 'node:test'
import assert from 'node:assert/strict'
import { stringify, validateBlock, validateProject, normalizeColorLiterals } from './model.js'

const controller = { name: 'Controlador', function: 'Procesar', ports: [{ id: 'i2c', label: 'I²C', protocol: 'I2C', direction: 'bidirectional', maxConnections: 2 }] }
const sensor = { name: 'Sensor', function: 'Medir', ports: [{ id: 'i2c', label: 'I²C', protocol: 'I2C', direction: 'bidirectional', maxConnections: 1 }] }
const node = (id, block) => ({ id, position: { x: 0, y: 0 }, block })

test('validates a portable diagram with two I2C endpoints', () => {
  const doc = { name: 'Termómetro', nodes: [node('mcu', controller), node('sensor', sensor)], edges: [{ id: 'e1', source: 'mcu', sourcePort: 'i2c', target: 'sensor', targetPort: 'i2c' }] }
  assert.equal(validateProject(stringify(doc)).edges.length, 1)
})
test('rejects incompatible protocols and excess connections', () => {
  const spi = { ...sensor, ports: [{ ...sensor.ports[0], protocol: 'SPI' }] }
  const doc = { name: 'Test', nodes: [node('mcu', controller), node('sensor', spi)], edges: [{ id: 'e1', source: 'mcu', sourcePort: 'i2c', target: 'sensor', targetPort: 'i2c' }] }
  assert.throws(() => validateProject(stringify(doc)), /Protocolos incompatibles/)
  doc.nodes[1].block = sensor
  doc.edges.push({ id: 'e2', source: 'mcu', sourcePort: 'i2c', target: 'sensor', targetPort: 'i2c' })
  assert.throws(() => validateProject(stringify(doc)), /Límite de conexiones/)
})
test('validates optional RGB hex colors on ports', () => {
  const colored = { ...sensor, ports: [{ ...sensor.ports[0], color: '#FF0000' }] }
  assert.equal(validateBlock(stringify(colored)).ports[0].color, '#FF0000')
  assert.throws(() => validateBlock(stringify({ ...sensor, ports: [{ ...sensor.ports[0], color: '#F00' }] })), /RGB hexadecimal/)
  const unquoted = 'name: Sensor\nfunction: Medir\nports:\n  - id: power\n    label: 3.3V\n    protocol: POWER\n    direction: out\n    color: #FF0000\n'
  assert.equal(validateBlock(unquoted).ports[0].color, '#FF0000')
  assert.match(normalizeColorLiterals(unquoted), /color: "#FF0000"/)
})
test('validates header colors and notes while keeping older blocks usable', () => {
  assert.equal(validateBlock(stringify(sensor)).color, undefined)
  const changed = { ...sensor, color: '#2040A0', properties: { notes: 'Salida de 3.3 V\nRevisar tolerancia' } }
  assert.equal(validateBlock(stringify(changed)).properties.notes, changed.properties.notes)
  assert.equal(validateProject(stringify({ name: 'Copia', nodes: [node('sensor', changed)], edges: [] })).nodes[0].block.color, '#2040A0')
  assert.equal(validateBlock('name: Sensor\nfunction: Medir\ncolor: #FF0000\nports:\n  - id: p\n    label: P\n    protocol: POWER\n    direction: out\n').color, '#FF0000')
  for (const color of ['red', '#F00', '#GG0000', 42]) assert.throws(() => validateBlock(stringify({ ...changed, color })), /color del bloque/)
  for (const notes of [5, { text: 'x' }, ['x']]) assert.throws(() => validateBlock(stringify({ ...changed, properties: { notes } })), /properties.notes/)
})
test('accepts connection route coordinates and rejects invalid ones', () => {
  const doc = { name: 'Rutas', nodes: [node('mcu', controller), node('sensor', sensor)], edges: [{ id: 'e1', source: 'mcu', sourcePort: 'i2c', target: 'sensor', targetPort: 'i2c', route: { x: 180, y: -25 } }] }
  assert.deepEqual(validateProject(stringify(doc)).edges[0].route, { x: 180, y: -25 })
  doc.edges[0].route = { x: '180', y: -25 }
  assert.throws(() => validateProject(stringify(doc)), /posición de la conexión/)
})
test('matches custom protocol text across ports', () => {
  const custom = protocol => ({ ...sensor, ports: [{ ...sensor.ports[0], protocol }] })
  const doc = { name: 'Personalizado', nodes: [node('a', custom('PAC')), node('b', custom('PAC'))], edges: [{ id: 'e1', source: 'a', sourcePort: 'i2c', target: 'b', targetPort: 'i2c' }] }
  assert.equal(validateProject(stringify(doc)).edges.length, 1)
  doc.nodes[1].block = custom(' CSI ')
  assert.throws(() => validateProject(stringify(doc)), /Protocolos incompatibles/)
  doc.nodes[0].block = custom('CSI')
  assert.equal(validateProject(stringify(doc)).edges.length, 1)
  doc.nodes[1].block = custom('csi')
  assert.throws(() => validateProject(stringify(doc)), /Protocolos incompatibles/)
  assert.throws(() => validateBlock(stringify(custom('   '))), /Puerto inválido/)
})
test('rejects malformed blocks and duplicate YAML keys', () => {
  assert.throws(() => validateBlock('name: Test\nname: Again\n'), /name/)
  assert.throws(() => validateBlock(stringify({ name: 'Test', function: 'x', ports: [] })), /puerto/)
})
test('allows legacy project snapshots but validates category slugs in block YAML', () => {
  assert.equal(validateBlock(stringify({ ...sensor, category: 'sensores', subcategory: 'temperatura' })).subcategory, 'temperatura')
  assert.throws(() => validateBlock(stringify({ ...sensor, category: 'Sensores' })), /category/)
  assert.throws(() => validateBlock(stringify({ ...sensor, subcategory: 'temperatura' })), /subcategory requiere category/)
  assert.equal(validateProject(stringify({ name: 'Anterior', nodes: [node('sensor', sensor)], edges: [] })).nodes.length, 1)
})
test('accepts image URLs and rejects embedded or unsafe images', () => {
  const galleryUrl = '/api/images/123e4567-e89b-42d3-a456-426614174000/content'
  assert.equal(validateBlock(stringify({ ...sensor, image: galleryUrl })).image, galleryUrl)
  assert.throws(() => validateBlock(stringify({ ...sensor, image: 'data:image/png;base64,aGVsbG8=' })), /image debe ser/)
  assert.equal(validateBlock(stringify({ ...sensor, image: 'https://example.com/sensor.png' })).image, 'https://example.com/sensor.png')
  assert.throws(() => validateBlock(stringify({ ...sensor, image: 'javascript:alert(1)' })), /image debe ser/)
})
test('accepts datasheet URLs in block properties and rejects unsafe links', () => {
  for (const url of ['https://example.com/datasheet.pdf', 'http://example.com/details']) {
    assert.equal(validateBlock(stringify({ ...sensor, properties: { url, range: '0..100' } })).properties.url, url)
  }
  for (const url of ['javascript:alert(1)', '/local/path', 'not a URL', 42]) {
    assert.throws(() => validateBlock(stringify({ ...sensor, properties: { url } })), /properties.url/)
  }
})
test('accepts multiple named links and rejects malformed link lists', () => {
  const urls = [{ datasheet: 'https://example.com/sensor.html' }, { paper: 'https://example.com/sensor.pdf' }]
  assert.deepEqual(validateBlock(stringify({ ...sensor, properties: { range: '-40..85 °C', urls } })).properties.urls, urls)
  for (const invalid of [
    { datasheet: 'javascript:alert(1)' },
    { datasheet: 'https://example.com', paper: 'https://example.com/paper' },
    { datasheet: 123 },
    {},
  ]) assert.throws(() => validateBlock(stringify({ ...sensor, properties: { urls: [invalid] } })), /properties.urls/)
  assert.throws(() => validateBlock(stringify({ ...sensor, properties: { urls: 'https://example.com' } })), /properties.urls/)
})

test('accepts independent target leg coordinates and rejects invalid targetX',()=>{
  const doc={name:'Separate target leg',nodes:[node('mcu',controller),node('sensor',sensor)],edges:[{id:'e1',source:'mcu',target:'sensor',sourcePort:'i2c',targetPort:'i2c',route:{x:800,y:50,targetX:-80}}]}
  assert.equal(validateProject(stringify(doc)).edges[0].route.targetX,-80)
  for(const value of ['80',null,Infinity]) { doc.edges[0].route.targetX=value; assert.throws(()=>validateProject(stringify(doc)),/targetX válida/) }
})

test('connection errors name the block and port and say how to fix them, in both languages', () => {
  const block = (name, ports) => ({ name, function: 'f', ports })
  const project = (edges, source, target) => stringify({ name: 'x', nodes: [{ id: 'a', position: { x: 0, y: 0 }, block: block('MCU', source) }, { id: 'b', position: { x: 1, y: 1 }, block: block('IMU', target) }], edges })
  const edge = { id: 'e', source: 'a', target: 'b', sourcePort: 's', targetPort: 't' }
  assert.throws(() => validateProject(project([edge], [{ id: 's', label: 'SPI', protocol: 'SPI', direction: 'out' }], [{ id: 't', label: 'I2C', protocol: 'I2C', direction: 'in' }])),
    /Protocolos incompatibles: SPI y I2C\. Conecta puertos del mismo protocolo \(MCU · SPI → IMU · I2C\) \/ Incompatible protocols/)
  assert.throws(() => validateProject(project([edge], [{ id: 's', label: 'MOSI', protocol: 'SPI', direction: 'in' }], [{ id: 't', label: 'SPI', protocol: 'SPI', direction: 'in' }])),
    /Dirección de puertos incompatible \(MCU · MOSI: in → IMU · SPI: in\)\. Conecta desde una salida .* \/ Incompatible port direction/)
  assert.throws(() => validateProject(project([edge, { ...edge, id: 'f' }], [{ id: 's', label: '5V', protocol: 'POWER', direction: 'out' }], [{ id: 't', label: 'VIN', protocol: 'POWER', direction: 'in', maxConnections: 1 }])),
    /Límite de conexiones excedido: IMU · VIN admite 1\. Quita una conexión .* \/ Connection limit exceeded/)
  assert.throws(() => validateProject(project([{ ...edge, targetPort: 'missing' }], [{ id: 's', label: 'SPI', protocol: 'SPI', direction: 'out' }], [{ id: 't', label: 'SPI', protocol: 'SPI', direction: 'in' }])),
    /puerto inexistente \(IMU · missing\); revisa sourcePort y targetPort/)
})
