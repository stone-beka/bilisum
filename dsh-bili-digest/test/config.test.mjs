import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'

test('空配置产出全部默认值', () => {
  const c = resolveConfig()
  assert.equal(c.command, 'bilisum')
  assert.equal(c.windowSeconds, 30)
  assert.equal(c.snapSeconds, 1.5)
  assert.equal(c.audioQuality, 'balanced')
  assert.equal(c.proxy, '')
  assert.equal(c.toolDownloadProxy, 'system')
  assert.equal(c.waitSeconds, 45)
  assert.equal(c.keepTranscript, true)
})

test('windowSeconds 上限 60（F19：120 秒已进入衰退区）', () => {
  assert.equal(resolveConfig({ windowSeconds: 60 }).windowSeconds, 60)
  assert.throws(() => resolveConfig({ windowSeconds: 120 }), (e) => e.code === 'BAD_CONFIG')
  assert.throws(() => resolveConfig({ windowSeconds: 20 }), (e) => e.code === 'BAD_CONFIG')
})

test('audioQuality 只接受三个枚举值', () => {
  assert.equal(resolveConfig({ audioQuality: 'smallest' }).audioQuality, 'smallest')
  assert.throws(() => resolveConfig({ audioQuality: 'ultra' }), (e) => e.code === 'BAD_CONFIG')
})

test('未知配置键被拒绝', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), (e) => e.code === 'BAD_CONFIG')
})

test('cacheDir 为空时由调用方补默认值，resolveConfig 不碰文件系统', () => {
  assert.equal(resolveConfig().cacheDir, '')
})

test('数字类配置拒绝数字字符串（YAML 里写 "30" 是常见笔误）', () => {
  // 只做范围比较会漏掉这个：JS 里 '30' >= 30 为 true，字符串会被原样放行
  for (const key of ['windowSeconds', 'snapSeconds', 'minSegmentSeconds', 'waitSeconds', 'maxDurationSec', 'maxKeyPoints']) {
    assert.throws(() => resolveConfig({ [key]: '30' }), (e) => e.code === 'BAD_CONFIG', `${key} 不应接受字符串`)
  }
})

test('maxKeyPoints 必须是整数', () => {
  assert.throws(() => resolveConfig({ maxKeyPoints: 3.5 }), (e) => e.code === 'BAD_CONFIG')
  assert.equal(resolveConfig({ maxKeyPoints: 5 }).maxKeyPoints, 5)
})

test('原型链上的键名不被当作已知配置项', () => {
  // `key in DEFAULTS` 会走原型链，toString 之类会绕过未知键检查
  assert.throws(() => resolveConfig({ toString: 1 }), (e) => e.code === 'BAD_CONFIG')
})

test('ytDlpTag / ytDlpSha256 必须成对提供（只给 tag 等于关掉校验）', () => {
  assert.equal(resolveConfig({}).ytDlpTag, '')
  assert.equal(resolveConfig({}).ytDlpSha256, '')
  assert.equal(resolveConfig({ ytDlpTag: '2026.08.19', ytDlpSha256: 'a'.repeat(64) }).ytDlpTag, '2026.08.19')
  assert.throws(() => resolveConfig({ ytDlpTag: '2026.08.19' }), (e) => e.code === 'BAD_CONFIG')
  assert.throws(() => resolveConfig({ ytDlpSha256: 'a'.repeat(64) }), (e) => e.code === 'BAD_CONFIG')
})

test('ytDlpSha256 只接受 64 位十六进制（留空合法）', () => {
  assert.equal(resolveConfig({ ytDlpSha256: '' }).ytDlpSha256, '')
  assert.equal(resolveConfig({ ytDlpTag: 't', ytDlpSha256: 'A'.repeat(64) }).ytDlpSha256, 'A'.repeat(64))
  assert.throws(() => resolveConfig({ ytDlpTag: 't', ytDlpSha256: 'abc' }), (e) => e.code === 'BAD_CONFIG')
  assert.throws(() => resolveConfig({ ytDlpTag: 't', ytDlpSha256: 'z'.repeat(64) }), (e) => e.code === 'BAD_CONFIG')
  assert.throws(() => resolveConfig({ ytDlpTag: 42, ytDlpSha256: 'a'.repeat(64) }), (e) => e.code === 'BAD_CONFIG')
})
