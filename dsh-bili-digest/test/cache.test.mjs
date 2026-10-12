import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachePaths, readJson, writeJsonAtomic, readTextIfExists } from '../src/cache.js'

test('cachePaths 全部是绝对路径且以 bvid 分目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-'))
  const p = cachePaths(dir, 'BV1xx')
  assert.ok(p.probe.startsWith(dir))
  assert.match(p.probe, /BV1xx/)
  assert.equal(p.jobFile('j1').endsWith('job.json'), true)
  await rm(dir, { recursive: true, force: true })
})

test('binDir 与 tmpDir 是 cacheDir 下的兄弟目录，不在 bvid 目录内', () => {
  const dir = join(tmpdir(), 'bd-root')
  const p = cachePaths(dir, 'BV1xx')
  assert.equal(p.binDir, join(dir, 'bin'))
  assert.equal(p.tmpDir, join(dir, 'tmp'))
  assert.equal(p.jobDir('j1'), join(dir, 'jobs', 'j1'))
  assert.equal(p.binDir.startsWith(p.root), false)
  assert.equal(p.tmpDir.startsWith(p.root), false)
})

test('writeJsonAtomic 后可读回，且临时文件不残留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-'))
  const f = join(dir, 'a.json')
  await writeJsonAtomic(f, { x: 1 })
  assert.deepEqual(await readJson(f), { x: 1 })
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(dir), ['a.json'])
  await rm(dir, { recursive: true, force: true })
})

test('readJson 对缺失文件返回 null 而不抛', async () => {
  assert.equal(await readJson(join(tmpdir(), 'definitely-missing-xyz.json')), null)
})

test('readJson 对非法 JSON 返回 null 而不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-'))
  const f = join(dir, 'bad.json')
  await writeFile(f, '{ not json')
  assert.equal(await readJson(f), null)
  await rm(dir, { recursive: true, force: true })
})

test('writeJsonAtomic 自动建父目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-'))
  const f = join(dir, 'deep', 'nested', 'a.json')
  await writeJsonAtomic(f, [1, 2])
  assert.deepEqual(await readJson(f), [1, 2])
  await rm(dir, { recursive: true, force: true })
})

test('readTextIfExists 对缺失文件返回 null', async () => {
  assert.equal(await readTextIfExists(join(tmpdir(), 'nope-abc.txt')), null)
})
