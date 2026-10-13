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
 * 用法：
 *   node bilisum.mjs probe   <url> [--cookie <file>]
 *   node bilisum.mjs subs    <url> --cookie <file>
 *   node bilisum.mjs asr     <url>
 *   node bilisum.mjs get     <url> [--cookie <file>]   # 字幕优先，失败落 ASR
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    throw new Error(`yt-dlp 探测失败（退出码 ${r.code}）：\n${tail}`)
  }
  let info
  try { info = JSON.parse(r.stdout) } catch { throw new Error('yt-dlp 输出不是合法 JSON（可能是风控错误页）') }
  return {
    url: normalized,
    bvid: info.id ?? null,
    title: (info.title ?? '').trim() || info.id,
    duration: Number.isFinite(info.duration) ? info.duration : null,
    uploader: info.uploader ?? null,
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
 */
async function biliApi(path) {
  const ck = currentCookieHeader()
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
 * 取官方字幕（AI 字幕或投稿字幕），返回带**官方时间戳**的段落。
 *
 * 为什么不走 yt-dlp：实测 yt-dlp 对同一视频报"无字幕"，而 player/v2 接口
 * 明明返回了 `lan=ai-zh`。直接走接口既拿到字，也拿到 from/to 精确时间，
 * 比识别结果更准更快。
 */
async function subsViaApi(url, info) {
  const param = videoParam(url)
  const view = await biliApi(`/x/web-interface/view?${param}`)
  const aid = view.aid, cid = view.cid

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
  /** 非规范文件的兜底：万一一直遇不到规范文件，至少给一份能用的 */
  let fallback = null
  const MAX_TRIES = 16
  for (let i = 1; i <= MAX_TRIES; i++) {
    // 每轮都重新要一次 player/v2 —— 换一个文件才可能拿到完整那份
    let candidates
    let allCount = 0
    try {
      const player = await biliApi(`/x/player/v2?aid=${aid}&cid=${cid}`)
      const list = player?.subtitle?.subtitles ?? []
      const all = [...list, ...submitted].filter((c) => c.subtitle_url || c.url)
      // **只留规范文件**（文件名以 aid+cid 开头）。非规范的那些不仅内容残缺，
      // 实测拿到的还是**完全不相干视频**的字幕（出现过短剧台词"弟弟就大三了"）。
      // 在挑之前就筛掉，避免把带宽浪费在垃圾上、也避免选错。
      candidates = all.filter((c) => {
        const u = String(c.subtitle_url ?? c.url ?? '')
        const n = u.split('/').pop()?.split('?')[0] ?? ''
        return n.startsWith(canonicalPrefix)
      })
      allCount = all.length
    } catch (e) {
      // 关键：中途失败**不能丢掉已经拿到的 best**，否则"第 1 次拿到完整、
      // 第 2 次接口抖动"就变成返回空——这正是之前的 bug。
      lastErr = e
      process.stderr.write(`[subs] 第 ${i} 次取字幕列表失败：${e.message}\n`)
      await new Promise((res) => setTimeout(res, 400 * i))
      continue
    }
    if (candidates.length === 0) {
      // allCount === 0 → 这个视频确实没有字幕轨；allCount > 0 但被筛光 →
      // 本轮只拿到非规范文件，纯属运气，继续换（**不能**报成"没有字幕"）。
      if (allCount === 0) sawNoCandidates = true
      else foreignCount++
      await new Promise((res) => setTimeout(res, 250 + 60 * i))
      continue
    }
    // 同一语言优先，其次优先规范文件名（aid+cid 开头的那份）
    const pick = prefer.map((p) => candidates.find((c) => c.lan === p)).find(Boolean) ?? candidates[0]
    const raw = pick.subtitle_url ?? pick.url ?? ''
    if (!raw) continue
    const subUrl = raw.startsWith('//') ? `https:${raw}` : raw
    let r
    try { r = await fetchOne(subUrl) } catch (e) {
      process.stderr.write(`[subs] 第 ${i} 次下载失败：${e.message}\n`)
      await new Promise((res) => setTimeout(res, 400 * i))
      continue
    }
    const better = !best || r.segs.length > best.segs.length || (r.canonical && !best.canonical)
    if (better) { best = r; langUsed = pick.lan; langDocUsed = pick.lan_doc ?? null }
    process.stderr.write(
      `[subs] 第 ${i} 次：${r.bytes}B → ${r.segs.length} 段，覆盖 ${r.covered}s / ${enriched.duration ?? '?'}s` +
      `${r.canonical ? '  [规范文件]' : ''}${r.truncated ? '  ← 不完整，换文件' : '  ✓ 完整'}\n`,
    )
    if (!r.truncated) break
    await new Promise((res) => setTimeout(res, 300 * i))
  }

  if (!best) {
    const reason = lastErr ? `多次尝试都失败：${lastErr.message}`
      : sawNoCandidates ? '该视频没有 AI 字幕，也没有投稿字幕'
      : `${MAX_TRIES} 次都没遇到规范字幕文件（遇到 ${foreignCount} 次非规范文件），换个时间再试`
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
async function transcribe(url) {
  if (!existsSync(MODEL) || !existsSync(TOKENS)) {
    throw new Error(`模型缺失。期望：\n  ${MODEL}\n  ${TOKENS}\n先跑 scripts/fetch-models.ps1`)
  }
  const info = await probe(url)
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
function toMarkdown(info, segments) {
  const total = segments.length ? segments[segments.length - 1].end : (info.duration ?? 0)
  const hhmm = (s) => {
    const t = Math.max(0, Math.round(s))
    return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
  }
  const link = (s) => `https://www.bilibili.com/video/${info.bvid}?t=${Math.floor(s)}`
  const lines = [
    `# ${info.title}`,
    '',
    `- 视频：<https://www.bilibili.com/video/${info.bvid}>`,
    `- 时长：${hhmm(total)}`,
    info.uploader ? `- UP：${info.uploader}` : null,
    `- 转写来源：${info.mode === 'subs' ? `B 站字幕（${info.lang ?? '?'}）` : '本地 SenseVoice'}`,
    '',
    '## 完整转写（带时间）',
    '',
    ...segments.map((s) => `<a href="${link(s.start)}">[${hhmm(s.start)}]</a> ${s.text}`),
    '',
  ].filter((x) => x !== null)
  return lines.join('\n')
}

// ---------- CLI ----------
const [cmd, ...rest] = process.argv.slice(2)
const url = rest.find((a) => !a.startsWith('--'))
const ci = rest.indexOf('--cookie')
const wantJson = rest.includes('--json')
// 没显式给 --cookie 时，自动用 scripts/set-cookie.mjs 存下来的那份。
// 否则会出现"明明配好了 cookie，subs 却还说自己没 cookie"的荒唐情况。
const DEFAULT_COOKIE = join(CACHE, 'cookies.txt')
const cookieFile =
  (ci >= 0 ? rest[ci + 1] : null) ?? (existsSync(DEFAULT_COOKIE) ? DEFAULT_COOKIE : null)

/**
 * 默认只打摘要。
 * 一份 45 分钟视频的官方字幕有几百段，全量 JSON 打到终端没有意义（而且刷屏），
 * 需要全量时显式加 --json。
 */
function report(result) {
  if (wantJson) { console.log(JSON.stringify(result, null, 2)); return }
  const segs = result.segments ?? []
  const chars = segs.reduce((n, s) => n + s.text.length, 0)
  const last = segs.length ? segs[segs.length - 1].end : 0
  const hhmmss = (s) => {
    const t = Math.max(0, Math.round(s))
    return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
  }
  console.log(`标题   ${result.title}`)
  console.log(`UP     ${result.uploader ?? '-'}   BV ${result.bvid ?? '-'}   时长 ${hhmmss(result.duration ?? last)}`)
  console.log(`来源   ${result.mode === 'subs' ? `B 站官方字幕（${result.langDoc ?? result.lang ?? '?'}）` : '本地 SenseVoice 识别'}`)
  console.log(`结果   ${segs.length} 段 / ${chars} 字 / 覆盖到 ${hhmmss(last)}`)
  if (result.reason) console.log(`原因   ${result.reason}`)
  if (result.markdown) console.log(`文件   ${result.markdown}`)
  if (segs.length) {
    console.log(`\n开头三段：`)
    for (const s of segs.slice(0, 3)) console.log(`  [${hhmmss(s.start)}] ${s.text}`)
    console.log(`（完整内容见 Markdown 文件；要全量 JSON 加 --json）`)
  }
}

try {
  if (cmd === 'probe') {
    report(await probe(url))
  } else if (cmd === 'subs') {
    report(await subs(url, cookieFile))
  } else if (cmd === 'asr') {
    report(await transcribe(url))
  } else if (cmd === 'get') {
    let r = await subs(url, cookieFile)
    if (!r.segments.length) {
      process.stderr.write(`字幕不可用（${r.reason}），转本地识别…\n`)
      r = await transcribe(url)
    }
    const md = toMarkdown(r, r.segments)
    const dest = join(OUT, `${r.bvid ?? 'video'}.md`)
    writeFileSync(dest, md, 'utf8')
    process.stderr.write(`已写出：${dest}\n`)
    report({ ...r, markdown: dest })
  } else {
    console.error('用法：node bilisum.mjs <probe|subs|asr|get> <url> [--cookie <file>] [--json]')
    process.exitCode = 2
  }
} catch (e) {
  console.error(`错误：${e.message}`)
  process.exitCode = 1
}
