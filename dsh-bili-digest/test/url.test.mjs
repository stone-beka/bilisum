import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrl, isAllowed } from '../src/media/url.js'

/**
 * plan-amended（brief 用例与 brief 实现片段互斥）：
 * brief 原用例断言 normalizeUrl('bv1gj411x7h7').bvid === 'BV1GJ411x7h7'，
 * 而 brief 的 Step 3 实现片段用 text.toUpperCase() —— 得到 'BV1GJ411X7H7'，同样过不了。
 * BV 号 body 是大小写敏感的 base58 标识符，全小写输入无法在纯函数里还原规范大小写
 * （需要网络查询；BVID↔aid 算法对已丢失大小写的输入不可逆）。按任务说明的裁决
 * 「规整规范 BV 前缀 + 保留 body 原始大小写」实现：只把 `bv` 前缀规整为 `BV`，
 * 绝不改写 body 大小写（改写会指向另一个视频）。下面用两条用例覆盖该规则，
 * 其中「前缀小写 + body 正确」是可精确还原的真实场景。
 */

test('裸 BV 号归一化为视频页 URL', () => {
  const r = normalizeUrl('BV1GJ411x7h7')
  assert.equal(r.bvid, 'BV1GJ411x7h7')
  assert.equal(r.url, 'https://www.bilibili.com/video/BV1GJ411x7h7')
  assert.equal(r.page, 1)
})

test('裸 BV 号只规整前缀大小写，不篡改 body', () => {
  assert.equal(normalizeUrl('bv1gj411x7h7').bvid, 'BV1gj411x7h7')
})

test('前缀小写但 body 正确时被精确还原', () => {
  const r = normalizeUrl('bv1GJ411x7h7')
  assert.equal(r.bvid, 'BV1GJ411x7h7')
  assert.equal(r.url, 'https://www.bilibili.com/video/BV1GJ411x7h7')
})

test('输入首尾空白被裁掉', () => {
  assert.equal(normalizeUrl('  BV1GJ411x7h7  ').bvid, 'BV1GJ411x7h7')
})

test('完整 URL 透传并抽出分P', () => {
  const r = normalizeUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=3&t=10')
  assert.equal(r.bvid, 'BV1GJ411x7h7')
  assert.equal(r.page, 3)
  assert.match(r.url, /p=3/)
  assert.doesNotMatch(r.url, /t=10/)
})

test('完整 URL 只保留 p 参数，跟踪参数被剥掉', () => {
  const r = normalizeUrl(
    'https://www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=333.999&vd_source=abc&t=10&p=3',
  )
  assert.equal(r.url, 'https://www.bilibili.com/video/BV1GJ411x7h7?p=3')
  assert.equal(r.page, 3)
})

test('p 非法或非正数时回落为 1 且不写回 URL', () => {
  const base = 'https://www.bilibili.com/video/BV1GJ411x7h7'
  assert.equal(normalizeUrl(`${base}?p=0`).page, 1)
  assert.equal(normalizeUrl(`${base}?p=0`).url, base)
  assert.equal(normalizeUrl(`${base}?p=abc`).page, 1)
})

test('完整 URL 中前缀小写的 BV 号也抽出为规范前缀', () => {
  assert.equal(
    normalizeUrl('https://www.bilibili.com/video/bv1GJ411x7h7').bvid,
    'BV1GJ411x7h7',
  )
})

test('路径里超长的 BV 串不被截断成 10 位', () => {
  assert.equal(
    normalizeUrl('https://www.bilibili.com/video/BV1234567890abc').bvid,
    null,
  )
})

test('av 号归一化为 av 形式 URL', () => {
  const r = normalizeUrl('av80433022')
  assert.equal(r.bvid, null)
  assert.equal(r.page, 1)
  assert.match(r.url, /\/video\/av80433022/)
})

test('b23.tv 短链原样透传，不做网络请求', () => {
  const r = normalizeUrl('https://b23.tv/abc123')
  assert.equal(r.url, 'https://b23.tv/abc123')
  assert.equal(r.bvid, null)
  assert.equal(r.page, 1)
})

test('空输入抛 BAD_INPUT', () => {
  assert.throws(() => normalizeUrl('   '), (e) => e.code === 'BAD_INPUT')
})

test('非法输入抛 BAD_INPUT', () => {
  assert.throws(() => normalizeUrl('随便什么'), (e) => e.code === 'BAD_INPUT')
  assert.throws(() => normalizeUrl('BV123'), (e) => e.code === 'BAD_INPUT')
  assert.throws(() => normalizeUrl(null), (e) => e.code === 'BAD_INPUT')
})

test('file: 协议被拒绝', () => {
  assert.throws(() => normalizeUrl('file:///C:/secret.mp4'), (e) => e.code === 'UNSUPPORTED_URL')
})

test('非白名单站点抛 UNSUPPORTED_URL（而非 BAD_INPUT）', () => {
  const isUnsupported = (e) => e.code === 'UNSUPPORTED_URL'
  assert.throws(() => normalizeUrl('https://evil.com/video/BV1GJ411x7h7'), isUnsupported)
  assert.throws(() => normalizeUrl('https://evil-bilibili.com/video/BV1GJ411x7h7'), isUnsupported)
  assert.throws(() => normalizeUrl('http://127.0.0.1:8080/x'), isUnsupported)
})

test('isAllowed 放行 B站与短链域名', () => {
  assert.equal(isAllowed('https://www.bilibili.com/video/BV1GJ411x7h7'), true)
  assert.equal(isAllowed('https://b23.tv/abc'), true)
  assert.equal(isAllowed('https://m.bilibili.com/video/BV1GJ411x7h7'), true)
  assert.equal(isAllowed('https://bilibili.com/video/BV1GJ411x7h7'), true)
  assert.equal(isAllowed('http://b23.tv/abc'), true)
  assert.equal(isAllowed('https://www.bilibili.tv/en/video/2044540'), true)
})

test('isAllowed 挡掉非白名单域名与协议', () => {
  assert.equal(isAllowed('https://evil.com/video/BV1GJ411x7h7'), false)
  assert.equal(isAllowed('file:///C:/x'), false)
  assert.equal(isAllowed('http://127.0.0.1:8080/x'), false)
  assert.equal(isAllowed('not a url'), false)
})

test('isAllowed 挡掉后缀伪造与 userinfo 欺骗', () => {
  assert.equal(isAllowed('https://evil-bilibili.com/x'), false)
  assert.equal(isAllowed('https://bilibili.com.evil.com/x'), false)
  assert.equal(isAllowed('https://notbilibili.com/x'), false)
  assert.equal(isAllowed('https://www.bilibili.com@evil.com/x'), false)
  assert.equal(isAllowed('ftp://www.bilibili.com/x'), false)
  assert.equal(isAllowed('javascript:alert(1)'), false)
})
