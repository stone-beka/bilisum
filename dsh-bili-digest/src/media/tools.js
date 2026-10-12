import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cachePaths } from '../cache.js'
import { BiliDigestError } from '../errors.js'
import { compact } from '../json.js'

/** 平台目标 Windows x64，可执行文件名是固定的。 */
const YTDLP_EXE = 'yt-dlp.exe'
const FFMPEG_EXE = 'ffmpeg.exe'

/**
 * target → 取哪条代理配置。
 *
 * 两个目标的策略是**相反**的（见 childEnv 的注释），所以这里必须是显式映射：
 * 打错 target 时宁可响亮失败，也不能悄悄套用另一个目标的策略。
 */
const PROXY_CONFIG_KEY = { bilibili: 'proxy', 'tool-download': 'toolDownloadProxy' }

/** `<cacheDir>/bin` 的绝对路径；cacheDir 未配置时返回 undefined。 */
function binDir(config) {
  // 借用 cachePaths 是为了它的绝对路径保证与空值守门；binDir 与 bvid 无关，占位符随意。
  return config.cacheDir ? cachePaths(config.cacheDir, '_').binDir : undefined
}

/**
 * 「显式配置 → <cacheDir>/bin/<name>」两段查找。
 * 只报告存在性，不校验它是不是能跑的可执行文件——那是调用方的事。
 */
function resolveExe(config, explicitPath, name) {
  if (explicitPath && existsSync(explicitPath)) return explicitPath
  const bin = binDir(config)
  if (!bin) return undefined
  const local = join(bin, name)
  return existsSync(local) ? local : undefined
}

/**
 * 找出 yt-dlp.exe 的绝对路径。
 * 顺序：显式配置 → `<cacheDir>/bin/yt-dlp.exe` → undefined
 * @returns 路径或 undefined（未找到）
 */
export function resolveYtDlp(config) {
  return resolveExe(config, config.ytDlpPath, YTDLP_EXE)
}

/** 找出 ffmpeg.exe 的绝对路径。顺序：显式配置 → `<cacheDir>/bin/ffmpeg.exe` → undefined。 */
export function resolveFfmpeg(config) {
  return resolveExe(config, config.ffmpegPath, FFMPEG_EXE)
}

/**
 * 返回缺失工具的问题描述；**无问题则不含该键**（键存在即有问题）。
 * @returns {{ ytDlp?: string, ffmpeg?: string }}
 */
export function checkTools(config) {
  const bin = binDir(config) ?? join('<cacheDir>', 'bin')
  const problems = {}
  if (!resolveYtDlp(config)) {
    problems.ytDlp = `找不到 yt-dlp.exe。放置到 ${join(bin, YTDLP_EXE)}，或配置 ytDlpPath，或用 --update-tools 自动下载。`
  }
  if (!resolveFfmpeg(config)) {
    problems.ffmpeg = `找不到 ffmpeg.exe。放置到 ${join(bin, FFMPEG_EXE)}，或配置 ffmpegPath。`
  }
  return compact(problems)
}

/**
 * 确保并返回子进程共用的临时目录（绝对路径）。
 * 与 childEnv 的 TEMP 指向同一目录；childEnv 自己也会建，故这里刻意保持廉价。
 * @returns 临时目录绝对路径
 */
export async function ensureTmpDir(config) {
  const dir = cachePaths(config.cacheDir, '_').tmpDir
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 构造子进程环境。**这是唯一允许构造子进程 env 的地方。**
 *
 * 两条都是实测踩出来的（规格 F25/F26）：
 * 1. 必须显式设 TEMP/TMP/TMPDIR，否则 PyInstaller 打包的 yt-dlp.exe 报
 *    "Could not create temporary directory!" 直接起不来。
 * 2. 代理必须显式化，不能继承。本机系统代理 127.0.0.1:7890 的出口 IP 被 B 站 412，
 *    而 GitHub release 资产直连不通、必须走代理——两侧要求正好相反。
 *
 * 直连分支为什么既清代理变量、又要 `NO_PROXY=*`：Python 的 `getproxies()` 除了读
 * 环境变量还会读 Windows 注册表（WinINET），只清环境变量挡不住系统代理。
 * 反过来 `system` 分支必须 `delete` 掉 `NO_PROXY`，否则我们自己或父进程留下的
 * `NO_PROXY` 会把系统代理一起挡掉。
 *
 * @param config 已解析配置（`resolveConfig()` 的结果）
 * @param target 'bilibili'（访问 B 站，需直连） | 'tool-download'（下载工具，需跟随系统）
 * @returns 可直接传给 spawn 的 env；额外带 `__proxy` 字段供调用方拼 --proxy 参数
 *          （**该字段不是环境变量**，交给 spawn 前必须过 `spawnEnv()`）
 * @throws BiliDigestError BAD_CONFIG：target 未知、cacheDir 未配置、或配置未解析（缺代理项）
 */
export function childEnv(config, target) {
  const proxyKey = PROXY_CONFIG_KEY[target]
  if (!proxyKey) {
    throw new BiliDigestError(
      'BAD_CONFIG',
      `未知的子进程环境目标：${target}`,
      "childEnv 只接受 'bilibili' 或 'tool-download'",
    )
  }
  const proxy = config[proxyKey]
  if (typeof proxy !== 'string') {
    throw new BiliDigestError(
      'BAD_CONFIG',
      `配置项 ${proxyKey} 必须是字符串`,
      'childEnv 需要 resolveConfig() 解析过的配置；代理取值为 空串=直连 / system=跟随系统 / 其它=代理 URL',
    )
  }

  // 走 cachePaths 而不是 join(cacheDir, 'tmp')：它保证绝对路径并挡住空 cacheDir。
  // 相对 TEMP 会跟着子进程 cwd 漂移——正是 PyInstaller 起不来的成因之一。
  const tmp = cachePaths(config.cacheDir, '_').tmpDir
  mkdirSync(tmp, { recursive: true })

  const env = {
    ...process.env,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
  }
  env.__proxy = proxy

  if (proxy === '' || proxy === 'direct') {
    // 强制直连：把大小写四种写法都清成空串（Python 对同名大写空值有特殊处理），
    // 再用 NO_PROXY=* 兜底挡住 WinINET 里的系统代理
    env.HTTP_PROXY = ''
    env.HTTPS_PROXY = ''
    env.http_proxy = ''
    env.https_proxy = ''
    env.NO_PROXY = '*'
    env.no_proxy = '*'
  } else if (proxy === 'system') {
    // 跟随系统：删掉可能从父进程继承来的 NO_PROXY，让 Python 去读 WinINET
    delete env.NO_PROXY
    delete env.no_proxy
  } else {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
    delete env.NO_PROXY
    delete env.no_proxy
  }

  return compact(env)
}

/**
 * 把 childEnv 的结果拆成 spawn 用的 env（去掉 __proxy 载具）。
 * 入参必为 childEnv 的输出：它已过 compact，`__proxy` 又是字符串，
 * 故结果不可能含 undefined 值的键。
 * @param env childEnv 的返回值
 */
export function spawnEnv(env) {
  const { __proxy, ...rest } = env
  return compact(rest)
}

/**
 * 把代理策略翻译成 yt-dlp 的 `--proxy` 参数。
 *
 * 策略值不是 URL：`''`/`'direct'`=强制直连，`'system'`=跟随系统。
 * 直接拼进 `--proxy=` 会产生非法的 `--proxy=system`。
 *
 * @returns 要展开进参数数组的片段：
 *   直连 → `['--proxy=']`（空值即让 yt-dlp 不走代理）
 *   跟随系统 → `[]`（**不传这个参数**，yt-dlp 才会去读系统代理）
 *   显式代理 → `['--proxy=<url>']`
 */
export function proxyArg(policy) {
  if (policy === undefined || policy === null || policy === '' || policy === 'direct') return ['--proxy=']
  if (policy === 'system') return []
  return [`--proxy=${policy}`]
}

// ---------- yt-dlp 下载：镜像链 + SHA-256 校验 ----------

/** 下载的 yt-dlp 版本。镜像链与 SHA2-256SUMS 必须是同一份 release。 */
const YTDLP_TAG = '2026.08.19'

/** 官方校验和文件名。 */
const YTDLP_SUMS = 'SHA2-256SUMS'

/**
 * yt-dlp.exe 的下载镜像链。
 *
 * 实测（规格 F28）：本机 github.com 的 **release 资产**直连不通（status 000），
 * 而 ghproxy.net / gh-proxy.com 都通。官方直连仍放最后——它在别的网络下可用，
 * 且是唯一不经第三方转发的源。
 *
 * @param tag release tag，默认 YTDLP_TAG
 * @returns 有序 URL 列表，**最后一个必须是官方 GitHub**
 */
export function YTDLP_MIRRORS(tag = YTDLP_TAG) {
  const release = `github.com/yt-dlp/yt-dlp/releases/download/${tag}`
  return [
    `https://ghproxy.net/https://${release}/${YTDLP_EXE}`,
    `https://gh-proxy.com/https://${release}/${YTDLP_EXE}`,
    `https://${release}/${YTDLP_EXE}`,
  ]
}

/** 校验和文件同样走镜像链（它也是 release 资产），顺序与二进制一致。 */
function sumsUrls(tag = YTDLP_TAG) {
  return YTDLP_MIRRORS(tag).map((url) => url.replace(/\/yt-dlp\.exe$/, `/${YTDLP_SUMS}`))
}

/**
 * 解析 SHA2-256SUMS：每行 `<hash>  <filename>`，`*` 前缀表示二进制模式。
 *
 * 刻意不把哈希长度钉成 64：官方文件里混着其它算法/文件的行，而调用方只关心
 * 「文件名 → 十六进制串」。同名字段后者覆盖前者。
 *
 * @param text 文件全文
 * @returns Map<文件名, 小写十六进制哈希>
 */
export function parseSums(text) {
  const out = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]+)\s+\*?(.+?)\s*$/.exec(line.trim())
    if (m) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

/** 二进制 → 小写十六进制 SHA-256。 */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 完整哈希太长，错误消息里只取足以区分的前缀。 */
const shortHash = (hex) => `${hex.slice(0, 12)}…`

/** 主机名；非法 URL 原样返回，免得错误消息里只剩一个空串。 */
function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 取一个 URL 的全部字节；非 2xx 直接抛，交给调用方换下一个镜像。 */
async function fetchBytes(fetchImpl, url) {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`HTTP ${res.status ?? '?'}`)
  return Buffer.from(await res.arrayBuffer())
}

const errorText = (err) => (err instanceof Error ? err.message : String(err))

/**
 * 从镜像链下载 yt-dlp.exe，逐个镜像校验 SHA-256，第一个通过的胜出。
 *
 * 三条硬规则：
 * 1. **校验不通过就是这个镜像失败，换下一个**——绝不把可疑二进制写进最终路径。
 *    校验在内存里做完，落盘走「临时文件 + rename」，所以最终路径上只会出现
 *    已校验的文件（或明确标记为未校验的，见第 3 条）。
 * 2. **临时文件在失败路径上一定清掉**：Windows 上 rename 会被 AV/索引器占用而抛
 *    EPERM/EACCES，不清就会在 bin 目录里留一地 .tmp-* 垃圾。
 * 3. **拿不到 SHA2-256SUMS 不致命**：能下到镜像却取不到校验和，不该把用户卡死；
 *    但必须自曝其短——成功事件带 `verified:false` 与原因，不能假装校验过了。
 *
 * @param config 已解析配置（需要 config.cacheDir）
 * @param options.fetchImpl 注入点，默认全局 fetch（全部单测离线跑）
 * @param options.onProgress 进度回调：每次尝试前 `{ phase, url }`，成功后
 *        `{ phase, url, done:true, bytes, verified }`，供 run.log 落盘
 * @param options.signal 取消信号；中止时抛中止原因，**不**吞成 YTDLP_DOWNLOAD_FAILED
 * @returns 落位后的绝对路径
 * @throws BiliDigestError BAD_CONFIG（cacheDir 未配置）/ YTDLP_DOWNLOAD_FAILED（全部镜像失败）
 */
export async function downloadYtDlp(config, { fetchImpl = fetch, onProgress, signal } = {}) {
  // 空 cacheDir 会在这里响亮失败（BAD_CONFIG），不会把二进制散到 cwd 里去。
  const binDir = cachePaths(config.cacheDir, '_').binDir
  const dest = join(binDir, YTDLP_EXE)
  mkdirSync(binDir, { recursive: true })

  const mirrorFailures = []
  const sumsFailures = []

  signal?.throwIfAborted()

  // 先取校验和：取不到只记录，不中断下载。
  let expected
  for (const url of sumsUrls()) {
    signal?.throwIfAborted()
    try {
      expected = parseSums((await fetchBytes(fetchImpl, url)).toString('utf8')).get(YTDLP_EXE)
      if (expected) break
      sumsFailures.push(`${url}：文件里没有 ${YTDLP_EXE} 的哈希`)
    } catch (err) {
      signal?.throwIfAborted()
      sumsFailures.push(`${url}：${errorText(err)}`)
    }
  }

  const mirrors = YTDLP_MIRRORS()
  for (const url of mirrors) {
    signal?.throwIfAborted()
    onProgress?.({ phase: 'download', url })

    let buf
    try {
      buf = await fetchBytes(fetchImpl, url)
    } catch (err) {
      signal?.throwIfAborted()
      mirrorFailures.push(`${url}：${errorText(err)}`)
      continue
    }

    if (expected) {
      const got = sha256(buf)
      if (got !== expected) {
        mirrorFailures.push(`${url}：SHA-256 不符（期望 ${shortHash(expected)}，实得 ${shortHash(got)}）`)
        continue
      }
    }

    // 到这里内容已通过校验（或确实没有校验源）。临时文件 + rename 就位。
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(tmp, buf)
      await rename(tmp, dest)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      mirrorFailures.push(`${url}：写入失败（${errorText(err)}）`)
      continue
    }

    const done = { phase: 'download', url, done: true, bytes: buf.length, verified: Boolean(expected) }
    if (!expected) done.note = `未取得 ${YTDLP_SUMS}，本次下载未经校验`
    onProgress?.(done)
    return dest
  }

  const hint = [`已尝试 ${mirrors.length} 个镜像，全部失败：`, ...mirrorFailures.map((f) => `  · ${f}`)]
  if (sumsFailures.length > 0) {
    hint.push(`${YTDLP_SUMS} 也没取到（因而本次无法校验任何镜像）：`, ...sumsFailures.map((f) => `  · ${f}`))
  }
  hint.push(`可手动下载 ${YTDLP_EXE} 放到 ${dest}`)
  throw new BiliDigestError(
    'YTDLP_DOWNLOAD_FAILED',
    'yt-dlp 下载失败',
    hint.join('\n'),
  )
}
