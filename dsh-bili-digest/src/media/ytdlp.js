import { spawn as defaultSpawn } from 'node:child_process'
import { BiliDigestError } from '../errors.js'
import { compact } from '../json.js'
import { checkTools, childEnv, proxyArg, resolveYtDlp, spawnEnv } from './tools.js'

/**
 * 单路输出上限。probe 的 JSON 正常在 1 MB 以内；给到 64 MB 是为了不把内存
 * 交给对面控制（合集/番剧的巨型 JSON 是唯一接近这个量级的场景）。
 * 超限后只停止累积，不中断子进程——读到的前缀仍可进错误消息。
 * 可经 `runYtDlp` 的 `options.maxBuffer` 覆盖（单测用小值触发截断分支）。
 */
const MAX_BUFFER = 64 * 1024 * 1024

/** 截断标记：被截断的输出必须自己说明「不完整」，否则下游会把前缀当成完整输出。 */
const TRUNCATION_MARK = '\n…[yt-dlp 输出超过上限，已截断：后续内容未捕获]'

/**
 * 带上限的分片累积器。到达上限后，只在后到的第一个分片上追加一次截断标记，
 * 之后不再累积——标记让「输出不完整」在下游可见，而不是伪装成完整输出。
 * @param limit 字节上限（以字符串长度计）
 */
function cappedText(limit) {
  let text = ''
  let truncated = false
  return {
    push(chunk) {
      if (truncated) return
      if (text.length >= limit) {
        truncated = true
        text += TRUNCATION_MARK
        return
      }
      text += chunk
    },
    value() {
      return text
    },
  }
}

/** 风控的唯一指纹。规格 F27 钉的是 stderr 里的 `HTTP Error 412`；
 *  `Precondition Failed` 是同一响应的状态行文本，HTML 错误页里也带。 */
const HTTP_412_RE = /HTTP Error 412|Precondition Failed/i

/** HTML 错误页的判据：B 站风控回的是 HTML，**不是** JSON。 */
const HTML_RE = /^\s*<(?:!doctype\s+html|html|head|body)\b/i

/** 412 = 风控，不是网络故障。提示必须同时指向代理策略与登录凭据。 */
function blockedError() {
  return new BiliDigestError(
    'YTDLP_BLOCKED',
    'B 站拒绝了这次请求（HTTP 412 风控）',
    [
      '412 不是网络不通，是 B 站的出口风控。按顺序排查：',
      '1) 代理：本插件访问 B 站必须直连——把配置 proxy 设为 ""（空串），Clash 之类的系统代理会让 B 站回 412（规格 F25/F27）；',
      '2) 凭据：配置 BILI_SESSDATA（登录态能让部分风控请求放行）；',
      '3) 都排除了就等几分钟再试：这个出口 IP 已被临时限流。',
    ].join('\n'),
  )
}

const cancelled = () => new BiliDigestError('CANCELLED', '已取消')

/**
 * 把 yt-dlp 的失败归到具体错误码，便于用户自助。
 * 这三类都是实测踩过的（规格 §17.2）：412 风控、PyInstaller 建不了临时目录、其余。
 * @param stderr 子进程的 stderr（非零退出时也接受 stdout）
 * @returns BiliDigestError
 */
export function classifyYtDlpFailure(stderr) {
  const text = String(stderr ?? '')
  if (HTTP_412_RE.test(text)) return blockedError()
  if (/Could not create temporary directory/.test(text)) {
    return new BiliDigestError(
      'TOOL_TEMP_UNAVAILABLE',
      'yt-dlp 无法创建临时目录',
      '把 cacheDir 指到一个可写目录（子进程的 TEMP/TMP/TMPDIR 都指向 <cacheDir>/tmp），然后重试。',
    )
  }
  // 只留末尾几行：yt-dlp 的报错正文在最后，前面是几十行进度噪声
  const tail = text.split(/\r?\n/).slice(-8).join('\n').trim()
  return tail
    ? new BiliDigestError('YTDLP_FAILED', 'yt-dlp 执行失败', `yt-dlp 输出（末尾）：\n${tail}`)
    : new BiliDigestError(
        'YTDLP_FAILED',
        'yt-dlp 异常退出，且没有任何输出',
        '多半是进程被系统/杀软直接杀掉了：检查杀毒软件与 <cacheDir>/bin 的权限后重试。',
      )
}

/**
 * exe 缺失时的统一错误：文案复用 checkTools，放置路径与配置项只在一处维护。
 * `runYtDlp` 与 `probe` 都用它，保证「找不到 yt-dlp」在两条入口上是同一个码。
 */
function missingYtDlpError(config) {
  return new BiliDigestError('YTDLP_MISSING', '找不到 yt-dlp.exe', checkTools(config).ytDlp)
}

/**
 * 跑一次 yt-dlp。参数一律走数组、不经 shell。
 *
 * 环境**只能**来自 `childEnv`：它显式设 TEMP/TMP/TMPDIR（PyInstaller 起不来的根因）
 * 并按目标选定代理。`__proxy` 是策略载具、不是环境变量，交给 spawn 前必须过 `spawnEnv`。
 *
 * @param config 已解析配置（`resolveConfig()` 的结果）
 * @param args yt-dlp 参数数组
 * @param options.signal 取消信号；中止时 kill 子进程并抛 CANCELLED
 * @param options.onStderr stderr 分片回调（诊断用）
 * @param options.spawnImpl spawn 注入点，默认 `node:child_process` 的 spawn（全部单测离线跑）
 * @param options.env 已由 `childEnv()` 造好的环境（`probe` 用它，避免同一次调用里重复构造 +
 *        `mkdirSync`）；省略时本函数自己调 `childEnv(config, 'bilibili')`
 * @param options.maxBuffer 单路输出上限，默认 `MAX_BUFFER`（单测用小值触发截断分支）
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 * @throws BiliDigestError YTDLP_MISSING / BAD_CONFIG / YTDLP_BLOCKED / TOOL_TEMP_UNAVAILABLE / YTDLP_FAILED / CANCELLED
 */
export function runYtDlp(
  config,
  args,
  { signal, onStderr, spawnImpl = defaultSpawn, env: prebuiltEnv, maxBuffer } = {},
) {
  if (signal?.aborted) return Promise.reject(cancelled())

  const exe = resolveYtDlp(config)
  if (!exe) return Promise.reject(missingYtDlpError(config))

  let env = prebuiltEnv
  if (!env) {
    try {
      env = childEnv(config, 'bilibili')
    } catch (err) {
      // BAD_CONFIG（cacheDir 未配置等）原样上抛：这不是 yt-dlp 的失败，别误分类
      return Promise.reject(err)
    }
  }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(exe, args, {
        env: spawnEnv(env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(new BiliDigestError('YTDLP_FAILED', `无法启动 yt-dlp：${err.message}`, undefined, err))
      return
    }

    const out = cappedText(maxBuffer ?? MAX_BUFFER)
    const err = cappedText(maxBuffer ?? MAX_BUFFER)
    const onAbort = () => {
      try {
        child.kill()
      } catch {
        // 进程可能已经退出；kill 失败不该盖住原本的失败原因
      }
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => {
      out.push(chunk.toString())
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      onStderr?.(text)
      err.push(text)
    })

    child.on('error', (e) => {
      cleanup()
      reject(new BiliDigestError('YTDLP_FAILED', `无法启动 yt-dlp：${e.message}`, undefined, e))
    })
    child.on('close', (code) => {
      cleanup()
      if (signal?.aborted) {
        reject(cancelled())
        return
      }
      if (code !== 0) {
        reject(classifyYtDlpFailure(err.value() || out.value()))
        return
      }
      resolve({ stdout: out.value(), stderr: err.value(), code })
    })
  })
}

/**
 * 构造 probe 的参数。`proxyPolicy` 是策略值（`''` / `'direct'` / `'system'` / URL），
 * 由 `proxyArg` 翻译——直接拼 `--proxy=${policy}` 会产出非法的 `--proxy=system`。
 * @param url 已归一化的视频地址
 * @param cookieFile Netscape 格式 cookie 文件（有登录态时字幕才可见），可省略
 * @param proxyPolicy 代理策略值，默认直连
 */
export function buildProbeArgs(url, cookieFile, proxyPolicy = '') {
  const args = [
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    ...proxyArg(proxyPolicy),
  ]
  if (cookieFile) args.push('--cookies', cookieFile)
  args.push(url)
  return args
}

/** 字符串字段归一：null/undefined → ''，其余 String 后 trim。 */
const text = (value) => (value == null ? '' : String(value).trim())

/**
 * 字符串数组归一：**只留真正的字符串**，经 `text()` trim 掉空串。
 * 直接 `map(String)` 会把 null 变成 `'null'`、对象变成 `'[object Object]'`——那是伪数据。
 */
const stringList = (value) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map(text).filter((item) => item !== '')
    : []

/** 数值字段归一：非有限数（缺字段、null、'abc'、NaN）一律降级成 fallback。
 *  不能让 NaN 漏出去——它不是合法 JSON，会在宿主那层被当成"value is not lossless JSON"拒收。 */
const finiteOr = (value, fallback) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

/**
 * 把 yt-dlp 的 info dict 归约成我们需要的形状。纯函数，可离线测。
 *
 * 容错原则：**可选字段一律降级成空值，不抛异常**——管线宁可少信息也不能炸。
 * 唯一的例外是 `id`：它是这个视频的标识，缺了后面每一步都无处落地。
 *
 * `subtitles` 只做忠实映射（语言键列表）；「匿名跑不算有字幕」的判定在 `probe` 里，
 * 因为那取决于这次跑有没有带 cookie。
 *
 * @param raw yt-dlp 的 info dict
 * @throws BiliDigestError YTDLP_FAILED（缺 id）
 */
export function reduceProbe(raw) {
  const id = text(raw?.id)
  if (id === '') {
    throw new BiliDigestError(
      'YTDLP_FAILED',
      'yt-dlp 的输出里没有 id',
      'id 是视频标识，缺了无法继续：多半是返回了错误页或 yt-dlp 版本过旧，更新后重试。',
    )
  }
  const title = text(raw?.title)
  // 章节标题缺失时保留空串而不是编一个名字：下游能区分「没有标题」和「标题叫这个」
  const chapters = Array.isArray(raw?.chapters)
    ? raw.chapters
        .map((c) => ({
          start: Number(c?.start_time ?? 0),
          end: Number(c?.end_time ?? 0),
          title: text(c?.title),
        }))
        .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    : []
  const subtitles =
    raw?.subtitles && typeof raw.subtitles === 'object' && !Array.isArray(raw.subtitles)
      ? Object.keys(raw.subtitles)
      : []

  return compact({
    id,
    title: title || id,
    duration: finiteOr(raw?.duration, 0),
    uploader: text(raw?.uploader),
    webpageUrl: text(raw?.webpage_url),
    description: text(raw?.description),
    tags: stringList(raw?.tags),
    chapters,
    subtitles,
    isPlaylist: false,
    playlistCount: 1,
  })
}

/**
 * 取一次元信息 / 章节 / 字幕清单。
 *
 * 代理策略取自 `childEnv(config, 'bilibili').__proxy`——它是**策略值**不是 URL。
 * 这份 env 同时透传给 `runYtDlp`，同一次 probe 不重复构造环境（含 `mkdirSync`）。
 *
 * 顺序是可观测的契约：**先判可执行文件**（exe 缺失时直接 `YTDLP_MISSING`，否则这个码
 * 会被迟到的检查掩盖、永远发不出来），再构造 env（cacheDir 空则 `BAD_CONFIG`），最后起进程。
 *
 * 412 有两个来源：① 非零退出的 stderr / stdout（`runYtDlp` 的 `classifyYtDlpFailure`）；
 * ② stdout 本身不是 JSON、且带 412 指纹。②**与响应体是不是 HTML 形状无关**——风控页可能
 * 以注释、`<script>`、BOM 残留起头，只按 `HTML_RE` 分流会把风控误报成 "不是合法 JSON"。
 * 但②**只在 `JSON.parse` 失败之后**才跑：解析成功说明这就是 info dict，正文里的
 * "Precondition Failed" 字样（教程类视频的标题/简介）不得被当成风控指纹。
 *
 * @param config 已解析配置
 * @param url 已归一化的视频地址
 * @param options.cookieFile 登录态 cookie 文件；**不给就视为匿名跑，不宣称有字幕**
 * @param options.onProgress 进度回调（返回值过 compact）
 * @param options.spawnImpl spawn 注入点（单测用）
 * @throws BiliDigestError YTDLP_MISSING（找不到 yt-dlp.exe）/ BAD_CONFIG（cacheDir 未配置等）/
 *         YTDLP_BLOCKED（412 风控）/ TOOL_TEMP_UNAVAILABLE（PyInstaller 建不了临时目录）/
 *         YTDLP_FAILED（其余失败、HTML 拦截页、非法 JSON、缺 id）/ BILI_UNSUPPORTED_CONTENT（合集/番剧）/ CANCELLED
 */
export async function probe(config, url, { cookieFile, signal, onProgress, spawnImpl } = {}) {
  if (!resolveYtDlp(config)) throw missingYtDlpError(config)

  const env = childEnv(config, 'bilibili')
  const proxy = env.__proxy ?? ''
  onProgress?.(compact({ phase: 'probe' }))

  const { stdout } = await runYtDlp(config, buildProbeArgs(url, cookieFile, proxy), {
    signal,
    spawnImpl,
    env,
  })

  const body = stdout.trim()
  let raw
  try {
    raw = JSON.parse(body)
  } catch (err) {
    // 只有在"根本不是 JSON"的时候才去辨认风控/网关错误页。
    // 反过来做会让**成功的** JSON 正文里恰好出现的 "Precondition Failed"
    // 之类字样把一次正常的 probe 误判成风控拦截。
    if (HTTP_412_RE.test(body)) throw blockedError()
    if (HTML_RE.test(body)) {
      throw new BiliDigestError(
        'YTDLP_FAILED',
        'yt-dlp 返回的是 HTML 页面而不是 JSON',
        'B 站对匿名/异常请求会回 HTML 拦截页。先确认 proxy 为空串（直连），再配置 BILI_SESSDATA 后重试。',
      )
    }
    throw new BiliDigestError(
      'YTDLP_FAILED',
      'yt-dlp 返回的不是合法 JSON',
      `输出开头：${body.slice(0, 300)}`,
      err,
    )
  }

  if (Array.isArray(raw?.entries) || raw?._type === 'playlist') {
    throw new BiliDigestError(
      'BILI_UNSUPPORTED_CONTENT',
      '这是一个合集/番剧，P0 不支持',
      '请给出单个视频的链接。',
    )
  }

  const info = reduceProbe(raw)
  // 实测：匿名跑 10 个分区 40 个视频，yt-dlp 的 subtitles 恒为空；yt-dlp 源码亦注明
  // "Subtitles are only available when logged in"。所以匿名时**不宣称**有字幕。
  if (!cookieFile) info.subtitles = []
  return compact(info)
}

/**
 * yt-dlp 版本号，用于诊断与 --update-tools。
 * @returns 形如 '2026.08.19' 的版本串
 */
export async function version(config, { signal, spawnImpl } = {}) {
  const { stdout } = await runYtDlp(config, ['--version'], { signal, spawnImpl })
  return stdout.trim()
}
