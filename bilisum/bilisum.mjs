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
 * B 站匿名请求**实测间歇性失败**：同一个命令连跑 3 次是「成功 / 失败 / 成功」。
 * 所以重试不是"锦上添花"，是这个站点上的必需品。带 cookie 后失败率会显著下降。
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

async function subs(url, cookieFile) {
  const info = await probe(url)
  if (!cookieFile || !existsSync(cookieFile)) {
    return { ...info, mode: 'subs', segments: [], reason: '未提供 cookie 文件——匿名状态 B 站字幕命中率实测 0/40' }
  }
  const wanted = ['zh-Hans', 'zh-CN', 'zh', 'ai-zh']
  const avail = [...info.subs, ...info.autoSubs]
  if (avail.length === 0) {
    return { ...info, mode: 'subs', segments: [], reason: '该视频没有可用字幕（登录后仍无）' }
  }
  const pick = wanted.find((w) => avail.includes(w)) ?? avail[0]
  const tmp = join(CACHE, `sub-${info.bvid ?? 'x'}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const r = await run(YTDLP, [
    '--proxy=', '--skip-download', '--no-playlist', '--no-warnings',
    '--cookies', cookieFile,
    '--sub-langs', pick, '--sub-format', 'srt', '--convert-subs', 'srt',
    '--write-subs', '--write-auto-subs',
    '-o', join(tmp, 'sub'), info.url,
  ])
  if (r.code !== 0) throw new Error(`下载字幕失败：\n${(r.stderr || '').split(/\r?\n/).slice(-6).join('\n')}`)
  const files = []
  for (const f of (await import('node:fs')).readdirSync(tmp)) if (f.endsWith('.srt')) files.push(f)
  if (files.length === 0) return { ...info, mode: 'subs', segments: [], reason: 'yt-dlp 未产出字幕文件' }
  const raw = readFileSync(join(tmp, files[0]), 'utf8')
  return { ...info, mode: 'subs', lang: pick, segments: parseSrt(raw) }
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
const cookieFile = ci >= 0 ? rest[ci + 1] : null

try {
  if (cmd === 'probe') {
    console.log(JSON.stringify(await probe(url), null, 2))
  } else if (cmd === 'subs') {
    console.log(JSON.stringify(await subs(url, cookieFile), null, 2))
  } else if (cmd === 'asr') {
    console.log(JSON.stringify(await transcribe(url), null, 2))
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
    console.log(JSON.stringify({ ...r, markdown: dest, chars: r.segments.reduce((n, s) => n + s.text.length, 0) }, null, 2))
  } else {
    console.error('用法：node bilisum.mjs <probe|subs|asr|get> <url> [--cookie <file>]')
    process.exit(2)
  }
} catch (e) {
  console.error(`错误：${e.message}`)
  process.exit(1)
}
