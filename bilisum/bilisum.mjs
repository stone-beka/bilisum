#!/usr/bin/env node
/**
 * bilisum —— B 站视频 → 带时间戳的转写文本
 *
 * 设计要点（都是实测逼出来的，改之前先看注释）：
 *  - B 站必须**直连**：系统代理 127.0.0.1:7890 会让 api.bilibili.com 返回 412
 *  - yt-dlp.exe 是 PyInstaller 单文件包，必须把 TEMP/TMP/TMPDIR 指到可写目录，否则
 *    报 "Could not create temporary directory!" 直接退出
 *  - BV 号 body 大小写敏感：bv1gj411x7h7 会解析成**另一个真实视频**，只可规整 BV 前缀
 *  - ffmpeg 的 WAV 头不规范（插 LIST/INFO/fact，data 在 offset 78），所以走**裸 PCM**
 *  - 长音频必须分窗：SenseVoice 整段吃会静默返回空文本、退出码仍是 0
 *
 * 默认产出策略（2026-10-13 起，用户指定）：
 *   **唯一交付物是《速读稿》，只含两节：30 秒速读 + 重点提炼。**
 *   其余一律默认不产出——中文全文稿、原始转写、名词校正表、关键数字表、方法说明，用户都不看。
 *   所以本工具默认不再往 out/ 写转写：转写降级为中间产物，落 cache/<BV>.transcript.md，
 *   供会话里的模型读完写《速读稿》。要单独留一份正式转写，显式加 --full。
 *
 * 评论（2026-10-15 用户新增要求：速读稿末尾要有「我的看法」+「热门评论分析（10 条左右）」）：
 *   转写文件头里会**自动带上热门评论块**（默认 40 条），模型写速读稿时就地取材。
 *   为什么必须写进文件头：模型只读这个文件，写在别处它不一定看得到。
 *
 * 用法：
 *   node bilisum.mjs probe    <url> [--cookie <file>]   # 只看标题/时长/有无字幕（不取评论）
 *   node bilisum.mjs subs     <url> --cookie <file>     # 只要官方字幕
 *   node bilisum.mjs asr      <url>                     # 只要本地识别
 *   node bilisum.mjs get      <url> [--cookie <file>]   # 字幕优先，失败落 ASR（日常用这个）
 *   node bilisum.mjs comments <url> [--top 40]          # 只看热门评论
 *   # 默认：转写落 cache/，只在终端打摘要；--full 写正式转写到 out/，--preview 打开头三段
 *   # --top N 限制评论条数；--no-comments 取转写时不抓评论
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, 'scripts')
const CACHE = join(HERE, 'cache')
const MODELS = join(HERE, 'models')
const OUT = join(HERE, 'out')
const YTDLP = join(BIN, 'yt-dlp.exe')
const FFMPEG = join(BIN, 'ffmpeg.exe')

const MODEL = join(MODELS, 'sensevoice-onnx', 'model.int8.onnx')
const TOKENS = join(MODELS, 'sensevoice-onnx', 'tokens.txt')
const VAD = join(MODELS, 'silero', 'silero_vad.onnx')

// ---------- 窗口参数（规格 F19/F20，来自同源项目实测）----------
const WINDOW_SEC = 30     // 目标窗长
const SNAP_SEC = 1.5      // 切点在此范围内吸附到能量最低处
const MIN_WIN = 15
const MAX_WIN = 60
const RATE = 16000

for (const d of [CACHE, OUT]) mkdirSync(d, { recursive: true })

/**
 * 子进程环境。
 * - 强制清空代理：B 站走代理必 412。Python 的 getproxies() 会读 Windows 注册表，
 *   所以只清 HTTP_PROXY 不够，必须同时设 NO_PROXY=*。
 * - TEMP/TMP/TMPDIR 必须可写：PyInstaller onefile 解包依赖它。
 */
function childEnv({ proxy = 'direct' } = {}) {
  const env = { ...process.env, TEMP: CACHE, TMP: CACHE, TMPDIR: CACHE }
  if (proxy === 'direct') {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) env[k] = ''
    env.NO_PROXY = '*'
    env.no_proxy = '*'
  }
  return env
}

/** 跑一个子进程，返回 { code, stdout, stderr }。二进制用 encoding:null。 */
function run(exe, args, { encoding = 'utf8', maxBuffer = 1024 * 1024 * 1024, proxy = 'direct' } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(exe, args, { env: childEnv({ proxy }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = [], err = []
    let size = 0
    child.stdout.on('data', (d) => { size += d.length; if (size > maxBuffer) { child.kill(); rej(new Error('输出超过缓冲上限')) } else out.push(d) })
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', rej)
    child.on('close', (code) => {
      const buf = Buffer.concat(out)
      const e = Buffer.concat(err)
      res({ code, stdout: encoding ? buf.toString(encoding) : buf, stderr: encoding ? e.toString(encoding) : e })
    })
  })
}

// ---------- URL 归一化 ----------
const HOSTS = ['bilibili.com', 'b23.tv', 'biligame.com']
function hostAllowed(h) { return HOSTS.some((a) => h === a || h.endsWith('.' + a)) }

function normalizeUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('没有给出视频地址')
  // 裸 BV：**只规整 BV 前缀，body 一个字都不动**（body 大小写敏感，改了就是改视频）
  const bv = /^([Bb][Vv])([0-9A-Za-z]{10})$/.exec(text)
  if (bv) return `https://www.bilibili.com/video/BV${bv[2]}`
  if (/^[Aa][Vv]\d+$/.test(text)) return `https://www.bilibili.com/video/${text}`
  let u
  try { u = new URL(text) } catch { throw new Error(`无法识别为视频地址：${text}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只接受 http(s) 链接')
  if (!hostAllowed(u.hostname)) throw new Error(`不支持的站点：${u.hostname}`)
  return u.toString()
}

/**
 * 重试。
 *
 * 实测更正：早先观察到的"连续 3 次成功/失败/成功"**是突发限流**——我在短时间内
 * 连打了排行榜、搜索、多次探测，被 B 站限了。退开之后同一命令 6/6 全成。
 * 所以正常情况下**不需要** cookie；重试是为了顶住偶发限流与网络抖动，不是常态。
 * （登录 cookie 解决的是另一件事：字幕**可用性**。匿名状态实测字幕命中 0/40。）
 */
async function withRetry(label, fn, { attempts = 4, baseMs = 1200 } = {}) {
  let last
  for (let i = 1; i <= attempts; i++) {
    try { return await fn() } catch (e) {
      last = e
      if (i === attempts) break
      process.stderr.write(`[retry] ${label} 第 ${i} 次失败：${String(e.message).split('\n')[0]}\n`)
      await new Promise((r) => setTimeout(r, baseMs * i))
    }
  }
  throw last
}

// ---------- 探测 ----------
async function probe(url) {
  const normalized = normalizeUrl(url)
  return withRetry('probe', async () => {
  const args = [
    '--proxy=', '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings',
  ]
  if (cookieFile) args.push('--cookies', cookieFile)
  args.push(normalized)
  const r = await run(YTDLP, args)
  if (r.code !== 0) {
    const tail = (r.stderr || '').split(/\r?\n/).slice(-6).join('\n')
    // B 站风控返 412 + HTML 错误页，不是 JSON——先看状态码再解析
    if (/412|Precondition Failed/i.test(r.stderr || '')) {
      throw new Error(`B 站风控拦截（HTTP 412）。通常是代理问题——B 站必须直连。\n${tail}`)
    }
    // 视频被删/设为私密/仅会员可见时，yt-dlp 抛的是 KeyError('bvid') 这类内部错误，
    // 对用户完全不可读。这里翻译成人话，并给出下一步。
    if (/KeyError\('bvid'\)|Unable to extract|not available|404|不存在|已删除/i.test(r.stderr || '')) {
      throw new Error(
        `取不到这条视频。常见原因：\n` +
        `  · 视频已被删除 / 设为私密 / 仅限会员或充电专属\n` +
        `  · BV 号抄错（注意大小写，body 区分大小写）\n` +
        `  · yt-dlp 版本过旧，B 站改了接口（跑 node bilisum.mjs doctor 看环境）\n` +
        `原始报错：${tail.split('\n')[0]}`,
      )
    }
    throw new Error(`yt-dlp 探测失败（退出码 ${r.code}）：\n${tail}`)
  }
  let info
  try { info = JSON.parse(r.stdout) } catch { throw new Error('yt-dlp 输出不是合法 JSON（可能是风控错误页）') }
  // 基本信息（粉丝数/播放量/发布时间…）走 B 站公开接口补，yt-dlp 没有这些字段。
  // 挂了也不影响探测本身——速读稿会少基本信息，但流程继续。
  // 注意：yt-dlp 的 id 带 `_pN` 后缀，必须先剥掉才是合法 bvid（见 bareBvid）。
  const rawId = info.id ?? null
  const bvid = bareBvid(rawId) ?? rawId
  const meta = await metaFromApi(bvid).catch(() => null)
  return {
    url: normalized,
    bvid,
    page: pageOf(rawId),
    title: (info.title ?? '').trim() || info.id,
    duration: Number.isFinite(info.duration) ? info.duration : null,
    uploader: meta?.author ?? info.uploader ?? null,
    meta,
    subs: Object.keys(info.subtitles ?? {}),
    autoSubs: Object.keys(info.automatic_captions ?? {}),
    audioFormats: (info.formats ?? [])
      .filter((f) => f.vcodec === 'none' && f.acodec !== 'none')
      .map((f) => ({ id: f.format_id, ext: f.ext, abr: f.abr ?? null, acodec: f.acodec })),
    chapters: (info.chapters ?? []).map((c) => ({ start: c.start_time, title: c.title })),
  }
  })
}

// ---------- 字幕 ----------
/** 解析 SRT → [{start, end, text}]（秒） */
export function parseSrt(text) {
  const out = []
  const blocks = text.replace(/\r/g, '').split(/\n\n+/)
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '')
    if (lines.length < 2) continue
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(b)
    if (!m) continue
    const toSec = (h, mi, s, ms) => (+h) * 3600 + (+mi) * 60 + (+s) + (+ms) / 1000
    const start = toSec(m[1], m[2], m[3], m[4])
    const end = toSec(m[5], m[6], m[7], m[8])
    const body = lines[lines.length - 1]
    // SRT 首行是序号，字幕正文可能在时间轴之后多行，这里取时间轴之后的所有行
    const idx = lines.findIndex((l) => l.includes('-->'))
    const txt = lines.slice(idx + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    if (txt) out.push({ start, end, text: txt || body })
  }
  return out
}

// ---------- B 站官方 API 直取字幕 ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

/** 把 Netscape cookie 文件转成 Cookie 请求头。 */
export function cookieHeaderFrom(netscape) {
  const pairs = []
  for (const line of String(netscape ?? '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const p = line.split('\t')
    if (p.length >= 7) pairs.push(`${p[5]}=${p[6]}`)
  }
  return pairs.length ? pairs.join('; ') : null
}

function currentCookieHeader() {
  if (!cookieFile || !existsSync(cookieFile)) return null
  return cookieHeaderFrom(readFileSync(cookieFile, 'utf8'))
}

/**
 * 调 B 站 web 接口。注意：**必须直连**——Node 的 fetch(undici) 默认不读
 * HTTP_PROXY 环境变量，所以这里是直连，正好符合 B 站的要求。
 * cookieOverride 只在极少数场景用（显式传 cookie 头），一般留空走 cookies.txt。
 */
async function biliApi(path, cookieOverride = null) {
  const ck = cookieOverride ?? currentCookieHeader()
  const res = await fetch(`https://api.bilibili.com${path}`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(ck ? { Cookie: ck } : {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`B 站接口 HTTP ${res.status}`)
  let j
  // 先看状态码与内容，再解析——风控时返回的是 HTML 错误页，直接 JSON.parse 只会给出误导性的语法错误
  try { j = JSON.parse(text) } catch { throw new Error(`B 站接口返回非 JSON（HTTP ${res.status}，可能被风控）`) }
  if (j.code !== 0) throw new Error(`B 站接口 code=${j.code} ${j.message}`)
  return j.data
}

/** 从规范化 URL 里取视频标识参数。 */
export function videoParam(url) {
  const av = /\/av(\d+)/i.exec(url)
  if (av) return `aid=${av[1]}`
  const bv = /\/video\/(BV[0-9A-Za-z]+)/.exec(url)
  if (bv) return `bvid=${bv[1]}`
  throw new Error(`无法从 URL 里取到视频标识：${url}`)
}

/**
 * yt-dlp 对 B 站给出的 `info.id` 是 `BV<10 位>_p<页码>`——**单 P 视频也带 `_p1`**。
 *
 * 这个带页码的串**不是合法 bvid**：`/x/web-interface/view?bvid=BV…_p1` 会直接
 * `code=-400 请求错误`。而 `b23.tv` 短链（手机分享出来的常态）URL 里没有 BV，
 * 只能靠 yt-dlp 的这个 id 兜底，于是整条链路会同时坏两处：
 *   1. 视频基本信息（作者粉丝数 / 播放量 / 发布时间…）**全部拿不到**；
 *   2. 官方字幕的兜底请求也 400，被迫退回慢得多的本地 ASR。
 *
 * 这里只做一件事：剥掉 `_pN`。BV body **大小写敏感，一个字都不动**。
 * 取不到合法 BV 时返回 null，交调用方决定怎么降级。
 */
export function bareBvid(raw) {
  const m = /^([Bb][Vv][0-9A-Za-z]{10})(?:_p\d+)?$/.exec(String(raw ?? '').trim())
  return m ? m[1] : null
}

/** 从 `BV…_p3` 里取页码；取不到（单 P 的正常形态）算 1。 */
export function pageOf(raw) {
  const m = /_p(\d+)\s*$/.exec(String(raw ?? '').trim())
  return m ? Number(m[1]) : 1
}

// ---------- 视频基本信息（速读稿必需件）----------
/**
 * 2026-10-14 用户明确要求：**以后每份速读都要带上视频基本信息**——
 * 作者名、粉丝数、发布时间、评论数、播放量等，用户靠这些判断这条视频可不可信。
 *
 * 为什么必须单独取：yt-dlp 只给标题 / UP 名 / 时长，**给不了**粉丝数、播放量、
 * 评论数、发布时间。这些全在 B 站公开 web 接口里。
 *
 * 公开接口、**不需要 cookie**；任何一步失败都只降级（返回 null 或局部缺字段），
 * 绝不因为"粉丝数拿不到"把整条速读搞挂。
 */
const _metaCache = new Map()

async function metaFromApi(bvid) {
  bvid = bareBvid(bvid) ?? bvid   // 防呆：任何入口传进来都先规整一次
  if (!bvid) return null
  if (_metaCache.has(bvid)) return _metaCache.get(bvid)
  let view
  try {
    view = await withRetry('meta/view', () => biliApi(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`), { attempts: 3 })
  } catch (e) {
    process.stderr.write(`[meta] 取视频信息失败（速读稿将缺基本信息）：${String(e.message).split('\n')[0]}\n`)
    return null
  }
  const o = view?.owner ?? {}
  let fans = null
  if (o.mid) {
    try {
      const rel = await withRetry('meta/relation', () => biliApi(`/x/relation/stat?vmid=${o.mid}`), { attempts: 3 })
      fans = Number.isFinite(rel?.follower) ? rel.follower : null
    } catch { /* 粉丝数拿不到不影响其余字段 */ }
  }
  const s = view?.stat ?? {}
  const meta = {
    bvid: view?.bvid ?? bvid,
    aid: view?.aid ?? null,
    cid: view?.cid ?? null,
    title: (view?.title ?? '').trim() || null,
    author: o.name ?? null,
    authorMid: o.mid ?? null,
    authorFans: fans,
    pubdate: Number.isFinite(view?.pubdate) ? view.pubdate : null,
    duration: Number.isFinite(view?.duration) ? view.duration : null,
    view: Number.isFinite(s.view) ? s.view : null,
    like: Number.isFinite(s.like) ? s.like : null,
    coin: Number.isFinite(s.coin) ? s.coin : null,
    favorite: Number.isFinite(s.favorite) ? s.favorite : null,
    danmaku: Number.isFinite(s.danmaku) ? s.danmaku : null,
    reply: Number.isFinite(s.reply) ? s.reply : null,
    share: Number.isFinite(s.share) ? s.share : null,
    desc: (view?.desc ?? '').trim(),
    // B 站官方给这条视频挂的提示（例：「个人观点，仅供参考」），是现成的可信度信号
    argueMsg: (view?.argue_info?.argue_msg ?? '').trim(),
  }
  _metaCache.set(bvid, meta)
  return meta
}

/** 秒 → HH:MM:SS。 */
function hhmmss(s) {
  const t = Math.max(0, Math.round(Number(s) || 0))
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** 数字口语化：12345 → 1.2 万。给人看的播放量/粉丝数。 */
function fmtCount(n) {
  if (!Number.isFinite(n)) return '未知'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(abs >= 1e9 ? 0 : 1)} 亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(abs >= 1e5 ? 0 : 1)} 万`
  return String(n)
}

/** UNIX 秒 → 北京时间字符串（用户就在 Asia/Shanghai）。固定 +8 偏移，不依赖 ICU。 */
function fmtDate(unixSec) {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return '未知'
  const p = (x) => String(x).padStart(2, '0')
  const bj = new Date(unixSec * 1000 + 8 * 3600 * 1000)
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`
}

/** 距今多久。「刚发 2 小时」和「发了 3 年」对可信度判断完全是两件事。 */
function fmtAgo(unixSec, nowMs = Date.now()) {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return ''
  const s = Math.max(0, Math.round(nowMs / 1000 - unixSec))
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.round(s / 86400)} 天前`
  if (s < 86400 * 365) return `${Math.round(s / (86400 * 30))} 个月`
  return `${(s / (86400 * 365)).toFixed(1)} 年`
}

/**
 * 基本信息块 → [[字段, 值]]。终端输出、转写文件头、速读稿共用同一份口径，
 * 避免"终端显示的粉丝数和速读稿里写的不一样"。
 */
function metaBlock(meta) {
  if (!meta) return null
  const stat = [
    `播放 ${fmtCount(meta.view)}`,
    `点赞 ${fmtCount(meta.like)}`,
    `投币 ${fmtCount(meta.coin)}`,
    `收藏 ${fmtCount(meta.favorite)}`,
    `评论 ${fmtCount(meta.reply)}`,
    `弹幕 ${fmtCount(meta.danmaku)}`,
    `分享 ${fmtCount(meta.share)}`,
  ].join(' · ')
  const rows = [
    ['标题', meta.title ?? '未知'],
    ['作者', `${meta.author ?? '未知'}（粉丝 ${fmtCount(meta.authorFans)}）`],
    ['发布', meta.pubdate ? `${fmtDate(meta.pubdate)}（${fmtAgo(meta.pubdate)}）` : '未知'],
    ['时长', meta.duration ? hhmmss(meta.duration) : '未知'],
    ['数据', stat],
    ['链接', `https://www.bilibili.com/video/${meta.bvid}`],
  ]
  // 简介里带换行，直接塞进 Markdown 列表会把列表打断（实测），先压成一行
  const desc = (meta.desc ?? '').replace(/\s*\n+\s*/g, ' ').trim()
  if (desc) rows.push(['简介', desc.length > 120 ? `${desc.slice(0, 120)}…` : desc])
  if (meta.argueMsg) rows.push(['官方提示', meta.argueMsg])
  return rows
}

// ---------- 热门评论（2026-10-15 新增：速读稿要带评论分析）----------
/**
 * 2026-10-15 用户要求：速读稿末尾要有「热门评论分析（约 10 条）」+「我的看法」。
 *
 * 接口选择是实测逼出来的，别乱换：
 *  - `/x/v2/reply?type=1&oid=<aid>&sort=2&nohot=0&ps=20&pn=N`
 *    → **默认排序（B 站自己的"热门评论"口径）**，可翻页。**必须带 `sort`**：
 *      不带 sort 时接口返回 `code=0` 但 `replies` 为空且 `page.count=0`（静默骗人）。
 *  - 匿名（无 cookie）时**只给前 3 条热评**，pn≥2 直接空返回；
 *    有登录 cookie 才能翻页（实测一页 20 条，翻 4 页 80 条正常）。
 *    → 所以拿不到时**降级**：只用这 3 条，并在速读稿里说明"只取到 3 条"。
 *  - `comment_count` 用 `page.count`（和 stat.reply 同源，可互校）。
 *  - 子评论（楼中楼）走 `/x/v2/reply/reply?root=<rpid>&ps=10`，拿前 3 条带赞的。
 *  - 官方置顶评论在 `top_replies[]` 里，合并时按 rpid 去重。
 *
 * 头像、表情图片这些字段一律不取：转写文件是要喂给模型的，越短越省 token。
 */
const COMMENT_UA = UA

/** 一条评论 → 精简对象（原文 + 热度 + 地域 + 置顶/UP 标记）。 */
function pickComment(c, { pinned = false, isUp = false } = {}) {
  const msg = String(c?.content?.message ?? '').trim()
  if (!msg) return null
  return {
    rpid: String(c?.rpid_str ?? c?.rpid ?? ''),
    user: String(c?.member?.uname ?? '未知'),
    like: Number.isFinite(c?.like) ? c.like : 0,
    replies: Number.isFinite(c?.rcount) ? c.rcount : 0,
    time: Number.isFinite(c?.ctime) ? fmtDate(c.ctime) : null,
    location: String(c?.reply_control?.location ?? '').trim(),
    pinned,
    isUp,
    content: msg,
  }
}

/**
 * 抓热门评论。任何失败都只降级（返回 null 或 locale 空），不拖垮转写。
 * @param {string} bvid
 * @param {{aid?: number|null, cookieHeader?: string|null, top?: number}} opts
 */
async function fetchComments(bvid, { aid = null, cookieHeader = null, top = 40, pages = 3 } = {}) {
  bvid = bareBvid(bvid) ?? bvid
  if (!bvid) return null
  let oid = aid
  let count = null
  try {
    const view = await withRetry('comments/view', () => biliApi(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`), { attempts: 2 })
    oid = view?.aid ?? oid
    count = Number.isFinite(view?.stat?.reply) ? view.stat.reply : null
  } catch { /* 拿不到 aid 就用调用方传进来的 */ }
  if (!oid) return null

  const seen = new Set()
  const picked = []
  const add = (c, opts) => {
    const p = pickComment(c, opts)
    if (!p || seen.has(p.rpid)) return
    seen.add(p.rpid)
    picked.push(p)
  }

  let method = 'hot'
  let limited = false
  let total = count ?? 0

  for (let pn = 1; pn <= pages && picked.length < top; pn++) {
    let data
    try {
      data = await withRetry(`comments/p${pn}`, () => biliApi(`/x/v2/reply?type=1&oid=${oid}&sort=2&nohot=0&ps=20&pn=${pn}`, cookieHeader), { attempts: 2 })
    } catch (e) {
      process.stderr.write(`[comments] 第 ${pn} 页失败：${String(e.message).split('\n')[0]}\n`)
      break
    }
    if (Number.isFinite(data?.page?.count) && data.page.count > 0) total = data.page.count
    // 第一页顺带收置顶评论（官方置顶 + UP 主置顶）
    if (pn === 1) {
      for (const c of data?.top_replies ?? []) add(c, { pinned: true })
      if (data?.upper?.top) add(data.upper.top, { pinned: true, isUp: true })
      if (data?.top && !Array.isArray(data.top)) add(data.top, { pinned: true, isUp: true })
    }
    const list = Array.isArray(data?.replies) ? data.replies : []
    if (!list.length) {
      // 有评论数却返回空列表 → 大概率是匿名态翻页被拦，记下来给用户交代清楚
      if (total > 0 && pn > 1) limited = true
      break
    }
    for (const c of list) add(c, { isUp: Boolean(c?.member?.mid && c.member.mid === data?.upper?.mid) })
    if (list.length < 20) break
  }

  // 置顶永远排最前，其余按赞数从高到低（"热门评论"的一致口径）。
  // 注意：接口的 pn 顺序不是纯按赞数（实测第 1 页里混着 7 赞的），所以显式排一次。
  picked.sort((a, b) => (b.pinned - a.pinned) || (b.like - a.like))
  const out = picked.slice(0, top)

  // 楼层里的高赞子评论：只对最终要展示的条目做，别把小接口打爆。
  // 不设赞数门槛——小视频里"热评"往往只有个位数赞，设门槛就一条楼中楼都拿不到；
  // 这里最多也就 8 次请求（只取 toMarkdown/report 真正要展示的前 N 条）。
  const targets = out.filter((c) => c.replies > 0).slice(0, 8)
  for (const t of targets) {
    try {
      const d = await biliApi(`/x/v2/reply/reply?type=1&oid=${oid}&root=${t.rpid}&ps=10&pn=1`, cookieHeader)
      const subs = (Array.isArray(d?.replies) ? d.replies : [])
        .map((c) => pickComment(c))
        .filter(Boolean)
        .sort((a, b) => b.like - a.like)
        .slice(0, 3)
      if (subs.length) t.topReplies = subs
    } catch { /* 楼中楼拿不到就算了 */ }
    await new Promise((r) => setTimeout(r, 250))
  }

  const totalCount = Number.isFinite(total) ? total : 0
  return {
    total: totalCount,
    fetched: out.length,
    requested: top,
    // 取到的条数明显少于请求数、且这视频确实有评论 → 说清楚"只取到热门前几条"
    partial: totalCount > 0 && out.length < top,
    limited,
    hasCookie: Boolean(cookieHeader),
    method,
    list: out,
  }
}

/** 热门评论块 → Markdown 行。写进转写文件头，模型写速读稿时直接读这块。 */
function commentsMarkdown(cmt) {
  if (!cmt) return null
  const lines = ['## 热门评论', '']
  if (!cmt.total && !cmt.fetched) {
    return [...lines, '（该视频暂无评论，或评论接口没取到——写速读稿时照实说明，不要编。）', ''].join('\n')
  }
  const head = `共 ${cmt.total} 条评论，这里取了 ${cmt.fetched} 条（按 B 站默认"热门"排序${cmt.partial ? '，只取到热门前几条' : ''}）`
  lines.push(head)
  if (cmt.limited && !cmt.hasCookie) {
    lines.push('', '⚠️ 本次为**未登录**状态，B 站只放前 3 条热评、翻页被拦——速读稿里要说明"评论只取到前 3 条"。')
  }
  lines.push('')
  cmt.list.forEach((c, i) => {
    const tags = [c.pinned ? '置顶' : null, c.isUp ? 'UP主' : null].filter(Boolean)
    // 评论正文里的换行会把 Markdown 列表打断（实测），压成一行
    const body = c.content.replace(/\s*\n+\s*/g, ' ').trim()
    lines.push(`${i + 1}. **${c.user}**（${c.like} 赞 · ${c.replies} 回复${c.location ? ` · ${c.location}` : ''}${c.time ? ` · ${c.time}` : ''}${tags.length ? ` · ${tags.join('/')}` : ''}）：${body}`)
    for (const s of c.topReplies ?? []) {
      lines.push(`   - ↳ **${s.user}**（${s.like} 赞${s.location ? ` · ${s.location}` : ''}）：${s.content.replace(/\s*\n+\s*/g, ' ').trim()}`)
    }
  })
  lines.push('')
  lines.push('> 注：评论是网友观点，不是事实；写速读稿时只做归纳与热度分析，**不要替评论背书写结论**。', '')
  return lines.join('\n')
}

/**
 * 取官方字幕（AI 字幕或投稿字幕），返回带**官方时间戳**的段落。
 *
 * 为什么不走 yt-dlp：实测 yt-dlp 对同一视频报"无字幕"，而 player/v2 接口
 * 明明返回了 `lan=ai-zh`。直接走接口既拿到字，也拿到 from/to 精确时间，
 * 比识别结果更准更快。
 */
async function subsViaApi(url, info) {
  // b23.tv 短链 / 带参数的播放页在 URL 里**没有** BV 号，但 yt-dlp 已经把真 BV 解析出来了，
  // 所以解析不出标识时用 info.bvid 兜底——否则短链会在这里直接抛错。
  const param = (() => {
    try { return videoParam(url) } catch {
      if (info?.bvid) return `bvid=${info.bvid}`
      throw new Error(`无法从 URL 里取到视频标识：${url}`)
    }
  })()
  const view = await biliApi(`/x/web-interface/view?${param}`)
  const aid = view.aid
  // 多 P 视频：view 顶层给的是第 1 P，选看的那 P 的 cid 在 pages[] 里。
  // 单 P 时 pages[0].cid === view.cid，行为与从前完全一致。
  const page = Number.isFinite(info?.page) ? info.page : 1
  const cid = (Array.isArray(view.pages) ? view.pages[page - 1]?.cid : null) ?? view.cid

  const enriched = {
    ...info,
    bvid: view.bvid ?? info.bvid,
    title: (view.title ?? info.title ?? '').trim() || info.title,
    duration: Number.isFinite(view.duration) ? view.duration : info.duration,
    uploader: view.owner?.name ?? info.uploader,
  }

  // view.subtitle.list —— 投稿字幕（注意：这不代表视频"有字幕"，是 UP 投的材料）
  const submitted = view?.subtitle?.list ?? []
  // 偏好简体中文：ai-zh 是 AI 中文，zh-Hans/zh-CN 是投稿中文
  const prefer = ['ai-zh', 'zh-Hans', 'zh-CN', 'zh', 'ai-en', 'en']

  /**
   * 下载并解析一条字幕，返回 { segs, covered, bytes, canonical }。
   *
   * **为什么整段逻辑这么绕**：B 站的字幕文件不止一份。同一个视频，`player/v2`
   * 每次会随机返回**不同的** `subtitle_url`，而它们指向**不同的字幕文件**，
   * 内容长度天差地别。实测同一视频连调 4 次：
   *
   *   hash=117166825281470413348692…  → 1119 段，覆盖 2710s（完整）
   *   hash=113368631412447264608165…  →   30 段，覆盖   93s
   *   hash=117166825281470413348692…  → 1119 段，覆盖 2710s（完整）
   *   hash=16560705161614942327d728…  →  138 段，覆盖  306s
   *
   * 而且 HTTP 状态码**每次都是 200**、curl 与 node fetch 拿到的长度各自稳定，
   * 所以光看 res.ok 或用 curl 都发现不了——必须拿视频已知时长校验覆盖度。
   *
   * 规律：完整那份的文件名以 **`${aid}${cid}`** 开头（上面 117166825281470 = aid，
   * 41334869261 = cid）。所以既按这个前缀优先挑，也在覆盖不足时**重新请求
   * player/v2 换一个文件**（只重试同一个 URL 是没用的，长度是确定的）。
   */
  const canonicalPrefix = `${aid}${cid}`

  const fetchOne = async (subUrl) => {
    const res = await fetch(subUrl, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } })
    if (!res.ok) throw new Error(`下载字幕内容失败：HTTP ${res.status}`)
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch {
      throw new Error(`字幕内容不是合法 JSON（${text.length} 字节，开头：${text.slice(0, 80)}）`)
    }
    const arr = Array.isArray(json?.body) ? json.body : []
    const segs = arr
      .map((b) => ({ start: +Number(b.from).toFixed(2), end: +Number(b.to).toFixed(2), text: String(b.content ?? '').trim() }))
      .filter((s) => s.text)
    const covered = segs.length ? segs[segs.length - 1].end : 0
    const name = new URL(subUrl).pathname.split('/').pop() ?? ''
    return {
      segs, covered, bytes: text.length, name,
      canonical: name.startsWith(canonicalPrefix),
      truncated: Boolean(enriched.duration) && covered < enriched.duration * 0.9,
    }
  }

  let best = null, langUsed = null, langDocUsed = null
  let lastErr = null
  let sawNoCandidates = false
  let foreignCount = 0
  const MAX_TRIES = 16
  /** 连续这么多轮只看见"非规范文件"就放弃——那些是别的视频的字幕，等下去也没用 */
  const MAX_FOREIGN_ROUNDS = 5
  let foreignRounds = 0
  /** 已经下载过的字幕 URL —— 同一份文件不再重复下（player/v2 经常重复返回同一批） */
  const triedUrls = new Set()
  for (let i = 1; i <= MAX_TRIES; i++) {
    // 每轮都重新要一次 player/v2 —— 换一个文件才可能拿到完整那份
    let all = []
    try {
      const player = await biliApi(`/x/player/v2?aid=${aid}&cid=${cid}`)
      const list = player?.subtitle?.subtitles ?? []
      all = [...list, ...submitted].filter((c) => c.subtitle_url || c.url)
    } catch (e) {
      // 关键：中途失败**不能丢掉已经拿到的 best**，否则"第 1 次拿到完整、
      // 第 2 次接口抖动"就变成返回空——这正是之前的 bug。
      lastErr = e
      process.stderr.write(`[subs] 第 ${i} 次取字幕列表失败：${e.message}\n`)
      await new Promise((res) => setTimeout(res, 400 * i))
      continue
    }
    if (all.length === 0) {
      // 确实没有任何字幕轨（AI 或投稿）
      sawNoCandidates = true
      await new Promise((res) => setTimeout(res, 250 + 60 * i))
      continue
    }

    /**
     * **只认规范文件**：文件名以 `${aid}${cid}` 开头。
     *
     * 2026-11-02 差点改坏，记一笔：一度觉得这条规则太严、会误杀"明明有字幕的视频"
     * （BV1EYx56MEtK 返回的 ai-zh 文件覆盖度能到 357s/434s，看着挺完整），于是改成
     * 不筛只排序。结果做出来的速读稿内容**完全是另一个视频的**（山姆超市探店），
     * 也就是说非规范文件不只是残缺，而是**别的视频的字幕**。覆盖度校验挡不住它
     * （那个视频恰好也是 6 分半）。所以这条硬筛必须留着。
     */
    const canonical = all.filter((c) => {
      const u = String(c.subtitle_url ?? c.url ?? '')
      const n = u.split('/').pop()?.split('?')[0] ?? ''
      return n.startsWith(canonicalPrefix)
    })
    if (canonical.length === 0) {
      // 只有非规范文件：没有继续等的价值，早点交回本地识别
      foreignCount++
      foreignRounds++
      if (foreignRounds >= MAX_FOREIGN_ROUNDS) break
      await new Promise((res) => setTimeout(res, 250 + 60 * i))
      continue
    }
    foreignRounds = 0

    // 规范文件里按语言偏好挑（ai-zh 最前），同一 URL 不重复下
    const ranked = canonical
      .map((c) => {
        const raw = String(c.subtitle_url ?? c.url ?? '')
        const u = raw.startsWith('//') ? `https:${raw}` : raw
        const rank = prefer.indexOf(c.lan)
        return { c, u, rank: rank < 0 ? 99 : rank }
      })
      .filter((x) => x.u && !triedUrls.has(x.u))
      .sort((a, b) => a.rank - b.rank)

    if (ranked.length === 0) {
      // 规范文件都试过了，本轮没新东西
      await new Promise((res) => setTimeout(res, 250 + 60 * i))
      continue
    }

    const pick = ranked[0]
    triedUrls.add(pick.u)
    let r
    try { r = await fetchOne(pick.u) } catch (e) {
      process.stderr.write(`[subs] 第 ${i} 次下载失败：${e.message}\n`)
      await new Promise((res) => setTimeout(res, 400 * i))
      continue
    }
    const better = !best || r.segs.length > best.segs.length
    if (better) { best = r; langUsed = pick.c.lan; langDocUsed = pick.c.lan_doc ?? null }
    process.stderr.write(
      `[subs] 第 ${i} 次：${r.bytes}B → ${r.segs.length} 段，覆盖 ${r.covered}s / ${enriched.duration ?? '?'}s` +
      `${r.truncated ? '  ← 不完整，换文件' : '  ✓ 完整'}\n`,
    )
    if (!r.truncated) break
    // 已经试了 8 轮还只有残缺的：别无限耗下去，用手上最好的那份（返回时会警告）
    if (i >= 8) break
    await new Promise((res) => setTimeout(res, 300 * i))
  }

  if (!best) {
    const reason = lastErr ? `多次尝试都失败：${lastErr.message}`
      : sawNoCandidates ? '该视频没有 AI 字幕，也没有投稿字幕'
        : `没有可用的规范字幕文件（只返回了其他视频的字幕 ${foreignCount} 轮），改用本地识别`
    return { ...enriched, mode: 'subs', segments: [], reason }
  }
  if (best.truncated) {
    process.stderr.write(`[subs] 警告：只覆盖 ${best.covered}s / ${enriched.duration}s —— 这份字幕本身就不全，不是下载问题\n`)
  }
  return {
    ...enriched,
    mode: 'subs',
    lang: langUsed,
    langDoc: langDocUsed,
    segments: best.segs,
    complete: !best.truncated,
    reason: best.segs.length ? undefined : '字幕文件里没有内容',
  }
}

async function subs(url, cookieFileArg) {
  const info = await probe(url)
  const hasCookie = Boolean(cookieFileArg && existsSync(cookieFileArg))
  if (!hasCookie) {
    return { ...info, mode: 'subs', segments: [], reason: '未提供 cookie 文件——匿名状态 B 站字幕命中率实测 0/40' }
  }
  return withRetry('subs', () => subsViaApi(info.url, info))
}

// ---------- 音轨 ----------
async function fetchAudio(url, info) {
  const dest = join(CACHE, 'audio')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  // 优先 AAC-LC（解码最稳），退到 bestaudio
  const r = await run(YTDLP, [
    '--proxy=', '--no-playlist', '--no-warnings', '--no-progress',
    '-f', '30232/30280/30216/bestaudio/best',
    '-o', join(dest, 'audio.%(ext)s'), info.url,
  ])
  if (r.code !== 0) throw new Error(`下载音轨失败：\n${(r.stderr || '').split(/\r?\n/).slice(-6).join('\n')}`)
  const files = (await import('node:fs')).readdirSync(dest).filter((f) => /^audio\./.test(f))
  if (files.length === 0) throw new Error('下载音轨后没找到文件')
  return join(dest, files[0])
}

/** 解码成 16 kHz 单声道 16bit **裸 PCM**（不带 WAV 头）。 */
async function decodeToPcm(inputPath) {
  const r = await run(FFMPEG, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', inputPath,
    '-vn', '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le',
    '-f', 's16le', 'pipe:1',
  ], { encoding: null })
  if (r.code !== 0) throw new Error(`ffmpeg 解码失败：\n${r.stderr.toString('utf8').split(/\r?\n/).slice(-8).join('\n')}`)
  return r.stdout
}

// ---------- 分窗：切点吸附到能量最低处 ----------
/**
 * 纯函数：给定 PCM 与目标窗长，算出切点（返回秒数数组，含 0 与总时长）。
 * 在每个候选切点附近 ±SNAP_SEC 内按 10 ms 帧找 RMS 最低处。
 */
export function planCuts(pcm, { rate = RATE, windowSec = WINDOW_SEC, snapSec = SNAP_SEC, minWin = MIN_WIN, maxWin = MAX_WIN } = {}) {
  const frames = Math.floor(pcm.length / 2)
  const totalSec = frames / rate
  const frameMs = 10
  const samplesPerFrame = Math.floor((rate * frameMs) / 1000)
  const nFrames = Math.floor(frames / samplesPerFrame)
  // 每帧 RMS
  const rms = new Float64Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    let sum = 0
    const base = f * samplesPerFrame * 2
    for (let i = 0; i < samplesPerFrame; i++) {
      const s = pcm.readInt16LE(base + i * 2) / 32768
      sum += s * s
    }
    rms[f] = Math.sqrt(sum / samplesPerFrame)
  }
  const frameOf = (sec) => Math.max(0, Math.min(nFrames - 1, Math.round((sec * 1000) / frameMs)))

  const cuts = [0]
  let cursor = 0
  while (totalSec - cursor > maxWin) {
    const target = cursor + windowSec
    const lo = frameOf(Math.max(cursor + minWin, target - snapSec))
    const hi = frameOf(Math.min(cursor + maxWin, target + snapSec))
    let best = -1, bestV = Infinity
    for (let f = lo; f <= hi && f < nFrames; f++) {
      if (rms[f] < bestV) { bestV = rms[f]; best = f }
    }
    if (best < 0) best = frameOf(target)
    const cutSec = (best * frameMs) / 1000
    cuts.push(cutSec)
    cursor = cutSec
  }
  cuts.push(totalSec)
  return cuts
}

// ---------- 本地识别 ----------
/**
 * @param {object|null} comments 已抓好的热门评论（可选）。传进来就写进转写文件头，
 *   模型写速读稿时能就地读到「我的看法 / 热门评论分析」两节要用的素材。
 *   单独在 `get` 里抓（不在 probe 里抓），因为 probe 要保持秒级、不额外打接口。
 */
async function transcribe(url, comments = null, info = null) {
  if (!existsSync(MODEL) || !existsSync(TOKENS)) {
    throw new Error(`模型缺失。期望：\n  ${MODEL}\n  ${TOKENS}\n先跑 scripts/fetch-models.ps1`)
  }
  info = info ?? await probe(url)
  process.stderr.write(`[1/4] 探测完成：${info.title}（${info.duration ?? '?'} s）\n`)
  const audio = await fetchAudio(url, info)
  process.stderr.write(`[2/4] 音轨已下载：${audio}\n`)
  const pcm = await decodeToPcm(audio)
  process.stderr.write(`[3/4] 已解码 ${(pcm.length / 1024 / 1024).toFixed(1)} MB 裸 PCM（${(pcm.length / 2 / RATE).toFixed(1)} s）\n`)

  const require_ = createRequire(import.meta.url)
  const sherpa = require_('sherpa-onnx-node')
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: MODEL, language: 'zh', useInverseTextNormalization: 1 },
      tokens: TOKENS,
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  })

  const cuts = planCuts(pcm)
  const segments = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i], end = cuts[i + 1]
    const a = Math.floor(start * RATE) * 2
    const b = Math.min(pcm.length, Math.floor(end * RATE) * 2)
    const slice = pcm.subarray(a, b)
    // sherpa 要 Float32Array，归一化到 [-1,1]
    const n = Math.floor(slice.length / 2)
    const f32 = new Float32Array(n)
    for (let k = 0; k < n; k++) f32[k] = slice.readInt16LE(k * 2) / 32768
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: RATE, samples: f32 })
    recognizer.decode(stream)
    const res = recognizer.getResult(stream)
    const text = (res?.text ?? '').trim()
    if (text) segments.push({ start: +start.toFixed(2), end: +end.toFixed(2), text })
    process.stderr.write(`     窗 ${i + 1}/${cuts.length - 1}  ${start.toFixed(1)}–${end.toFixed(1)}s  ${text.length} 字\n`)
  }
  process.stderr.write(`[4/4] 识别完成：${segments.length} 段\n`)
  return { ...info, mode: 'asr', segments }
}

// ---------- 输出 ----------
export function toMarkdown(info, segments, { intermediate = false, comments = null } = {}) {
  const total = segments.length ? segments[segments.length - 1].end : (info.duration ?? 0)
  const hhmm = (s) => {
    const t = Math.max(0, Math.round(s))
    return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
  }
  const pageQ = Number(info.page) > 1 ? `p=${info.page}&` : ''
  const link = (s) => `https://www.bilibili.com/video/${info.bvid}?${pageQ}t=${Math.floor(s)}`
  // 基本信息放文件最前面：这份文件是喂给模型的中间产物，模型据此写速读稿。
  // 写在这里而不是靠模型自己想起来去查——模型只读得到这个文件。
  const metaRows = metaBlock(info.meta)
  const infoLines = metaRows
    ? metaRows.map(([k, v]) => `- ${k}：${v}`)
    : [
        `- 视频：<https://www.bilibili.com/video/${info.bvid}>`,
        `- 时长：${hhmm(total)}`,
        info.uploader ? `- UP：${info.uploader}` : null,
        '- ⚠️ 基本信息（粉丝数/播放量/发布时间）没取到，速读稿里要写明"数据未取到"',
      ].filter(Boolean)
  const lines = [
    `# ${info.title}`,
    '',
    '## 视频基本信息',
    '',
    ...infoLines,
    '',
    `- 转写来源：${info.mode === 'subs' ? `B 站字幕（${info.lang ?? '?'}）` : '本地 SenseVoice'}`,
    intermediate ? '- 用途：中间产物（喂给模型做速读），**非交付物**' : null,
    '',
  ].filter((x) => x !== null)
  // 热门评论块插在转写正文之前：模型写速读稿时「我的看法 + 热门评论分析」两节就靠它。
  const cmtBlock = commentsMarkdown(comments)
  if (cmtBlock) lines.push(cmtBlock)
  // 时间轴写法分两种（2026-11-02）：**喂给模型的那份不带链接**。
  // 实测（BV1QSxT6GE1p）：时间轴 25,761 字符里 19,159 是 `<a href="...?t=">` 标签（74%），
  // 而模型要的只有"第几秒 + 说了什么"——链接是给人点的，模型读了纯属烧 token。
  // 去掉标签后同一支片从 25.7k 字符降到 6.6k，输入大约砍一半。
  // 人看的正式转写（`--full` → intermediate:false）仍保留可点击时间戳，一个字不动。
  lines.push('## 完整转写（带时间）', '',
    ...segments.map((s) => (intermediate
      ? `[${hhmm(s.start)}] ${s.text}`
      : `<a href="${link(s.start)}">[${hhmm(s.start)}]</a> ${s.text}`)),
    '',
  )
  return lines.join('\n')
}
// ---------- doctor（安装自检）----------
/**
 * 首次安装最容易卡在"到底缺什么"：缺二进制、缺模型、cookie 过期——
 * 三种情况的表现完全一样：跑起来就一句看不懂的报错。
 * doctor 把能查的都查一遍，每一项给一条能照做的修复命令。
 */
const dispWidth = (s) => [...s].reduce((n, ch) => n + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch) ? 2 : 1), 0)
const padDisp = (s, n) => s + ' '.repeat(Math.max(0, n - dispWidth(s)))

async function doctor() {
  const rows = []
  const add = (mark, label, detail) => rows.push({ mark, label, detail })
  let blocking = 0

  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) add('✓', `Node ${process.versions.node}`, '满足 >= 20')
  else { add('✗', `Node ${process.versions.node}`, '需要 >= 20 → https://nodejs.org 装 LTS'); blocking++ }

  for (const [label, p, hint] of [
    ['yt-dlp', YTDLP, '取视频信息与音轨'],
    ['ffmpeg', FFMPEG, '音轨解成裸 PCM'],
  ]) {
    if (existsSync(p)) add('✓', label, `${hint} · ${p.slice(HERE.length + 1)}`)
    else { add('✗', label, `缺失 ${p.slice(HERE.length + 1)} → pwsh scripts/fetch-models.ps1`); blocking++ }
  }

  for (const [label, p, bytes] of [
    ['SenseVoice 模型', MODEL, 239233841],
    ['SenseVoice tokens', TOKENS, 315894],
    ['Silero VAD', VAD, 1807522],
  ]) {
    if (!existsSync(p)) { add('✗', label, '缺失 → pwsh scripts/fetch-models.ps1'); blocking++; continue }
    const size = statSync(p).size
    if (size === bytes) add('✓', label, `${(bytes / 1048576).toFixed(1)} MB，大小对得上`)
    else { add('✗', label, `只有 ${size} B（应为 ${bytes} B），疑似下到一半 → 重跑 fetch-models.ps1`); blocking++ }
  }

  const sherpaDir = join(HERE, 'node_modules', 'sherpa-onnx-node')
  if (existsSync(sherpaDir)) add('✓', 'sherpa-onnx-node', '本地 ASR 的 native 依赖已装')
  else add('!', 'sherpa-onnx-node', '未安装：只有走本地 ASR 才需要 → npm install')

  try {
    mkdirSync(CACHE, { recursive: true })
    const probeFile = join(CACHE, '.doctor-write-test')
    writeFileSync(probeFile, 'ok')
    rmSync(probeFile)
    add('✓', 'cache 可写', CACHE.slice(HERE.length + 1))
  } catch (e) {
    add('✗', 'cache 不可写', `${CACHE}：${e.message}`)
    blocking++
  }

  if (!cookieFile || !existsSync(cookieFile)) {
    add('!', 'cookie', '没有 → 也能跑（走本地 ASR；评论只有前 3 条）；想要字幕：node login.mjs')
  } else {
    const header = currentCookieHeader()
    if (!header) {
      add('!', 'cookie', `文件在但解析不出 SESSDATA：${cookieFile}`)
    } else {
      try {
        const nav = await biliApi('/x/web-interface/nav', header)
        if (nav?.isLogin) add('✓', 'cookie', `已登录：${nav.uname ?? '(匿名)'}`)
        else add('!', 'cookie', '未登录或已过期 → node login.mjs')
      } catch (e) {
        add('!', 'cookie', `无法验证（${String(e.message).split('\n')[0]}）；不影响离线功能`)
      }
    }
  }

  console.log('bilisum 安装自检\n')
  for (const r of rows) console.log(`  ${r.mark}  ${padDisp(r.label, 20)} ${r.detail}`)
  console.log('')
  if (blocking === 0) {
    console.log('结论：可以跑。先试：node bilisum.mjs probe "BV1A9xh6ZEg4"')
    return
  }
  console.log(`结论：有 ${blocking} 项阻断，按上面 ✗ 的提示修完，再跑一次 doctor。`)
  process.exitCode = 1
}

// ---------- CLI ----------
const [cmd, ...rest] = process.argv.slice(2)
const url = rest.find((a) => !a.startsWith('--'))
const ci = rest.indexOf('--cookie')
const wantJson = rest.includes('--json')
const wantFull = rest.includes('--full')       // 把转写写成正式文件（进 out/）；默认不写
const wantPreview = rest.includes('--preview') // 在终端打开头三段；默认不打
// 评论：默认抓 40 条写进转写文件头（2026-10-15 用户要求速读稿带热门评论分析）。
// --comments 4 / --top 4 可调条数；--no-comments 关掉（想要秒级出结果时用）。
const wantNoComments = rest.includes('--no-comments')
const ciTop = rest.findIndex((a) => a === '--comments' || a === '--top')
const commentTop = ciTop >= 0 && Number.isFinite(Number(rest[ciTop + 1])) && Number(rest[ciTop + 1]) > 0
  ? Math.min(100, Number(rest[ciTop + 1]))
  : 40
// 没显式给 --cookie 时，自动用 scripts/set-cookie.mjs 存下来的那份。
// 否则会出现"明明配好了 cookie，subs 却还说自己没 cookie"的荒唐情况。
const DEFAULT_COOKIE = join(CACHE, 'cookies.txt')
const cookieFile =
  (ci >= 0 ? rest[ci + 1] : null) ?? (existsSync(DEFAULT_COOKIE) ? DEFAULT_COOKIE : null)

/**
 * 默认只打摘要。
 * 一份 45 分钟视频的官方字幕有几百段，全量 JSON 打到终端没有意义（而且刷屏），
 * 需要全量时显式加 --json。
 * 同理，开头三段预览默认也不打（用户明确说不读这些），要看加 --preview。
 */
function report(result) {
  if (wantJson) { console.log(JSON.stringify(result, null, 2)); return }
  const segs = result.segments ?? []
  const chars = segs.reduce((n, s) => n + s.text.length, 0)
  const last = segs.length ? segs[segs.length - 1].end : 0
  // 基本信息优先打全（用户判断可信度就靠这些）；拿不到时退回老的三行式，不装样子。
  const rows = metaBlock(result.meta)
  if (rows) {
    for (const [k, v] of rows) console.log(`${k.padEnd(5, '　')} ${v}`)
  } else {
    console.log(`标题   ${result.title}`)
    console.log(`UP     ${result.uploader ?? '-'}   BV ${result.bvid ?? '-'}   时长 ${hhmmss(result.duration ?? last)}`)
  }
  console.log(`来源   ${result.mode === 'subs' ? `B 站官方字幕（${result.langDoc ?? result.lang ?? '?'}）` : result.mode === 'asr' ? '本地 SenseVoice 识别' : '仅探测（未取转写）'}`)
  console.log(`结果   ${segs.length} 段 / ${chars} 字 / 覆盖到 ${hhmmss(last)}`)
  if (result.comments) {
    const c = result.comments
    console.log(`评论   共 ${c.total} 条，已取 ${c.fetched} 条${c.partial ? '（只取到热门前几条）' : ''}${c.hasCookie ? '' : '（未登录仅前 3 条）'}`)
  }
  if (result.reason) console.log(`原因   ${result.reason}`)
  if (result.markdown) console.log(`文件   ${result.markdown}`)
  if (wantPreview && segs.length) {
    console.log(`\n开头三段：`)
    for (const s of segs.slice(0, 3)) console.log(`  [${hhmmss(s.start)}] ${s.text}`)
    console.log(`（完整内容见 Markdown 文件；要全量 JSON 加 --json）`)
  }
}

/** comments 子命令：把热门评论直接打到终端（和数据源同一份口径）。 */
function reportComments(cmt) {
  if (wantJson) { console.log(JSON.stringify(cmt, null, 2)); return }
  if (!cmt) { console.log('评论   数据未取到'); return }
  console.log(`评论   共 ${cmt.total} 条，已取 ${cmt.fetched} 条${cmt.partial ? '（只取到热门前几条）' : ''}${cmt.hasCookie ? '' : '（未登录仅前 3 条）'}`)
  cmt.list.forEach((c, i) => {
    const tags = [c.pinned ? '置顶' : null, c.isUp ? 'UP主' : null].filter(Boolean)
    console.log(`${String(i + 1).padStart(3)}. ${c.user}（${c.like} 赞 · ${c.replies} 回复${c.location ? ` · ${c.location}` : ''}${tags.length ? ` · ${tags.join('/')}` : ''}）`)
    console.log(`     ${c.content.replace(/\n/g, ' ')}`)
    for (const s of c.topReplies ?? []) console.log(`       ↳ ${s.user}（${s.like} 赞）：${s.content.replace(/\n/g, ' ')}`)
  })
}

/**
 * 只有「直接运行」时才走 CLI。被 `import`（单元测试）时什么都不做——
 * 否则会打出用法、还把 process.exitCode 改成 2，让测试拿到假的失败退出码。
 */
if (import.meta.main) try {
  /**
   * 抓热门评论（失败只降级）。放在 probe 之后单独调：
   * probe 要保持秒级且不额外打接口，评论只在真正要出转写/速读时才抓。
   */
  const grabComments = async (info) => {
    if (wantNoComments) return null
    try {
      return await fetchComments(info.bvid, {
        aid: info.meta?.aid ?? null,
        cookieHeader: currentCookieHeader(),
        top: commentTop,
      })
    } catch (e) {
      process.stderr.write(`[comments] 取评论失败（速读稿将缺评论分析）：${String(e.message).split('\n')[0]}\n`)
      return null
    }
  }

  if (cmd === 'doctor') {
    await doctor()
  } else if (cmd === 'probe') {
    report(await probe(url))
  } else if (cmd === 'subs') {
    report(await subs(url, cookieFile))
  } else if (cmd === 'comments') {
    const info = await probe(url)
    reportComments(await grabComments(info))
  } else if (cmd === 'asr') {
    const info = await probe(url)
    const comments = await grabComments(info)
    const r = await transcribe(url, comments, info)
    if (wantFull) {
      const dest = join(OUT, `${r.bvid ?? 'video'}.md`)
      writeFileSync(dest, toMarkdown(r, r.segments, { intermediate: false, comments }), 'utf8')
      r.markdown = dest
    }
    report({ ...r, comments })
  } else if (cmd === 'get') {
    const info = await probe(url)
    const comments = await grabComments(info)
    let r = await subs(url, cookieFile)
    if (!r.segments.length) {
      process.stderr.write(`字幕不可用（${r.reason}），转本地识别…\n`)
      r = await transcribe(url, null, info)
    }
    const name = r.bvid ?? 'video'
    // 默认产出策略（2026-10-13 起）：唯一交付物是《速读稿》，
    // 由会话里的模型读转写后写进 out/。转写只是喂给模型的中间产物，默认落 cache/，
    // 不写 out/、不进交付。要单独留一份正式转写时加 --full。
    const dest = wantFull ? join(OUT, `${name}.md`) : join(CACHE, `${name}.transcript.md`)
    writeFileSync(dest, toMarkdown(r, r.segments, { intermediate: !wantFull, comments }), 'utf8')
    process.stderr.write(
      wantFull ? `已写出：${dest}\n` : `已写出中间产物：${dest}（要正式转写加 --full）\n`,
    )
    report({ ...r, comments, markdown: dest })
  } else {
    console.error('用法：node bilisum.mjs <doctor|probe|subs|asr|get|comments> [url] [--cookie <file>] [--json] [--full] [--preview] [--comments N] [--no-comments]')
    process.exitCode = 2
  }
} catch (e) {
  console.error(`错误：${e.message}`)
  process.exitCode = 1
}
