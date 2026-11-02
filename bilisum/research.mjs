// research.mjs —— B 站「方向研究」：给一个方向，自己搜、自己挑、自己取素材。
//
// 定位：bilisum.mjs 处理「一条链接 → 一份速读稿」；本工具处理
//       「一个方向 → 挑 3 条可信视频 → 批量逐字稿 + 按逐字稿触发抽帧」。
//       结论由对话里的模型写，本工具只负责把素材取齐。
//
// 设计见 docs/superpowers/specs/2026-11-02-bili-direction-research-design.md
//
// 用法：
//   node research.mjs "最近显卡价格" --kind price --keywords "显卡价格 双十一|9070XT 降价" --json
//   node research.mjs "最近显卡价格" --search-only        # 只出候选表
//   node research.mjs --bv BV1xx,BV2xx                    # 跳过搜索，只取稿+抽帧
//
// 开关：
//   --kind price|review|howto|general  时效窗口（默认 general=30天）
//   --pick N                           选几条（默认 3）
//   --keywords "a|b|c"                 模型拆好的关键词组（默认用方向句本身）
//   --search-only                      只搜索打分，不取稿
//   --bv BV1,BV2                       指定视频，跳过搜索
//   --no-frames                        不抽帧
//   --max-frames N                     单条最多截几帧（默认 3）
//   --json                             输出全量 JSON（默认打人类可读摘要）
//
// 环境硬要求（和 bilisum 一致）：
//   - 完全权限（danger-full-access）：受限沙箱里 Node 建不了命名管道，spawn 会 EPERM
//   - B 站必须直连：走 127.0.0.1:7890 会让 api.bilibili.com 返回 412/HTML
//   - TEMP/TMP 指到 cache/：yt-dlp 是 PyInstaller onefile，默认 TEMP 会解包失败

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = join(HERE, 'cache')
const FRAMES = join(CACHE, 'frames')
const VIDEO = join(CACHE, 'video')
const YTDLP = join(HERE, 'scripts', 'yt-dlp.exe')
const FFMPEG = join(HERE, 'scripts', 'ffmpeg.exe')
const BILISUM = join(HERE, 'bilisum.mjs')
const COOKIE_FILE = join(CACHE, 'cookies.txt')

for (const d of [CACHE, FRAMES, VIDEO]) mkdirSync(d, { recursive: true })

// ---------------------------------------------------------------------------
// 打分权重（改这里就能调口味；spec 第 4.3 节）
// ---------------------------------------------------------------------------
const W = {
  recency: 35,
  authority: 20,
  engagement: 15,
  relevance: 15,
  durationFit: 10,
  channelPresence: 5,
  promoPenalty: 25,
  clickbaitPenalty: 30,
  lowPlayPenalty: 20,
}
const MIN_SCORE = 40 // 低于这个分不入选（宁可素材不足，不硬凑）
const MAX_DURATION_PREF = 20 * 60 // 20 分钟以上开始衰减
const HARD_MAX_DURATION = 35 * 60 // 超过 35 分钟不选（ASR 太慢）
const MIN_DURATION = 3 * 60

// 时效窗口：[满分区内天数, 衰减到下限的天数]
const KIND_WINDOW = {
  price: { full: 7, decayEnd: 30, floor: 0.2 },
  news: { full: 7, decayEnd: 30, floor: 0.2 },
  review: { full: 30, decayEnd: 180, floor: 0.2 },
  howto: { full: 30, decayEnd: 180, floor: 0.2 },
  general: { full: 30, decayEnd: 180, floor: 0.2 },
}

/**
 * 方向意图词：判断一条视频"是不是在讲这个方向"时，光有主题词不够。
 * 实测：搜「显卡价格」时，"4090 显卡烧穿了还能修好吗"这种维修视频主题词全中，
 * 但它讲的是维修不是行情——所以再要求命中该方向的意图词。
 */
const KIND_INTENT = {
  price: /(价格|行情|涨|跌|降|报价|到手|缺货|供货|调价|日报|周报|预算|值不值)/,
  news: /(发布|上线|更新|进展|突破|开源|新版|新版本|版本|升级|宣布|推出|问世|亮相|榜单|盘点|总结|年度)/,
  review: /(评测|测评|体验|对比|怎么样|值不值|开箱|实测|上手|使用)/,
  howto: /(教程|怎么|如何|安装|设置|指南|入门|教学|技巧)/,
  general: null,
}

// 抽帧触发词（用户 2026-11-02 定制：字幕里说"资料放屏幕上"才截图，不固定间隔抽）
// 2026-11-02 扩词：实测「请看数据」「价格走势图上」这种才是真正的画面资料信号，
// 少了它们，一条满屏价目表的视频只会抽到一张标题卡。
const TRIGGER_RE = new RegExp(
  [
    '放在屏幕上', '放到屏幕上', '贴在屏幕上', '屏幕上', '如图', '这张图', '图上', '这个图',
    '这张表', '价目表', '图里', '表格里', '截图', '给大家看一下', '大家看这里', '看这里', '我截了',
    '数据来源', '参考价', '官方价', '旗舰店', '京东价', '淘宝价', '拼多多',
    '这张价格表', '价格表', '看这个表', '图表', '曲线', '走势图', '价格走势', '一览表', '价格一览',
    '请看数据', '看数据', '看一下数据', '报价', '现价', '售价',
  ].join('|'),
)

// 带货/商单信号
const PROMO_RE = /(带货|下单|优惠券|领券|点链接|进店|链接在|商家|推广|广告|商务|恰饭|购买链接|小黄车)/

// ---------------------------------------------------------------------------
// 子进程 & HTTP 基础件
// ---------------------------------------------------------------------------
function childEnv() {
  const env = { ...process.env, TEMP: CACHE, TMP: CACHE, TMPDIR: CACHE }
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) env[k] = ''
  env.NO_PROXY = '*'
  env.no_proxy = '*'
  return env
}

function run(exe, args, { cwd = HERE, maxBuffer = 256 * 1024 * 1024, env = childEnv() } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = [], err = []
    let size = 0
    child.stdout.on('data', (d) => {
      size += d.length
      if (size > maxBuffer) { child.kill(); rej(new Error('子进程输出超过缓冲上限')) } else out.push(d)
    })
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', rej)
    child.on('close', (code) => res({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cookieHeader() {
  if (!existsSync(COOKIE_FILE)) return ''
  const parts = []
  for (const line of readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const p = line.split('\t')
    if (p.length >= 7) parts.push(`${p[5]}=${p[6]}`)
  }
  return parts.join('; ')
}
const COOKIE = cookieHeader()

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 打 B 站接口并解析 JSON。
 * 坑：风控命中时**返回 HTML 而不是 JSON**（实测），必须检测后重试，不能直接 .json()。
 */
async function biliJson(pathOrUrl, { referer = 'https://www.bilibili.com/', attempts = 4 } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : 'https://api.bilibili.com' + pathOrUrl
  let lastErr = null
  for (let i = 0; i < attempts; i++) {
    try {
      const headers = {
        'User-Agent': UA,
        Referer: referer,
        Origin: 'https://search.bilibili.com',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      }
      if (COOKIE) headers.Cookie = COOKIE
      const r = await fetch(url, { headers })
      const text = await r.text()
      if (!text.trimStart().startsWith('{')) {
        lastErr = new Error(`非 JSON 响应（HTTP ${r.status}，疑似风控）`)
        await sleep(1200 * (i + 1))
        continue
      }
      const j = JSON.parse(text)
      if (j.code === -412 || j.code === -352) {
        lastErr = new Error(`B 站风控（code=${j.code} ${j.message ?? ''}）`)
        await sleep(1800 * (i + 1))
        continue
      }
      return j
    } catch (e) {
      lastErr = e
      await sleep(1200 * (i + 1))
    }
  }
  throw lastErr ?? new Error('请求失败')
}

// ---------------------------------------------------------------------------
// 格式化小工具
// ---------------------------------------------------------------------------
const stripEm = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim()
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function fmtCount(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}
function fmtDate(unix) {
  if (!unix) return '未知'
  const d = new Date(unix * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtAgo(unix) {
  if (!unix) return '未知'
  const days = (Date.now() / 1000 - unix) / 86400
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} 小时前`
  if (days < 30) return `${Math.round(days)} 天前`
  return `${Math.round(days / 30)} 个月前`
}
function hhmmss(s) {
  const t = Math.max(0, Math.round(s))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  const p = (x) => String(x).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(sec)}`
}
/** "7:14" → 434；"1:02:33" → 3753；已是数字则原样返回 */
function parseDuration(v) {
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map((x) => Number(x) || 0)
  return parts.reduce((acc, x) => acc * 60 + x, 0)
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------
async function searchPage(keyword, order = 'totalrank') {
  const q = encodeURIComponent(keyword)
  const path = `/x/web-interface/search/type?search_type=video&keyword=${q}&page=1&order=${order}`
  const j = await biliJson(path, { referer: `https://search.bilibili.com/all?keyword=${q}` })
  if (j.code !== 0) throw new Error(`搜索失败 code=${j.code} ${j.message ?? ''}`)
  return (j.data?.result ?? []).filter((v) => v && v.bvid).map((v) => ({
    bvid: v.bvid,
    aid: num(v.aid) || null,
    title: stripEm(v.title),
    author: stripEm(v.author),
    mid: num(v.mid) || null,
    typename: v.typename ?? '',
    play: num(v.play),
    like: num(v.like),
    favorites: num(v.favorites),
    reply: num(v.review),
    danmaku: num(v.video_review),
    pubdate: num(v.pubdate),
    duration: parseDuration(v.duration),
    desc: stripEm(v.description ?? v.desc),
    badgepay: num(v.badgepay), // 1 = 商业推广
    tags: stripEm(v.tag ?? ''),
    _foundBy: new Set([keyword]),
  }))
}

/** 拆出的关键词组 ×（综合 + 最新）各一页 → 去重合并 */
async function collectCandidates(keywords) {
  const map = new Map()
  const warnings = []
  for (const kw of keywords) {
    for (const order of ['totalrank', 'pubdate']) {
      try {
        const list = await searchPage(kw, order)
        for (const v of list) {
          const prev = map.get(v.bvid)
          if (prev) { prev._foundBy.add(kw); continue }
          map.set(v.bvid, v)
        }
      } catch (e) {
        warnings.push(`关键词「${kw}」(${order}) 检索失败：${String(e.message).split('\n')[0]}`)
      }
      await sleep(800) // 控制节奏，避免风控
    }
  }
  return { candidates: [...map.values()], warnings }
}

/** 补粉丝数（只给打分靠前的候选补，省请求） */
async function fillFans(list) {
  let filled = 0
  for (const v of list) {
    if (!v.mid) continue
    try {
      const j = await biliJson(`/x/relation/stat?vmid=${v.mid}`)
      if (j.code === 0) { v.fans = num(j.data?.follower); filled++ }
    } catch { /* 补不到就按 0 处理，不影响主流程 */ }
    await sleep(250)
  }
  return filled
}

// ---------------------------------------------------------------------------
// 打分（spec 4.3）
// ---------------------------------------------------------------------------
function recencyScore(pubdate, kind) {
  const w = KIND_WINDOW[kind] ?? KIND_WINDOW.general
  const age = (Date.now() / 1000 - pubdate) / 86400
  if (age <= w.full) return 1
  if (age >= w.decayEnd) return w.floor
  const t = (age - w.full) / (w.decayEnd - w.full) // 0 → 1
  return 1 - (1 - w.floor) * t
}

const clamp01 = (x) => Math.max(0, Math.min(1, x))

function scoreOne(v, ctx) {
  const reasons = []
  const kind = ctx.kind

  // 时效
  const rec = recencyScore(v.pubdate, kind)
  const ageDays = (Date.now() / 1000 - v.pubdate) / 86400
  if (ageDays <= 3) reasons.push(`很新（${fmtAgo(v.pubdate)}）`)
  else if (ageDays > 60) reasons.push(`偏旧（${fmtAgo(v.pubdate)}）`)

  // 权威度：粉丝数为主，播放为辅
  const fans = v.fans ?? 0
  const fanScore = clamp01(Math.log10(fans + 1) / 6) // 100 万粉 → 1
  const playScore = clamp01(Math.log10(v.play + 1) / 6.5)
  const authority = 0.65 * fanScore + 0.35 * playScore
  if (fans >= 5e5) reasons.push(`UP 粉丝 ${fmtCount(fans)}`)
  else if (fans >= 1e5) reasons.push(`UP 粉丝 ${fmtCount(fans)}`)
  else if (fans > 0 && fans < 1e4 && v.play > 5e4) reasons.push(`小号爆款（粉丝 ${fmtCount(fans)}）`)

  // 互动
  const likeRate = v.play > 0 ? v.like / v.play : 0
  const replyRate = v.play > 0 ? v.reply / v.play : 0
  const engagement = 0.5 * clamp01(likeRate / 0.08) + 0.5 * clamp01(replyRate / 0.008)

  // 相关度：标题+简介命中关键词词元
  const haystack = `${v.title} ${v.desc} ${v.tags}`.toLowerCase()
  const terms = ctx.terms
  const hit = terms.filter((t) => haystack.includes(t.toLowerCase())).length
  const relevance = terms.length ? clamp01(hit / Math.max(3, Math.ceil(terms.length * 0.6))) : 0.5
  if (hit >= Math.max(2, Math.ceil(terms.length * 0.6))) reasons.push(`标题/简介命中 ${hit}/${terms.length}`)

  // 时长
  const dur = v.duration
  let durationFit = 1
  if (dur < MIN_DURATION) durationFit = clamp01(0.4 + 0.6 * (dur / MIN_DURATION))
  else if (dur > MAX_DURATION_PREF) durationFit = clamp01(1 - 0.5 * ((dur - MAX_DURATION_PREF) / (HR(1) - MAX_DURATION_PREF)))
  if (dur >= 3 * 60 && dur <= 20 * 60) reasons.push(`时长 ${Math.round(dur / 60)} 分钟`)

  // 垂类常驻：同一 UP 在候选池里出现多次
  const presence = (ctx.midCount.get(v.mid) ?? 0) >= 2 ? 1 : 0
  if (presence) reasons.push('该 UP 在本次结果里多次出现')

  // 惩罚
  const promo = v.badgepay === 1 || PROMO_RE.test(`${v.title} ${v.desc}`) ? 1 : 0
  if (v.badgepay === 1) reasons.push('带 B 站商单标记（已降权）')

  const clickbait = /(震惊|必买|速看|不看后悔|哭了|炸裂)/.test(v.title) && v.play < 20000 ? 1 : 0
  const isDailyNews = /(\d{1,2}\s*月\s*\d{1,2}\s*日|日报|行情|快报)/.test(v.title)
  const lowPlay = v.play < 2000 ? (isDailyNews ? 0.5 : 1) : 0

  const raw =
    W.recency * rec +
    W.authority * authority +
    W.engagement * engagement +
    W.relevance * relevance +
    W.durationFit * durationFit +
    W.channelPresence * presence -
    W.promoPenalty * promo -
    W.clickbaitPenalty * clickbait -
    W.lowPlayPenalty * lowPlay

  return {
    score: Math.max(0, Math.min(100, raw)),
    reasons,
    flags: { promo, clickbait, lowPlay: lowPlay > 0, isDailyNews, fans, ageDays, relevance },
  }
}

const HR = (h) => h * 3600

// ---------------------------------------------------------------------------
// 选题：先满足「至少一条新鲜 + 至少一条权威」，再按分数补齐，同一 UP 最多一条
// ---------------------------------------------------------------------------
function pickTop(scored, n) {
  // 硬门槛：**别把 6 播放的小号当"最新"选进来**（实测 2026-11-02 首跑就中招：
  // 按 pubdate 排序的第一条是 6 播放的私信封面号，光靠 recency 35 分就能混进 Top3）。
  // 另一次中招的是「7 粉丝 / 296 播放的日报抄号」——标题带"日报"就想豁免播放量，
  // 结果把搬运号选成了最新素材。所以日报豁免只对"有粉丝底子"的 UP 生效。
  const usableQuality = (s) => {
    if (s.v.play >= 1000) return true
    if ((s.v.fans ?? 0) >= 10000) return true
    if (s.flags.isDailyNews && (s.v.fans ?? 0) >= 3000) return true
    return false
  }

  // 相关性闸门：标题/简介连 1/5 的关键词都不沾，分数再高也不是这个题的视频。
  // （实测：搜"显卡价格"时一条"270K 核显评测"靠时效+时长混到 83 分，得挡掉。）
  const onTopic = (s) => (s.flags.relevance ?? 1) >= 0.2
  const usable = (s) => usableQuality(s) && onTopic(s)

  const pool = scored.filter((s) => s.score >= MIN_SCORE && s.v.duration <= HARD_MAX_DURATION && usable(s))
  const picked = []
  const usedAuthors = new Set()
  const take = (s) => {
    if (!s || picked.includes(s)) return false
    if (s.v.author && usedAuthors.has(s.v.author)) return false
    picked.push(s)
    if (s.v.author) usedAuthors.add(s.v.author)
    return true
  }

  // 约束 1：最新的一条（价格类尤其重要）
  const freshest = [...scored]
    .filter((s) => s.v.duration <= HARD_MAX_DURATION && usable(s))
    .sort((a, b) => b.v.pubdate - a.v.pubdate)[0]
  if (freshest && freshest.score >= MIN_SCORE) take(freshest)

  // 约束 2：粉丝最多的一条（权威）
  const authoritative = [...scored]
    .filter((s) => (s.v.fans ?? 0) > 0 && s.v.duration <= HARD_MAX_DURATION && usable(s))
    .sort((a, b) => (b.v.fans ?? 0) - (a.v.fans ?? 0))[0]
  if (authoritative && authoritative.score >= MIN_SCORE) take(authoritative)

  // 约束 3：按分数补齐
  for (const s of [...pool].sort((a, b) => b.score - a.score)) {
    if (picked.length >= n) break
    take(s)
  }
  return picked.slice(0, n)
}

// ---------------------------------------------------------------------------
// UP 主侦察（2026-11-02 用户改结构：先定信源、经用户确认，再只看这些信源）
//
// 为什么要多这一层：搜索结果里"提到这个话题"和"长期专做这个话题"是两回事。
// 前者可能是蹭热点的综合区大号，后者才是这个方向的专业 UP。判断后者必须看
// **主页投稿列表**（连续性、更新节奏、每条的播放是否稳定），而 B 站主页接口
// 2023 起需要 WBI 签名。
// ---------------------------------------------------------------------------

/** WBI 混入表（B 站前端固定常量，官方无文档，社区实测稳定） */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]
const md5hex = (s) => createHash('md5').update(s).digest('hex')

let wbiCache = null
async function wbiKeys() {
  if (wbiCache) return wbiCache
  const r = await biliJson('/x/web-interface/nav')
  const img = r.data?.wbi_img?.img_url ?? ''
  const sub = r.data?.wbi_img?.sub_url ?? ''
  const pick = (u) => String(u).split('/').pop().split('.')[0]
  if (!img || !sub) throw new Error('拿不到 WBI 密钥（nav 接口异常）')
  wbiCache = { imgKey: pick(img), subKey: pick(sub) }
  return wbiCache
}

/** 给 /x/space/wbi/* 之类的接口拼签名 query（返回带 query 的 path，交给 biliJson） */
async function signedPath(path, params) {
  const { imgKey, subKey } = await wbiKeys()
  const orig = imgKey + subKey
  const mixin = MIXIN_TAB.map((n) => orig[n]).join('').slice(0, 32)
  const p = { ...params, wts: Math.floor(Date.now() / 1000) }
  const query = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  return `${path}?${query}&w_rid=${md5hex(query + mixin)}`
}

/** UP 基本信息：昵称、认证（官方 title）、签名 */
async function upProfile(mid) {
  const j = await biliJson(await signedPath('/x/space/wbi/acc/info', { mid }), {
    referer: `https://space.bilibili.com/${mid}`,
  })
  if (j.code !== 0) throw new Error(`取 UP 信息失败 code=${j.code} ${j.message ?? ''}`)
  const d = j.data ?? {}
  return {
    mid,
    name: d.name ?? '',
    sign: d.sign ?? '',
    official: d.official?.title ?? '',
    officialType: d.official?.type ?? -1,
  }
}

/** UP 最近投稿（按发布时间倒序；可选 keyword 过滤） */
async function upVideos(mid, { keyword = '', ps = 30 } = {}) {
  const params = { mid, ps, pn: 1, order: 'pubdate', platform: 'web', web_location: 1550101 }
  if (keyword) params.keyword = keyword
  const j = await biliJson(await signedPath('/x/space/wbi/arc/search', params), {
    referer: `https://space.bilibili.com/${mid}/video`,
    attempts: 6,
  })
  if (j.code !== 0) throw new Error(`取 UP 投稿失败 code=${j.code} ${j.message ?? ''}`)
  return (j.data?.list?.vlist ?? []).map((v) => ({
    bvid: v.bvid,
    title: stripEm(v.title),
    desc: stripEm(v.description ?? ''),
    play: num(v.play),
    reply: num(v.comment),
    danmaku: num(v.video_review),
    like: 0, // 主页列表接口不返回点赞数，engagement 只用评论率
    favorites: 0,
    pubdate: num(v.created),
    duration: parseDuration(v.length),
    author: '',
    mid,
    typename: '',
    badgepay: 0,
    tags: '',
    fans: null,
  }))
}

/**
 * UP 数据本地缓存（12 小时）。
 * 主页接口风控比搜索严得多：同一次侦察里连打十来个 UP 就会 -412，
 * 实测芝士华莱士（49 万粉，这个方向最该看的人）就是被风控挡掉的。
 * 缓存既省请求，也让"改天再问同一个方向"不用重新侦察。
 */
const UP_CACHE = join(CACHE, 'ups')
mkdirSync(UP_CACHE, { recursive: true })
const UP_TTL_MS = 12 * 3600 * 1000

async function cachedUp(mid, kind, loader) {
  const file = join(UP_CACHE, `${mid}.json`)
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      if (j.kind === kind && Date.now() - j.ts < UP_TTL_MS) return j.data
    }
  } catch { /* 缓存坏了就当没有 */ }
  const data = await loader()
  writeFileSync(file, JSON.stringify({ ts: Date.now(), kind, data }), 'utf8')
  return data
}

const median = (arr) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * 给一位 UP 算「是不是这个方向的专业 UP」。
 * 三个硬指标，缺一不可：
 *   垂直度 —— 最近 30 条投稿里有多少条在讲这个方向（蹭热点的综合区大号会很低）
 *   连续性 —— 最近 90 天发了多少、平均几天一条（停更号不算）
 *   数据合理 —— 播放中位数 / 粉丝数在合理区间，且播放不忽高忽低
 */
function scoreUp(up, { terms, recent, kind }) {
  const reasons = []
  const now = Date.now() / 1000
  const vids = recent.filter((v) => v.pubdate > 0)
  const intent = KIND_INTENT[kind] ?? null
  // 命中主题词 **且** 命中方向意图词，才算"这条投稿在讲这个方向"
  const haystackHit = (v) => {
    const s = `${v.title} ${v.desc}`.toLowerCase()
    if (!terms.some((t) => s.includes(t.toLowerCase()))) return false
    if (intent && !intent.test(s)) return false
    return true
  }
  const topicVids = vids.filter(haystackHit)
  const verticality = vids.length ? topicVids.length / vids.length : 0
  if (verticality >= 0.5) reasons.push(`近 ${vids.length} 条投稿里 ${topicVids.length} 条讲这个方向`)
  else if (topicVids.length >= 3) reasons.push(`近 ${vids.length} 条投稿里 ${topicVids.length} 条相关`)

  const last90 = vids.filter((v) => now - v.pubdate < 90 * 86400).length
  const spanDays = vids.length > 1 ? (vids[0].pubdate - vids[vids.length - 1].pubdate) / 86400 : 0
  const perWeek = spanDays > 0 ? (vids.length / spanDays) * 7 : 0
  let cadence = clamp01(perWeek / 3) // 每周 3 条封顶
  if (last90 < 4) cadence *= 0.4 // 近 90 天几乎没更新，不算"连续发"
  if (last90 >= 8) reasons.push(`近 90 天更新 ${last90} 条`)
  else if (last90 > 0) reasons.push(`近 90 天更新 ${last90} 条（偏少）`)

  const fans = up.fans ?? 0
  const plays = vids.map((v) => v.play).filter((p) => p > 0)
  const medPlay = median(plays)
  const playRatio = fans > 0 ? medPlay / fans : 0
  let dataScore = 0
  // 播放量级：中位播放 5 千以上才算"有人看"
  dataScore += 0.5 * clamp01(Math.log10(medPlay + 1) / 5.5)
  // 播放/粉丝比：0.02–2 属于健康；<0.01 像僵尸/刷粉，>5 像单条爆款不可持续
  if (playRatio >= 0.02 && playRatio <= 2) dataScore += 0.35
  else if (playRatio > 0 && playRatio < 0.02) dataScore += 0.15
  else if (playRatio > 2) dataScore += 0.2
  if (fans >= 50000) reasons.push(`粉丝 ${fmtCount(fans)}`)
  if (medPlay > 0) reasons.push(`中位播放 ${fmtCount(medPlay)}`)

  // 稳定性：四分位距 / 中位数（越小越稳）
  let stability = 0.5
  if (plays.length >= 6) {
    const s = [...plays].sort((a, b) => a - b)
    const q1 = s[Math.floor(s.length * 0.25)]
    const q3 = s[Math.floor(s.length * 0.75)]
    const iqrRatio = medPlay > 0 ? (q3 - q1) / medPlay : 9
    stability = clamp01(1 - iqrRatio / 3)
  }
  dataScore += 0.15 * stability
  dataScore = clamp01(dataScore)

  const officialBoost = up.official ? 1 : 0
  if (up.official) reasons.push(`认证：${up.official}`)

  // 商单比例：候选池里该 UP 带商单标记的比例（没有数据时按 0 处理）
  const promoRatio = up.promoRatio ?? 0
  if (promoRatio > 0.3) reasons.push(`商单比例偏高 ${Math.round(promoRatio * 100)}%（已扣分）`)

  const score =
    40 * verticality +
    20 * cadence +
    20 * dataScore +
    10 * officialBoost +
    10 * stability -
    15 * promoRatio

  // 代表作：相关投稿里播放最高的 3 条（给用户扫一眼）
  const topVideos = [...topicVids].sort((a, b) => b.play - a.play).slice(0, 3)
    .map((v) => ({ bvid: v.bvid, title: v.title, play: v.play, pubdate: v.pubdate }))

  return {
    ...up,
    score: +score.toFixed(1),
    reasons,
    metrics: {
      recentCount: vids.length,
      topicCount: topicVids.length,
      verticality: +verticality.toFixed(2),
      last90,
      perWeek: +perWeek.toFixed(1),
      medianPlay: medPlay,
      playRatio: +playRatio.toFixed(3),
      stability: +stability.toFixed(2),
      promoRatio: +promoRatio.toFixed(2),
    },
    topVideos,
    _topicVids: topicVids,
  }
}

/**
 * 从候选视频池聚合出 UP 主，逐个侦察。
 *
 * 排序不能用"出现在搜索结果里的条数"——实测那样排，前面全是每天发十几条
 * 「低至 2337 元拿下 XX」的带货小号（粉丝两千、中位播放 133），而真正该看的
 * 赵德柱（101 万粉）因为只在 3 条候选里出现，反而落选。
 * 改成按"该 UP 在本方向候选里的播放量总和（对数）"排：既看出现次数，也看每条的质量。
 */
async function reconUps(candidates, { terms, kind, maxUps = 20 }) {
  const byMid = new Map()
  for (const v of candidates) {
    if (!v.mid) continue
    if (!byMid.has(v.mid)) byMid.set(v.mid, { mid: v.mid, name: v.author, videos: [] })
    byMid.get(v.mid).videos.push(v)
  }
  const ranked = [...byMid.values()]
    .map((u) => {
      // 排序权重：**最高播放为主、出现次数为辅**。
      // 只用「Σ log(播放)」会被每天发十几条、每条几百播放的带货号淹没
      // （实测那样排，天才赵德柱 101 万粉直接掉出前 12）。
      const plays = u.videos.map((v) => v.play)
      const maxPlay = Math.max(...plays, 0)
      return { ...u, weight: Math.log10(maxPlay + 1) * 2 + Math.min(u.videos.length, 6) * 0.5 }
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxUps)

  const ups = []
  const related = []
  const rejected = []
  const warnings = []
  for (const u of ranked) {
    try {
      const packed = await cachedUp(u.mid, kind, async () => {
        const prof = await upProfile(u.mid)
        await sleep(2000)
        const recent = await upVideos(u.mid, { ps: 30 })
        await sleep(2000)
        let fans = 0
        try {
          const fs = await biliJson(`/x/relation/stat?vmid=${u.mid}`, { attempts: 6 })
          if (fs.code === 0) fans = num(fs.data?.follower)
        } catch { /* 拿不到粉丝就不算数据分，不阻塞 */ }
        return { prof, recent, fans }
      })

      // 商单比例：候选池里该 UP 的视频有多少带商单标记
      const promoRatio = u.videos.length
        ? u.videos.filter((v) => v.badgepay === 1).length / u.videos.length
        : 0

      const scored = scoreUp(
        {
          mid: u.mid,
          name: packed.prof.name || u.name,
          sign: packed.prof.sign,
          official: packed.prof.official,
          fans: packed.fans,
          promoRatio,
        },
        { terms: terms, recent: packed.recent, kind },
      )
      scored.hitInSearch = u.videos.length

      /**
       * 硬门槛（"数据合理"的可执行定义）：
       * 粉丝 ≥ 3000、中位播放 ≥ 2000、近 90 天 ≥ 4 条更新、播放/粉丝比不畸形。
       * 不设门槛的话，粉丝 3 人的搬运号、粉丝两千但播放 133 的带货号都会排到第一。
       *
       * 垂直度分两档（用户要"可能有多位"）：
       *   A 档 专业源：垂直度 ≥ 30%，连续发这个方向；
       *   B 档 相关权威源：垂直度 15–30%，但粉丝 ≥ 10 万且中位播放 ≥ 3 万——
       *        这种是综合区大号偶尔深做（比如笔吧评测室讲笔记本行情），可作交叉参考。
       */
      const m = scored.metrics
      const fail = []
      if ((packed.fans ?? 0) < 3000) fail.push(`粉丝只有 ${fmtCount(packed.fans ?? 0)}`)
      if ((m.medianPlay ?? 0) < 2000) fail.push(`中位播放只有 ${fmtCount(m.medianPlay ?? 0)}`)
      if (m.last90 < 4) fail.push(`近 90 天只更新 ${m.last90} 条`)
      if (m.playRatio > 10) fail.push(`播放/粉丝比异常 ${m.playRatio}`)
      if (fail.length) {
        rejected.push({ mid: scored.mid, name: scored.name, reasons: fail })
      } else if (m.verticality >= 0.3) {
        ups.push(scored)
      } else if (m.verticality >= 0.15 && (packed.fans ?? 0) >= 100000 && m.medianPlay >= 30000) {
        related.push(scored)
      } else {
        rejected.push({ mid: scored.mid, name: scored.name, reasons: [`垂直度 ${Math.round(m.verticality * 100)}%（不够专）`] })
      }
    } catch (e) {
      const msg = String(e.message).split('\n')[0]
      warnings.push(`UP ${u.name || u.mid} 侦察失败：${msg}`)
      // 被风控就歇一会儿，别把后面几个 UP 一起连累
      if (/风控|-412|-352/.test(msg)) await sleep(6000)
    }
  }
  ups.sort((a, b) => b.score - a.score)
  related.sort((a, b) => b.score - a.score)
  return { ups, related, rejected, warnings }
}

/** 只从用户确认的 UP 里选片（每人上限按信源数 / 条数自动定） */
function pickFromUps(ups, { terms, kind, pickN }) {
  const scored = []
  const midCount = new Map(ups.map((u) => [u.mid, 1]))
  const now = Date.now() / 1000
  for (const u of ups) {
    for (const v of u._topicVids ?? []) {
      if (v.duration > HARD_MAX_DURATION) continue
      const age = (now - v.pubdate) / 86400
      // 价格/新闻类只认窗口内的内容；评测/教程放宽
      const windowDays = kind === 'price' || kind === 'news' ? 30 : 365
      if (age > windowDays) continue
      const enriched = { ...v, author: u.name, fans: u.fans }
      const scoredOne = scoreOne(enriched, { kind, terms, midCount })
      /**
       * 日更型信源必须让"新"压过"高播放"。
       * 实测栽过：芝士华莱士每天一条日报，但最新那条（11月2日）播放只有 36 万，
       * 而 10月28日那条有 108 万播放——纯按分数排会选到 5 天前的日报，
       * 对"最近显卡价格"这种问题等于答非所问。
       * 所以加一个**连续的**新鲜度加分（不是 7 天窗口内的 0/1 饱和）。
       */
      const freshness = clamp01(1 - age / windowDays)
      scored.push({ v: enriched, ...scoredOne, score: scoredOne.score + 25 * freshness })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const picked = []
  const perUp = new Map()
  // 每人上限：信源少的时候要放宽（否则"只确认 1 位 UP 但要 3 条"永远只能拿 2 条）；
  // 信源多的时候要收紧到每人 1 条（用户选 3 位就是为了三种视角，不能让一家占满名额）。
  const perUpLimit = ups.length >= pickN ? 1 : Math.ceil(pickN / Math.max(1, ups.length))
  for (const s of scored) {
    const mid = s.v.mid
    if ((perUp.get(mid) ?? 0) >= perUpLimit) continue
    perUp.set(mid, (perUp.get(mid) ?? 0) + 1)
    picked.push(s)
    if (picked.length >= pickN) break
  }
  // 返回**完整的已评分池**：上层要用它做"某条取稿失败就换同一位 UP 的下一条"。
  return { picked, pool: scored }
}


// ---------------------------------------------------------------------------
// 取稿（复用 bilisum get；缓存优先）
// ---------------------------------------------------------------------------
function transcriptPath(bvid) { return join(CACHE, `${bvid}.transcript.md`) }

/** 转写文件里"真正有多少字"（剥掉时间轴和标点）——用来死活不把空识别当成素材 */
const MIN_TRANSCRIPT_CHARS = 60
function transcriptChars(md) {
  const body = String(md).split('## 完整转写')[1] ?? ''
  return body
    .replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[。，、；：,.!?！？\s\-—…"]/g, '')
    .length
}

async function ensureTranscript(bvid) {
  const p = transcriptPath(bvid)
  const read = () => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  const describe = (md, via) => ({
    bvid, path: p, via,
    source: /转写来源：B 站字幕/.test(md) ? 'subs' : 'asr',
    chars: statSync(p).size,
    textChars: transcriptChars(md),
  })

  if (existsSync(p) && statSync(p).size > 2000) {
    const md = read()
    // 复用时也要看它是字幕稿还是识别稿：抽帧偏移要按粒度来（字幕句子级 / 识别 30 秒窗口）
    if (transcriptChars(md) >= MIN_TRANSCRIPT_CHARS) return describe(md, 'cache')
    // 缓存里是空识别（历史上踩过：整篇只有一句句"。"）→ 删掉重跑一次
    try { unlinkSync(p) } catch { /* 删不掉就算了，下面会覆盖 */ }
  }

  const r = await run(process.execPath, [BILISUM, 'get', bvid, '--comments', '20'])
  if (!existsSync(p)) {
    const tail = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-3).join(' / ')
    return { bvid, path: null, via: 'fail', error: tail || `退出码 ${r.code}` }
  }
  const md = read()
  const textChars = transcriptChars(md)
  if (textChars < MIN_TRANSCRIPT_CHARS) {
    // 识别跑完了但一个字都没出（实测 BV1FVsR6JExY：7 个窗口全是"。"）——
    // 不能当成素材塞给模型，标记失败，让上层换下一条。
    return {
      bvid, path: null, via: 'empty', textChars,
      error: `转写为空（${textChars} 字，多半是识别失败或这条视频没有口播）`,
    }
  }
  const via = /本地\s*SenseVoice|转本地识别/.test(r.stdout + r.stderr) ? 'asr' : 'subs'
  return { ...describe(md, via), via }
}

// ---------------------------------------------------------------------------
// 抽帧：扫逐字稿触发词 → 定位视频 → ffmpeg 截该时刻画面
// ---------------------------------------------------------------------------
function scanTriggers(transcriptMd, maxFrames) {
  const hits = []
  const lines = transcriptMd.split(/\r?\n/)
  for (const line of lines) {
    const m = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*(.+)$/.exec(line.trim())
    if (!m) continue
    const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    if (!TRIGGER_RE.test(m[4])) continue
    // 同一句话反复提不重复截；间隔 < 20 秒的合并
    if (hits.length && t - hits[hits.length - 1].t < 20) continue
    hits.push({ t, text: m[4].slice(0, 60) })
    if (hits.length >= maxFrames) break
  }
  return hits
}

/** 找/下载目标视频的低清版本（抽帧必须有画面，音频路线没有） */
async function ensureVideoFile(bvid) {
  const dir = VIDEO
  const existing = readdirSync(dir).find((f) => f.startsWith(bvid + '.') && /\.(mp4|flv|mkv|webm)$/i.test(f))
  if (existing) return join(dir, existing)

  const out = join(dir, `${bvid}.%(ext)s`)
  const url = `https://www.bilibili.com/video/${bvid}`
  const args = [
    '-f', 'bv*[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/b',
    '-o', out, '--no-playlist', '--no-warnings', '--no-progress',
    '--merge-output-format', 'mp4', url,
  ]
  const r = await run(YTDLP, args, { maxBuffer: 64 * 1024 * 1024 })
  const got = readdirSync(dir).find((f) => f.startsWith(bvid + '.') && /\.(mp4|flv|mkv|webm)$/i.test(f))
  if (!got) {
    throw new Error(`下载视频失败：${(r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' / ')}`)
  }
  return join(dir, got)
}

async function grabFrames(bvid, transcriptMd, maxFrames, via = 'asr') {
  const hits = scanTriggers(transcriptMd, maxFrames)
  if (!hits.length) return { frames: [], note: '未命中"资料放屏幕上"之类触发词，按规则不抽帧' }

  /**
   * 取帧偏移：说"请看数据"那一刻画面还没切过去，得往后挪一点。
   * - 字幕稿是句子级时间点 → +3 秒足够
   * - 本地识别是 **30 秒窗口**，触发词可能出现在窗口末尾 → 往后挪半窗更保险
   *   （实测 BV1EYx56MEtK：窗口从 00:04:01 开始，但要到 ~00:04:28 才说"请看数据"，
   *    按 +1 秒截到的是上一节的标题卡，等于白截）
   */
  const offset = via === 'asr' ? 15 : 3

  let videoPath
  try {
    videoPath = await ensureVideoFile(bvid)
  } catch (e) {
    return { frames: [], note: `命中 ${hits.length} 处触发词，但视频下载失败：${String(e.message).split('\n')[0]}` }
  }

  const dir = join(FRAMES, bvid)
  mkdirSync(dir, { recursive: true })
  const frames = []
  for (const h of hits) {
    const t = h.t + offset
    const file = join(dir, `${String(h.t).padStart(5, '0')}.jpg`)
    const r = await run(FFMPEG, ['-ss', String(t), '-i', videoPath, '-frames:v', '1', '-q:v', '3', '-y', file])
    if (existsSync(file) && statSync(file).size > 1000) frames.push({ t: h.t, path: file, said: h.text })
    else if (r.code !== 0) {
      frames.push({ t: h.t, path: null, said: h.text, error: (r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] ?? '' })
    }
  }
  return { frames, note: frames.length ? '' : '触发词命中但截帧失败' }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const has = (name) => argv.includes('--' + name)
const wantJson = has('json')
const searchOnly = has('search-only')
const noFrames = has('no-frames')
const reconMode = has('recon')
const kind = flag('kind', 'general')
const pickN = Number(flag('pick', '3')) || 3
const maxFrames = Number(flag('max-frames', '3')) || 3
const bvArg = flag('bv', null)
const kwArg = flag('keywords', null)
const upsArg = flag('ups', null)
const direction = argv.find((a) =>
  !a.startsWith('--') && a !== bvArg && a !== kwArg && a !== kind && a !== upsArg) ?? ''

const keywords = kwArg ? kwArg.split('|').map((s) => s.trim()).filter(Boolean) : (direction ? [direction] : [])
const terms = [...new Set(
  keywords.flatMap((k) => k.split(/[\s,，、]+/)).filter((t) => t.length >= 2),
)]

function describe(v, s) {
  return [
    `${v.bvid}  ${s.score.toFixed(1)} 分`,
    `  ${v.title}`,
    `  ${v.author}（粉丝 ${v.fans ? fmtCount(v.fans) : '未知'}） · 播放 ${fmtCount(v.play)} · ${Math.round(v.duration / 60)} 分钟 · ${fmtDate(v.pubdate)}`,
    s.reasons.length ? `  理由：${s.reasons.join('；')}` : '',
  ].filter(Boolean).join('\n')
}

if (import.meta.main) {
  try {
    const result = { query: direction || null, kind, keywords, candidates: [], picked: [], transcripts: [], warnings: [] }

    let scored = []
    if (reconMode) {
      /**
       * 阶段一：只定信源，不取稿。
       * 用户 2026-11-02 要求「先找专业 UP，找我确认，然后重点看这些 UP」。
       */
      if (!keywords.length) throw new Error('没有给出方向或关键词')
      const { candidates, warnings } = await collectCandidates(keywords)
      result.warnings.push(...warnings)
      result.candidates = candidates
      const r = await reconUps(candidates, { terms: terms.length ? terms : [direction], kind })
      result.warnings.push(...r.warnings)
      result.ups = r.ups.map(({ _topicVids, ...rest }) => rest)
      result.relatedUps = r.related.map(({ _topicVids, ...rest }) => rest)
      result.rejectedUps = r.rejected
      result.stage = 'recon'
      if (result.ups.length < 2) {
        result.warnings.push('专业源少于 2 位，可以把下面的"相关权威源"也一起算上，或放宽 --kind（如 price→review）')
      }
    } else if (upsArg) {
      // 阶段二：只从用户确认过的信源里选片
      const mids = upsArg.split(',').map((s) => s.trim()).filter(Boolean)
      const ups = []
      for (const mid of mids) {
        try {
          const packed = await cachedUp(mid, kind, async () => {
            const prof = await upProfile(mid)
            await sleep(2000)
            const recent = await upVideos(mid, { ps: 30 })
            await sleep(2000)
            let fans = 0
            try {
              const fs = await biliJson(`/x/relation/stat?vmid=${mid}`, { attempts: 6 })
              if (fs.code === 0) fans = num(fs.data?.follower)
            } catch { /* 粉丝取不到不影响选片 */ }
            return { prof, recent, fans }
          })
          ups.push(scoreUp(
            { mid, name: packed.prof.name, sign: packed.prof.sign, official: packed.prof.official, fans: packed.fans, promoRatio: 0 },
            { terms: terms.length ? terms : [direction], recent: packed.recent, kind },
          ))
        } catch (e) {
          const msg = String(e.message).split('\n')[0]
          result.warnings.push(`信源 ${mid} 读取失败：${msg}`)
          if (/风控|-412|-352/.test(msg)) await sleep(6000)
        }
      }
      result.ups = ups.map(({ _topicVids, ...rest }) => rest)
      result.stage = 'watch-ups'
      const { picked: pickedScored, pool } = pickFromUps(ups, { terms: terms.length ? terms : [direction], kind, pickN })
      scored = pool // 全量候选：取稿失败时用来换同一信源的下一条
      result.candidates = pickedScored.map((s) => s.v)
      result.picked = pickedScored.map((s) => s.v.bvid)
      if (!result.picked.length) {
        result.warnings.push('确认的信源里没找到该方向、且时效内的视频，建议换 UP 或放宽 --kind')
      }
    } else if (bvArg) {
      // 指定视频：跳过搜索，直接补信息
      const list = bvArg.split(',').map((s) => s.trim()).filter(Boolean)
      for (const bv of list) {
        const j = await biliJson(`/x/web-interface/view?bvid=${bv}`)
        if (j.code !== 0) { result.warnings.push(`${bv} 取信息失败：${j.message}`); continue }
        const d = j.data
        result.candidates.push({
          bvid: bv, aid: d.aid, title: d.title, author: d.owner?.name ?? '', mid: d.owner?.mid ?? null,
          typename: d.tname ?? '', play: num(d.stat?.view), like: num(d.stat?.like), favorites: num(d.stat?.favorite),
          reply: num(d.stat?.reply), danmaku: num(d.stat?.danmaku), pubdate: num(d.pubdate),
          duration: num(d.duration), desc: d.desc ?? '', badgepay: 0, tags: '', fans: null,
        })
        await sleep(400)
      }
      await fillFans(result.candidates)
      const midCount = new Map()
      for (const v of result.candidates) midCount.set(v.mid, (midCount.get(v.mid) ?? 0) + 1)
      scored = result.candidates.map((v) => ({ v, ...scoreOne(v, { kind, terms: terms.length ? terms : [direction], midCount }) }))
      result.picked = scored.map((s) => s.v.bvid)
    } else {
      if (!keywords.length) throw new Error('没有给出方向或关键词')
      const { candidates, warnings } = await collectCandidates(keywords)
      result.warnings.push(...warnings)
      result.candidates = candidates
      if (candidates.length < 5) result.warnings.push(`候选只有 ${candidates.length} 条，检索可能被风控或关键词太窄`)

      // 先粗排（粉丝未知时按 0），再把靠前的补粉丝数后重排
      const midCount = new Map()
      for (const v of candidates) midCount.set(v.mid, (midCount.get(v.mid) ?? 0) + 1)
      const ctx0 = { kind, terms: terms.length ? terms : [direction], midCount }
      const rough = candidates
        .map((v) => ({ v, ...scoreOne(v, ctx0) }))
        .sort((a, b) => b.score - a.score)
      await fillFans(rough.slice(0, 15).map((s) => s.v))
      const ctx = { kind, terms: terms.length ? terms : [direction], midCount }
      scored = rough.map((s) => ({ v: s.v, ...scoreOne(s.v, ctx) })).sort((a, b) => b.score - a.score)
      result.scored = scored
      // 即使 --search-only 也算出入选名单，好让模型和人看到「AI 会挑哪几条」，
      // 只是不接着去取稿（省时间）。
      result.picked = pickTop(scored, pickN).map((s) => s.v.bvid)
    }

    // 取稿 + 抽帧。某条取不到（下载失败 / 识别为空）时，自动换**同一 UP 的下一条候选**，
    // 而不是让报告缺一块——用户选的是信源，不是某一条视频。
    const toWatch = searchOnly ? [] : result.picked
    if (toWatch.length) {
      const altsByMid = new Map()
      for (const s of scored) {
        if (!s?.v?.mid) continue
        if (!altsByMid.has(s.v.mid)) altsByMid.set(s.v.mid, [])
        altsByMid.get(s.v.mid).push(s.v.bvid)
      }
      const midOf = new Map(scored.map((s) => [s.v.bvid, s.v.mid]))
      const tried = new Set()
      const queue = [...toWatch]
      const okList = []
      while (queue.length && okList.length < toWatch.length) {
        const bv = queue.shift()
        if (!bv || tried.has(bv)) continue
        tried.add(bv)
        const t = await ensureTranscript(bv)
        if (!t.path) {
          result.transcripts.push(t)
          const alts = (altsByMid.get(midOf.get(bv)) ?? []).filter((x) => !tried.has(x))
          if (alts.length) {
            queue.push(alts[0])
            result.warnings.push(`${bv} 取稿失败（${t.error ?? t.via}），改用同一信源的下一条 ${alts[0]}`)
            const altScored = scored.find((s) => s.v.bvid === alts[0])
            if (altScored && !result.candidates.some((c) => c.bvid === alts[0])) {
              result.candidates.push(altScored.v)
            }
          } else {
            result.warnings.push(`${bv} 取稿失败且该信源没有其它可选视频`)
          }
          continue
        }
        if (!noFrames) {
          const fr = await grabFrames(bv, readFileSync(t.path, 'utf8'), maxFrames, t.source ?? 'asr')
          t.frames = fr.frames
          if (fr.note) t.framesNote = fr.note
        }
        result.transcripts.push(t)
        okList.push(bv)
      }
      result.picked = okList
    }

    // 兜底判定（spec 第 8 节）。--bv 是用户点名要看的视频、--recon 是只定信源，
    // 这两种情况 1 条素材也算正常，不报不足。
    const usable = result.transcripts.filter((t) => t.path).length
    result.insufficient = !searchOnly && !bvArg && !reconMode && usable < 2
    if (result.insufficient) {
      result.warnings.push(`可用素材只有 ${usable} 条，建议放宽时效窗口（--kind review）或换关键词`)
    }

    if (wantJson) {
      // 候选里直接带上分数和入选理由（模型读 candidates[] 就能判断哪条可信），
      // 不再单独输出 scored 数组——两个数组内容重复，JSON 会白白大一倍。
      const byBv = new Map(scored.map((s) => [s.v.bvid, s]))
      result.candidates = result.candidates.map((v) => {
        const { _foundBy, ...rest } = v
        const s = byBv.get(v.bvid)
        return {
          ...rest,
          foundBy: _foundBy ? [..._foundBy] : [],
          score: s ? +s.score.toFixed(1) : null,
          reasons: s?.reasons ?? [],
          flags: s?.flags ?? null,
        }
      })
      delete result.scored
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`方向：${direction || '(指定视频)'}　类型：${kind}　关键词：${keywords.join(' / ') || '-'}`)
      console.log(`候选：${result.candidates.length} 条`)
      if (result.ups?.length || result.relatedUps?.length) {
        const dump = (list, title) => {
          if (!list?.length) return
          console.log(`\n=== ${title}（${list.length} 位，你挑要重点看谁）===`)
          list.forEach((u, i) => {
            const m = u.metrics ?? {}
            console.log(`\n${i + 1}. ${u.name}（mid ${u.mid}）  ${u.score.toFixed(1)} 分${u.official ? ' · ' + u.official : ''}`)
            console.log(`   粉丝 ${u.fans ? fmtCount(u.fans) : '未知'} · 近 ${m.recentCount ?? '?'} 条投稿里 ${m.topicCount ?? '?'} 条相关（垂直度 ${Math.round((m.verticality ?? 0) * 100)}%）· 每周约 ${m.perWeek ?? '?'} 条 · 中位播放 ${fmtCount(m.medianPlay ?? 0)}`)
            if (u.reasons?.length) console.log(`   判断依据：${u.reasons.join('；')}`)
            for (const v of u.topVideos ?? []) {
              console.log(`   代表作 ${v.bvid}  ${fmtDate(v.pubdate).slice(0, 10)}  播放 ${fmtCount(v.play)}  ${v.title.slice(0, 28)}`)
            }
          })
        }
        dump(result.ups, 'A 档：这个方向的专业源（连续发、数据合理）')
        dump(result.relatedUps, 'B 档：相关权威源（综合区大号偶尔深做，可交叉参考）')
        if (result.rejectedUps?.length) {
          console.log(`\n--- 被门槛挡掉的（供参考）---`)
          for (const r of result.rejectedUps) console.log(`· ${r.name}：${r.reasons.join('；')}`)
        }
      }
      const top = (result.scored ?? []).slice(0, Math.max(pickN, 5))
      for (const s of top) console.log('\n' + describe(s.v, s))
      if (result.picked.length) {
        console.log(`\n=== 入选（${result.picked.length} 条）===`)
        for (const bv of result.picked) {
          const s = (result.scored ?? []).find((x) => x.v.bvid === bv)
          const v = s?.v ?? result.candidates.find((x) => x.bvid === bv)
          console.log(`- ${bv}  ${v ? v.title : ''}`)
        }
      }
      if (result.transcripts.length) {
        console.log('\n=== 素材 ===')
        for (const t of result.transcripts) {
          console.log(`${t.bvid}  via=${t.via}  ${t.path ?? '失败:' + (t.error ?? '')}`)
          if (t.frames?.length) for (const f of t.frames) console.log(`   帧 ${hhmmss(f.t)} → ${f.path}（原话：${f.said}）`)
          if (t.framesNote) console.log(`   注：${t.framesNote}`)
        }
      }
      if (result.warnings.length) {
        console.log('\n=== 提示 ===')
        for (const w of result.warnings) console.log('- ' + w)
      }
      if (result.insufficient) console.log('\n⚠ 可用素材不足，建议如实告知用户"这个方向近期 B 站没有可信内容"')
    }
  } catch (e) {
    console.error('错误：' + String(e.message ?? e))
    process.exitCode = 1
  }
}
