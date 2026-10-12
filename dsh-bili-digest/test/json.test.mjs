import test from 'node:test'
import assert from 'node:assert/strict'
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
