import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
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

test('compact 原样返回 Buffer / TypedArray / ArrayBuffer（二进制不是可递归的普通对象）', () => {
  // Object.entries(Buffer) 给的是 {'0':..,'1':..}，会把 PCM 摊成字节下标对象、
  // 甚至撑爆内存。「所有出口统一过 compact()」这条规矩必须对二进制安全。
  const buf = Buffer.from([0, 255, 128, 7])
  const out = compact({ pcm: buf })
  assert.ok(Buffer.isBuffer(out.pcm), 'compact 必须保留 Buffer')
  assert.equal(Buffer.compare(out.pcm, buf), 0)
  const view = new Uint8Array([1, 2, 3])
  assert.equal(compact({ a: view }).a, view)
  // ArrayBuffer 不是 view（`ArrayBuffer.isView` 为 false），必须单独命中第二个判断；
  // 漏掉它就会被当成普通对象递归，摊成 {} 或字节下标对象。
  const buf2 = new ArrayBuffer(4)
  assert.equal(compact(buf2), buf2, 'compact 必须原样返回 ArrayBuffer')
  assert.equal(compact({ a: buf2 }).a, buf2)
})

test('compact 不修改入参', () => {
  const input = { a: 1, b: undefined }
  compact(input)
  assert.equal('b' in input, true)
})

test('作业快照在内存与磁盘上都是无损 JSON（F21 守门用例）', async () => {
  // 关键：断言必须看**属性是否存在**，不能只看 JSON.stringify 出来的文本。
  // JSON.stringify 本来就会丢掉值为 undefined 的键，所以「序列化结果里没有
  // undefined」这类断言永远成立——它抓不到 compact() 被整个删掉。
  // 真正的暴露面是内存里那个会被直接交给宿主运行时校验的快照对象。
  const dir = await mkdtemp(join(tmpdir(), 'json-'))
  const { Registry } = await import('../src/jobs.js')
  const reg = new Registry(dir)
  const job = await reg.start({
    url: 'u',
    options: { keep: 1, drop: undefined },
    run: async () => ({ ok: 1, nested: { gone: undefined } }),
  })
  const snap = await reg.wait(job.id, 5)
  await reg.dispose()

  // 1) 内存快照——宿主真正校验的那个对象
  assert.equal('drop' in snap.options, false, 'options 里的 undefined 键必须已被剥离')
  assert.equal('gone' in snap.result.nested, false, 'result 里嵌套的 undefined 键必须已被剥离')
  assert.equal(snap.options.keep, 1)

  // 2) 磁盘记录——持久化路径同样要干净
  const raw = JSON.parse(await readFile(join(dir, 'jobs', job.id, 'job.json'), 'utf8'))
  assert.equal('drop' in raw.options, false)
  assert.equal('gone' in raw.result.nested, false)
  assert.equal(raw.result.ok, 1)
  await rm(dir, { recursive: true, force: true })
})
