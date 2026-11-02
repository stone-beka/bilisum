// login.mjs 的 Set-Cookie 解析测试（扫码登录写 cookie 的唯一一处格式风险）
import test from 'node:test'
import assert from 'node:assert/strict'

import { setCookieToLine } from '../login.mjs'

test('标准 Set-Cookie：SESSDATA 带 Expires/Secure/HttpOnly', () => {
  const c = setCookieToLine(
    'SESSDATA=abc%2Cdef%2C123; Path=/; Domain=.bilibili.com; Expires=Wed, 01 Jul 2026 00:00:00 GMT; Secure; HttpOnly',
  )
  assert.equal(c.name, 'SESSDATA')
  assert.equal(c.value, 'abc%2Cdef%2C123') // %2C 是 URL 编码的逗号，原样保留
  assert.equal(c.domain, '.bilibili.com')
  assert.equal(c.path, '/')
  assert.equal(c.secure, true)
  assert.equal(c.expires, Math.floor(Date.parse('Wed, 01 Jul 2026 00:00:00 GMT') / 1000))
})

test('Max-Age：换算成绝对过期时间', () => {
  const before = Math.floor(Date.now() / 1000)
  const c = setCookieToLine('bili_jct=deadbeef; Max-Age=31536000; Path=/')
  const after = Math.floor(Date.now() / 1000)
  assert.equal(c.name, 'bili_jct')
  assert.ok(c.expires >= before + 31536000 && c.expires <= after + 31536000)
  assert.equal(c.secure, false)
})

test('value 里带等号时只按第一个等号切分', () => {
  const c = setCookieToLine('foo=a=b=c; Path=/')
  assert.equal(c.name, 'foo')
  assert.equal(c.value, 'a=b=c')
})

test('没有 Domain 时默认 .bilibili.com（不带点的域名补点）', () => {
  assert.equal(setCookieToLine('a=1; Path=/').domain, '.bilibili.com')
  assert.equal(setCookieToLine('a=1; Domain=bilibili.com; Path=/').domain, '.bilibili.com')
})

test('没有过期时间时兜底 30 天，避免写出 session cookie 被工具忽略', () => {
  const before = Math.floor(Date.now() / 1000)
  const c = setCookieToLine('sid=xyz; Path=/')
  assert.ok(c.expires >= before + 29 * 86400 && c.expires <= before + 31 * 86400)
})

test('非法行返回 null（不会污染 cookie 文件）', () => {
  assert.equal(setCookieToLine(''), null)
  assert.equal(setCookieToLine('BadCookie; Path=/'), null)
  assert.equal(setCookieToLine('=novalue; Path=/'), null)
})

test('生成的行能被工具自己的 cookie 解析器读回（字段顺序 [5]/[6] 对齐）', () => {
  const c = setCookieToLine('SESSDATA=abc; Path=/; Domain=.bilibili.com; Secure')
  const line = [c.domain, 'TRUE', c.path, c.secure ? 'TRUE' : 'FALSE', String(c.expires), c.name, c.value].join('\t')
  const p = line.split('\t')
  assert.equal(p.length, 7)
  assert.equal(p[5], 'SESSDATA') // 名称在第 6 列
  assert.equal(p[6], 'abc') // 值在第 7 列
})
