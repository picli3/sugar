import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createZipWriter, safeEntryName } from './zip.js'
import { readZip } from '../../test-support/zip.js'

test('streams valid deflated entries readable by standard tools, with UTF-8 names', async () => {
  const chunks = [], zip = createZipWriter(async chunk => { chunks.push(chunk) })
  await zip.add('cuenta/account.json', JSON.stringify({ name: 'Ana Diseño' }), new Date('2026-11-05T10:00:00Z'))
  await zip.add('proyectos/Señal ñ/1.yaml', 'name: Señal\nnodes: []\n')
  await zip.add('images/pixel.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  await zip.close(); await zip.close()
  const archive = Buffer.concat(chunks), entries = readZip(archive)
  assert.deepEqual([...entries.keys()], ['cuenta/account.json', 'proyectos/Señal ñ/1.yaml', 'images/pixel.png'])
  assert.equal(entries.get('proyectos/Señal ñ/1.yaml').toString(), 'name: Señal\nnodes: []\n')
  await assert.rejects(zip.add('late.txt', 'x'), /closed/)
  // Cross-check with an independent implementation when available.
  const dir = mkdtempSync(join(tmpdir(), 'sugar-zip-'))
  try {
    writeFileSync(join(dir, 'export.zip'), archive)
    const listing = execFileSync('python3', ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("\\n".join(z.namelist()))', join(dir, 'export.zip')]).toString().trim().split('\n')
    assert.deepEqual(listing, [...entries.keys()])
  } catch (error) { if (error.code !== 'ENOENT') throw error } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('entry names cannot escape the extraction directory', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', 'a/./b', 'nul\u0000.txt', 'x'.repeat(513)]) assert.throws(() => safeEntryName(bad))
  assert.equal(safeEntryName('projects/Ñandú/1.yaml'), 'projects/Ñandú/1.yaml')
})
