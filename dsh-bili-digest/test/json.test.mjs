import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compact } from '../src/json.js'

test('compact 剥离顶层 undefined 键', () => {
  assert.deepEqual(compact({ a: 1, b: undefined }), { a: 1 })
})

test('compact 递归处理嵌套对象', () => {
  assert.deepEqual(
    compact({ a: { b: undefined, c: 2 }, d: [{ e: undefined, f: 3 }] }),
    { a: { c: 2 }, d: [{ f: 3 }] },
  )
})

test('compact 保留 null 与 false 与 0 与空串', () => {
  assert.deepEqual(compact({ a: null, b: false, c: 0, d: '' }), { a: null, b: false, c: 0, d: '' })
})

test('compact 保持数组顺序与长度', () => {
  assert.deepEqual(compact([1, undefined, 2]), [1, undefined, 2])
})

test('compact 原样返回标量', () => {
  assert.equal(compact(5), 5)
  assert.equal(compact('x'), 'x')
  assert.equal(compact(null), null)
})

test('compact 不修改入参', () => {
  const input = { a: 1, b: undefined }
  compact(input)
  assert.equal('b' in input, true)
})

test('真实作业记录过 compact 后是无损 JSON（F21 守门用例）', async () => {
  // 这条必须跑**磁盘上的真实作业记录**，而不是合成的对象：
  // 宿主的无损 JSON 校验发生在运行时出口，合成对象覆盖不到
  // 「落盘记录里某个字段是 undefined」这个唯一的真实失败路径。
  const dir = await mkdtemp(join(tmpdir(), 'json-'))
  const { Registry } = await import('../src/jobs.js')
  const reg = new Registry(dir)
  const job = await reg.start({
    url: 'u',
    options: { keep: 1, drop: undefined },
    run: async () => ({ ok: 1, nested: { gone: undefined } }),
  })
  await reg.wait(job.id, 5)
  await reg.dispose()

  const raw = JSON.parse(await readFile(join(dir, 'jobs', job.id, 'job.json'), 'utf8'))
  const text = JSON.stringify(compact(raw))
  assert.ok(!text.includes('undefined'), `序列化结果里不应出现 undefined：${text}`)
  assert.equal(JSON.parse(text).result.ok, 1)
  assert.equal('gone' in JSON.parse(text).result.nested, false)
  await rm(dir, { recursive: true, force: true })
})
