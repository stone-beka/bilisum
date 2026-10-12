import test from 'node:test'
import assert from 'node:assert/strict'
import { BiliDigestError, toCommandError } from '../src/errors.js'

test('BiliDigestError 携带 code 与 hint', () => {
  const e = new BiliDigestError('BAD_INPUT', '坏输入', '请贴完整链接')
  assert.equal(e.code, 'BAD_INPUT')
  assert.equal(e.message, '坏输入')
  assert.equal(e.hint, '请贴完整链接')
  assert.ok(e instanceof Error)
})

test('toCommandError 输出错误结果并包含 hint', () => {
  const r = toCommandError(new BiliDigestError('BAD_INPUT', '坏输入', '请贴完整链接'))
  assert.equal(r.kind, 'error')
  assert.match(r.text, /坏输入/)
  assert.match(r.text, /请贴完整链接/)
})

test('toCommandError 对非 BiliDigestError 兜底', () => {
  const r = toCommandError(new Error('boom'))
  assert.equal(r.kind, 'error')
  assert.match(r.text, /boom/)
})

test('toCommandError 对非 Error 值兜底', () => {
  const r = toCommandError('字符串错误')
  assert.equal(r.kind, 'error')
  assert.match(r.text, /字符串错误/)
})

test('String(err) 为 message', () => {
  const e = new BiliDigestError('BAD_INPUT', '坏输入', '请贴完整链接')
  assert.equal(String(e), '坏输入')
})
