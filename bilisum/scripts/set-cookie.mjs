#!/usr/bin/env node
/**
 * 把粘贴来的 B 站 cookie 存成 yt-dlp 能用的 Netscape 格式，并**当场验证登录态**。
 *
 * 用法：
 *   node scripts/set-cookie.mjs "SESSDATA=xxx; bili_jct=yyy; DedeUserID=123"
 *   node scripts/set-cookie.mjs --file <粘贴内容的文件>
 *   node scripts/set-cookie.mjs --check          # 只验证现有的 cookies.txt
 *
 * 为什么需要验证：SESSDATA 会过期，也会因为在别处退出登录而失效。
 * 不验证的话，表现是"字幕莫名其妙取不到"，很难判断是没登录还是这个视频没字幕。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CACHE = join(ROOT, 'cache')
const COOKIE_FILE = join(CACHE, 'cookies.txt')

mkdirSync(CACHE, { recursive: true })

// 我们关心的字段。SESSDATA 是登录态本身；bili_jct 是 CSRF token；
// DedeUserID 标识账号；buvid3/b_nut/sid 是设备指纹，能降低风控概率。
const WANTED = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'b_nut', 'buvid4']

/** 从任意形态的输入里抽出 cookie 键值对：支持 "a=1; b=2"、Netscape 文件、或整段 HTTP 头 */
export function parseCookieInput(text) {
  const out = {}
  const raw = String(text ?? '')

  // 1) Netscape 制表符格式：domain \t flag \t path \t secure \t expiry \t name \t value
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length >= 7) out[parts[5].trim()] = parts[6].trim()
  }

  // 2) "name=value; name2=value2" —— 覆盖前一步，因为通常只有一种形态
  const kv = raw.matchAll(/([A-Za-z0-9_]+)=([^;\s]+)/g)
  for (const m of kv) {
    const k = m[1], v = m[2]
    // 跳过明显不是 cookie 的（例如 URL 里的查询串被误抓）
    if (/^(https?|www|api|t|p|vd_source|spm_id_from|from_source|seid|share_source)$/i.test(k)) continue
    out[k] = v
  }
  return out
}

/** 生成 Netscape 格式。yt-dlp / curl 都认这个。 */
export function toNetscape(cookies, { domain = '.bilibili.com', expiry = 0 } = {}) {
  const lines = ['# Netscape HTTP Cookie File', '# 由 bilisum/scripts/set-cookie.mjs 生成', '']
  for (const [name, value] of Object.entries(cookies)) {
    // domain  TRUE  path  secure  expiry  name  value
    lines.push([domain, 'TRUE', '/', 'FALSE', String(expiry), name, value].join('\t'))
  }
  return lines.join('\n') + '\n'
}

/** 调 nav 接口判断是否真的登录了。B 站必须直连（代理会 412）。 */
async function checkLogin(cookieHeader) {
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Cookie: cookieHeader,
    },
  })
  const text = await res.text()
  let j
  try { j = JSON.parse(text) } catch {
    // 风控时 B 站返回 HTML 而不是 JSON —— 解析前先看状态码
    throw new Error(`B 站返回了非 JSON（HTTP ${res.status}）。如果是 412，多半是走了系统代理。`)
  }
  if (j.code !== 0) throw new Error(`nav 接口 code=${j.code} message=${j.message}`)
  return {
    isLogin: j.data?.isLogin === true,
    uname: j.data?.uname ?? null,
    mid: j.data?.mid ?? null,
    vip: j.data?.vipStatus === 1,
  }
}

// ---------- CLI ----------
const argv = process.argv.slice(2)
const asFile = argv.includes('--file')
const checkOnly = argv.includes('--check')

const run = async () => {
  if (checkOnly) {
    if (!existsSync(COOKIE_FILE)) { console.error(`没有 ${COOKIE_FILE}，先跑一次 set-cookie.mjs 写入`); process.exitCode = 1; return }
    const c = parseCookieInput(readFileSync(COOKIE_FILE, 'utf8'))
    console.log(`已载入 ${Object.keys(c).length} 个 cookie：${Object.keys(c).join(', ')}`)
    if (!c.SESSDATA) { console.error('⚠ 没有 SESSDATA —— 这是匿名 cookie，字幕路线用不了'); process.exitCode = 1; return }
    const r = await checkLogin(Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; '))
    console.log(r.isLogin ? `✓ 登录有效：${r.uname}（mid=${r.mid}${r.vip ? ', 大会员' : ''}）` : '✗ 未登录：SESSDATA 已过期或无效')
    process.exitCode = r.isLogin ? 0 : 1
    return
  }

  const input = asFile ? readFileSync(argv[argv.indexOf('--file') + 1], 'utf8') : argv.filter((a) => !a.startsWith('--')).join(' ')
  if (!input.trim()) {
    console.error('用法：node scripts/set-cookie.mjs "SESSDATA=xxx; bili_jct=yyy"\n      node scripts/set-cookie.mjs --file <文件>\n      node scripts/set-cookie.mjs --check')
    process.exitCode = 2
    return
  }

  const all = parseCookieInput(input)
  const kept = {}
  for (const k of WANTED) if (all[k] !== undefined) kept[k] = all[k]

  if (!kept.SESSDATA) {
    console.error('✗ 输入里没有 SESSDATA —— 那不是登录 cookie。')
    console.error(`  解析到 ${Object.keys(all).length} 个键：${Object.keys(all).slice(0, 12).join(', ')}`)
    process.exitCode = 1
    return
  }

  console.log(`解析出：${Object.keys(all).length} 个 cookie，其中我们关心的有 ${Object.keys(kept).join(', ')}`)

  // 先验证再落盘 —— 别把一个无效 cookie 存下来当成"配好了"
  const r = await checkLogin(Object.entries(all).map(([k, v]) => `${k}=${v}`).join('; '))
  if (!r.isLogin) {
    console.error('✗ SESSDATA 校验未通过：B 站说未登录。可能是复制不全、已过期，或粘贴时漏了字符。')
    process.exitCode = 1
    return
  }
  console.log(`✓ 登录校验通过：${r.uname}（mid=${r.mid}${r.vip ? ', 大会员' : ''}）`)

  // 全量保留（不只是关心的几个）——多带几个设备指纹能降低风控概率
  writeFileSync(COOKIE_FILE, toNetscape(all), 'utf8')
  console.log(`✓ 已写入 ${COOKIE_FILE}（${Object.keys(all).length} 项）`)
  console.log('  该文件已被 .gitignore 排除，不会进版本库。')
}

/**
 * 只设 exitCode，**不要调 process.exit()**。
 * undici（fetch）的 socket 是 libuv 异步句柄，process.exit() 会在它关闭途中强杀进程，
 * Windows 上触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 并给出
 * 退出码 -1073740791 —— 真正的错误信息反而被这个崩溃盖掉。
 */
run().catch((e) => { console.error(`错误：${e.message}`); process.exitCode = 1 })
