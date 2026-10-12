import { spawn as defaultSpawn } from 'node:child_process'
import { BiliDigestError } from '../errors.js'
import { compact } from '../json.js'
import { checkTools, childEnv, proxyArg, resolveYtDlp, spawnEnv } from './tools.js'

/**
 * 单路输出上限。probe 的 JSON 正常在 1 MB 以内；给到 64 MB 是为了不把内存
 * 交给对面控制（合集/番剧的巨型 JSON 是唯一接近这个量级的场景）。
 * 超限后只停止累积，不中断子进程——读到的前缀仍可进错误消息。
 */
const MAX_BUFFER = 64 * 1024 * 1024

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
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 * @throws BiliDigestError YTDLP_MISSING / YTDLP_BLOCKED / TOOL_TEMP_UNAVAILABLE / YTDLP_FAILED / CANCELLED
 */
export function runYtDlp(config, args, { signal, onStderr, spawnImpl = defaultSpawn } = {}) {
  if (signal?.aborted) return Promise.reject(cancelled())

  const exe = resolveYtDlp(config)
  if (!exe) {
    // 复用 checkTools 的文案：放置路径与配置项只在一处维护
    return Promise.reject(
      new BiliDigestError('YTDLP_MISSING', '找不到 yt-dlp.exe', checkTools(config).ytDlp),
    )
  }

  let env
  try {
    env = childEnv(config, 'bilibili')
  } catch (err) {
    // BAD_CONFIG（cacheDir 未配置等）原样上抛：这不是 yt-dlp 的失败，别误分类
    return Promise.reject(err)
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

    let out = ''
    let err = ''
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
      if (out.length < MAX_BUFFER) out += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      onStderr?.(text)
      if (err.length < MAX_BUFFER) err += text
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
        reject(classifyYtDlpFailure(err || out))
        return
      }
      resolve({ stdout: out, stderr: err, code })
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
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : [],
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
 * 412 有两个来源，都在进 JSON.parse 之前判掉：非零退出的 stderr，以及 stdout 直接是
 * HTML 错误页（风控页的 content-type 是 text/html）。这样用户拿到的是「风控」，
 * 而不是一个 "Unexpected token < in JSON" 的解析错。
 *
 * @param config 已解析配置
 * @param url 已归一化的视频地址
 * @param options.cookieFile 登录态 cookie 文件；**不给就视为匿名跑，不宣称有字幕**
 * @param options.onProgress 进度回调（返回值过 compact）
 * @param options.spawnImpl spawn 注入点（单测用）
 * @throws BiliDigestError YTDLP_BLOCKED / YTDLP_FAILED / BILI_UNSUPPORTED_CONTENT / CANCELLED
 */
export async function probe(config, url, { cookieFile, signal, onProgress, spawnImpl } = {}) {
  const proxy = childEnv(config, 'bilibili').__proxy ?? ''
  onProgress?.(compact({ phase: 'probe' }))

  const { stdout } = await runYtDlp(config, buildProbeArgs(url, cookieFile, proxy), { signal, spawnImpl })

  const body = stdout.trim()
  if (HTML_RE.test(body)) {
    if (HTTP_412_RE.test(body)) throw blockedError()
    throw new BiliDigestError(
      'YTDLP_FAILED',
      'yt-dlp 返回的是 HTML 页面而不是 JSON',
      'B 站对匿名/异常请求会回 HTML 拦截页。先确认 proxy 为空串（直连），再配置 BILI_SESSDATA 后重试。',
    )
  }

  let raw
  try {
    raw = JSON.parse(body)
  } catch (err) {
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

/**
 * 任务书（Lead 转述）把这组接口叫 `probeVideo` / `ytDlpVersion`，
 * 而规格 §5.5 与计划里后续任务的 `import` 用的是 `probe` / `version`。
 * 两个名字都导出，避免任一侧的调用方踩空。
 */
export { probe as probeVideo, version as ytDlpVersion }
