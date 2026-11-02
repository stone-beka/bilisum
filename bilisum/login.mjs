// login.mjs —— B 站扫码续期登录（不用密码、不用复制 cURL）
//
// 背景：速读 / 方向研究都要用登录态（字幕、完整评论、UP 主页投稿）。
// cookie 存在 cache/cookies.txt，一般能用一两个月，过期后以前只能手动复制
// cURL 再跑 set-cookie.mjs。现在改成：跑这个脚本 → 打印一个链接 →
// 你用手机 B 站 App 打开并确认 → 新的 cookie 自动写回本地。
//
// 用法：
//   node login.mjs              # 生成链接并等待扫码（默认等 180 秒）
//   node login.mjs --wait 300   # 多等一会儿
//   node login.mjs --no-wait    # 只生成链接，不等待（调试用）
//   node login.mjs --check      # 只检查当前 cookie 是否还有效
//
// 实测（2026-11-02）：接口在 passport.bilibili.com，不在 api.bilibili.com
// （后者 404/HTML）；B 站必须直连，走 127.0.0.1:7890 会被 412。

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = join(HERE, 'cache')
const COOKIE_FILE = join(CACHE, 'cookies.txt')
mkdirSync(CACHE, { recursive: true })

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** B 站必须直连：清掉进程里的系统代理（走 127.0.0.1:7890 会让接口 412） */
function directNetwork() {
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]
  process.env.NO_PROXY = '*'
  process.env.no_proxy = '*'
}

const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

const argv = process.argv.slice(2)
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const has = (name) => argv.includes('--' + name)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pad = (n) => String(n).padStart(2, '0')
const fmtTime = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

function cookieHeaderFromFile() {
  if (!existsSync(COOKIE_FILE)) return ''
  const parts = []
  for (const line of readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const p = line.split('\t')
    if (p.length >= 7) parts.push(`${p[5]}=${p[6]}`)
  }
  return parts.join('; ')
}

/** 调 nav 判断现在到底是登录还是未登录 */
async function checkCurrent() {
  const ck = cookieHeaderFromFile()
  const headers = { ...HEADERS }
  if (ck) headers.Cookie = ck
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers })
  const text = await r.text()
  if (!text.trimStart().startsWith('{')) throw new Error(`nav 返回非 JSON（HTTP ${r.status}，多半是风控/代理没清）`)
  const j = JSON.parse(text)
  if (j.code !== 0) throw new Error(`nav 接口 code=${j.code} ${j.message ?? ''}`)
  const d = j.data ?? {}
  return { ok: Boolean(d.isLogin), name: d.uname ?? '', mid: d.mid ?? 0, cookieCount: ck ? ck.split('; ').length : 0 }
}

/** 解析一条 Set-Cookie，转成 Netscape cookie 文件的一行（导出以便单测） */
export function setCookieToLine(line) {
  const [pair, ...attrs] = line.split(';').map((s) => s.trim())
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const name = pair.slice(0, eq)
  const value = pair.slice(eq + 1)
  let domain = '.bilibili.com'
  let path = '/'
  let secure = false
  let expires = 0
  for (const a of attrs) {
    const i = a.indexOf('=')
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase()
    const v = i < 0 ? '' : a.slice(i + 1).trim()
    if (k === 'domain' && v) domain = v
    else if (k === 'path' && v) path = v
    else if (k === 'secure') secure = true
    else if (k === 'expires' && v) {
      const t = Date.parse(v)
      if (Number.isFinite(t)) expires = Math.floor(t / 1000)
    } else if (k === 'max-age' && v) {
      const n = Number(v)
      if (Number.isFinite(n)) expires = Math.floor(Date.now() / 1000) + n
    }
  }
  if (!expires) expires = Math.floor(Date.now() / 1000) + 30 * 86400 // 没给就按 30 天记
  return { name, value, domain: domain.startsWith('.') ? domain : '.' + domain, path, secure, expires }
}

async function poll(qrcodeKey, maxWaitSec) {
  const start = Date.now()
  let lastStage = ''
  while (Date.now() - start < maxWaitSec * 1000) {
    const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main-fe-header`
    let r, j
    try {
      r = await fetch(url, { headers: HEADERS })
      const text = await r.text()
      if (!text.trimStart().startsWith('{')) throw new Error(`非 JSON（HTTP ${r.status}）`)
      j = JSON.parse(text)
    } catch (e) {
      process.stdout.write(`\n[轮询出错，1 秒后重试] ${String(e.message).split('\n')[0]}\n`)
      await sleep(1000)
      continue
    }
    const st = j.data?.code
    if (st === 0) return { ok: true, res: r, data: j.data }
    if (st === 86038) return { ok: false, reason: '二维码已失效（太久没扫），重新跑一次就行' }
    if (st === 86090 && lastStage !== 'scanned') {
      process.stdout.write('\n✓ 已扫码，请在手机上点「确认登录」…\n')
      lastStage = 'scanned'
    } else if (st === 86101) {
      if (lastStage !== 'waiting') { process.stdout.write('等待扫码'); lastStage = 'waiting' }
      process.stdout.write('.')
    }
    await sleep(2000)
  }
  return { ok: false, reason: `等了 ${maxWaitSec} 秒还没扫，链接会过期；重新跑一次即可` }
}

if (import.meta.main) {
  directNetwork()
  try {
    if (has('check')) {
      const c = await checkCurrent()
      if (c.ok) console.log(`✓ 登录有效：${c.name}（mid=${c.mid}）· 本地 cookie ${c.cookieCount} 项 · ${COOKIE_FILE}`)
      else {
        console.log('✗ 未登录 / cookie 已过期 —— 跑 `node login.mjs` 扫码续期')
        process.exitCode = 1
      }
    } else {
      // 1) 生成扫码登录链接
      const genRes = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers: HEADERS })
      const genText = await genRes.text()
      if (!genText.trimStart().startsWith('{')) {
        throw new Error(`生成二维码失败：返回 HTML（HTTP ${genRes.status}）—— 检查代理是否清掉、是否被风控`)
      }
      const gen = JSON.parse(genText)
      if (gen.code !== 0) throw new Error(`生成二维码失败 code=${gen.code} ${gen.message ?? ''}`)
      const { url: scanUrl, qrcode_key: qrcodeKey } = gen.data

      console.log('用手机扫这个链接（手机点开会自动跳到 B 站 App，在里面点「确认登录」）：\n')
      console.log(`  ${scanUrl}\n`)
      console.log('链接给的是「登录你的 B 站账号」，确认后只会把 cookie 写到本机：')
      console.log(`  ${COOKIE_FILE}`)
      console.log('（不会保存密码，也不会外传；想失效就去 B 站「退出所有设备」。）\n')

      if (has('no-wait')) {
        console.log('--no-wait：只生成链接，不等扫码。')
      } else {
        const maxWait = Number(flag('wait', '180')) || 180
        console.log(`等待扫码（最多 ${maxWait} 秒）…`)
        const res = await poll(qrcodeKey, maxWait)

        if (!res.ok) {
          console.log(`\n✗ 未完成：${res.reason}`)
          process.exitCode = 1
        } else {
          // 2) 扫码成功：把 Set-Cookie 写成本地 cookie 文件
          const setCookies = typeof res.res.headers.getSetCookie === 'function'
            ? res.res.headers.getSetCookie()
            : (res.res.headers.get('set-cookie') ? [res.res.headers.get('set-cookie')] : [])
          const cookies = setCookies.map(setCookieToLine).filter(Boolean)
          if (!cookies.length) {
            throw new Error('扫码成功了但没拿到 Set-Cookie —— B 站接口可能改版，把这段输出发我排查')
          }

          const lines = [
            '# Netscape HTTP Cookie File',
            `# 由 login.mjs 扫码登录生成于 ${fmtTime()}`,
            '# 不要外传：等价于你的 B 站登录态',
            '',
            ...cookies.map((c) => [c.domain, 'TRUE', c.path, c.secure ? 'TRUE' : 'FALSE', String(c.expires), c.name, c.value].join('\t')),
            '',
          ]
          writeFileSync(COOKIE_FILE, lines.join('\n'), 'utf8')

          // 3) 回读校验：真的登录了才算成功（和 set-cookie.mjs 同一套标准）
          const c = await checkCurrent()
          if (!c.ok) throw new Error('cookie 已写入，但 nav 校验仍显示未登录 —— 这次登录可能没生效，重跑一次')
          console.log(`\n✓ 登录成功：${c.name}（mid=${c.mid}）`)
          console.log(`  cookie ${cookies.length} 项已写入 ${COOKIE_FILE}（含 ${cookies.map((x) => x.name).join(', ')}）`)
          console.log('  现在可以正常跑 bilisum.mjs / research.mjs 了。')
        }
      }
    }
  } catch (e) {
    // 不用 process.exit()：Windows 上 fetch 句柄还没释放就强退会触发 libuv 断言
    console.log(`\n✗ 失败：${String(e.message ?? e)}`)
    process.exitCode = 1
  }
}
