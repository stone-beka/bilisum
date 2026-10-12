import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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

const require = createRequire(import.meta.url)

/**
 * 插件依赖 `@ffmpeg-installer/win32-x64` 里那份 ffmpeg.exe 的绝对路径；依赖缺失时 undefined。
 *
 * 本机**没有任何 ffmpeg 二进制**（`E:\dsh\ffmpeg.dll` 是 Chromium 的，不是 CLI），所以这份
 * 随 npm tarball 分发、无 postinstall 下载的副本是「装完依赖即可用」的唯一保证。
 *
 * 它**刻意不参与 `resolveFfmpeg` 的两段查找**：那条链描述的是「用户可见的工具位置」
 * （`ffmpegPath` / `<cacheDir>/bin`），`checkTools` 按它报「工具未就位」；而这份副本会随
 * `node_modules` 重装消失，不能算「已就位」。它的用途只有一个：解码时在用户没指定
 * 工具位置的情况下兜底（见 `ffmpeg.js` 的 `resolveDecoderExe`）。
 */
export function resolveBundledFfmpeg() {
  try {
    // 该包没有 main 入口，只能靠 package.json 定位目录
    const pkg = require.resolve('@ffmpeg-installer/win32-x64/package.json')
    const exe = join(dirname(pkg), FFMPEG_EXE)
    return existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
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

/** 内置固定版本。追新版本走 config.ytDlpTag/ytDlpSha256（必须成对）。 */
export const YTDLP_TAG = '2026.08.19'

/** 该版本 yt-dlp.exe 的官方 SHA-256——**信任锚**，镜像无权定义它。 */
export const YTDLP_SHA256 = '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a'

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

/** 校验和文件的镜像链（顺序同二进制）。它**只用于失败诊断**，不承载信任。 */
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

/** 取一个 URL 的全部字节；非 2xx 直接抛，交给调用方换下一个镜像。
 *  `signal` 必须透传给 fetch：否则 job.cancel() 拦不住正在传输的 ~30MB 响应体。 */
async function fetchBytes(fetchImpl, url, signal) {
  const res = await fetchImpl(url, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status ?? '?'}`)
  return Buffer.from(await res.arrayBuffer())
}

const errorText = (err) => (err instanceof Error ? err.message : String(err))

/**
 * 失败路径上的**诊断**：取一次 SHA2-256SUMS，只用来区分「pin 过期」与「镜像不通」。
 *
 * 它的结果**绝不参与安装决策**。正因如此，这里可以放心走镜像链：SUMS 与二进制
 * 同样是 release 资产，恶意镜像顶多把诊断文案改坏，改不动「装什么字节」——那个
 * 判定只认 config / 源码里的信任锚（见 downloadYtDlp）。
 *
 * @returns {{ note: string, failures: string[] }} note 为空串表示没得出诊断结论
 */
async function diagnoseSums(fetchImpl, tag, expected, signal) {
  const failures = []
  for (const url of sumsUrls(tag)) {
    signal?.throwIfAborted()
    try {
      const got = parseSums((await fetchBytes(fetchImpl, url, signal)).toString('utf8')).get(YTDLP_EXE)
      if (!got) {
        failures.push(`${url}：文件里没有 ${YTDLP_EXE} 的哈希`)
        continue
      }
      return got === expected
        ? { note: `镜像上的 ${YTDLP_SUMS} 与信任锚一致（${shortHash(expected)}），失败在可达性而非内容`, failures: [] }
        : { note: `官方哈希已变更（期望 ${expected}，实际 ${got}），插件需要更新`, failures: [] }
    } catch (err) {
      signal?.throwIfAborted()
      failures.push(`${url}：${errorText(err)}`)
    }
  }
  return { note: '', failures }
}

/**
 * 从镜像链下载 yt-dlp.exe，逐个镜像与**信任锚**比对 SHA-256，第一个通过的胜出。
 *
 * 信任模型（本函数存在的理由）：
 * - **镜像只提供字节，不提供信任。** 期望摘要只从 `config.ytDlpSha256` 或源码常量
 *   `YTDLP_SHA256` 取；镜像链上的 SHA2-256SUMS **不参与安装判定**（它只在全部失败后
 *   用于文案诊断）。所以恶意镜像既换不掉判定，也换不掉被装进去的字节。
 * - **没有信任锚就不装**：取不到期望摘要直接失败，绝不降级成「未校验先装上」。
 *   每条成功路径都必然比对通过，因此成功安装一定是已认证的。
 *
 * 三条硬规则：
 * 1. **摘要不符就是这个镜像失败，换下一个**——可疑字节只留在内存里，不会写进最终路径。
 * 2. **临时文件在失败路径上一定清掉**：Windows 上 rename 会被 AV/索引器占用而抛
 *    EPERM/EACCES，不清就会在 bin 目录里留一地 .tmp-* 垃圾。
 * 3. **落盘走「临时文件 + rename」**，最终路径上只会出现已通过比对的文件。
 *
 * @param config 已解析配置（需要 config.cacheDir；可选成对的 config.ytDlpTag/ytDlpSha256）
 * @param options.fetchImpl 注入点，默认全局 fetch（全部单测离线跑）
 * @param options.onProgress 进度回调：每次尝试前 `{ phase, url }`，成功后
 *        `{ phase, url, done:true, bytes, verified:true }`，供 run.log 落盘
 * @param options.signal 取消信号；中止时抛中止原因，**不**吞成 YTDLP_DOWNLOAD_FAILED
 * @returns 落位后的绝对路径
 * @throws BiliDigestError BAD_CONFIG（cacheDir 未配置）/ YTDLP_DOWNLOAD_FAILED（无信任锚或全部镜像失败）
 */
export async function downloadYtDlp(config, { fetchImpl = fetch, onProgress, signal } = {}) {
  // 空 cacheDir 会在这里响亮失败（BAD_CONFIG），不会把二进制散到 cwd 里去。
  const binDir = cachePaths(config.cacheDir, '_').binDir
  const dest = join(binDir, YTDLP_EXE)
  mkdirSync(binDir, { recursive: true })

  signal?.throwIfAborted()

  // 信任锚：配置优先（成对提供），否则用源码内置 pin。**永不从镜像取。**
  const tag = config.ytDlpTag || YTDLP_TAG
  const expected = (config.ytDlpSha256 || YTDLP_SHA256).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    // 内置 pin 是常量、config 层已保证格式；走到这里说明调用方绕过了 resolveConfig。
    throw new BiliDigestError(
      'YTDLP_DOWNLOAD_FAILED',
      '没有可用的 yt-dlp 信任锚',
      `期望一份 64 位十六进制 SHA-256（当前：${JSON.stringify(expected)}）。` +
        '这不是网络问题：请升级插件，或用 ytDlpTag + ytDlpSha256 成对指定，' +
        `或手动放置 ${YTDLP_EXE} 并配置 ytDlpPath。`,
    )
  }

  const mirrors = YTDLP_MIRRORS(tag)
  const mirrorFailures = []

  for (const url of mirrors) {
    signal?.throwIfAborted()
    onProgress?.(compact({ phase: 'download', url }))

    let buf
    try {
      buf = await fetchBytes(fetchImpl, url, signal)
    } catch (err) {
      signal?.throwIfAborted()
      mirrorFailures.push(`${url}：${errorText(err)}`)
      continue
    }

    const got = sha256(buf)
    if (got !== expected) {
      mirrorFailures.push(`${url}：SHA-256 与信任锚不符（期望 ${shortHash(expected)}，实得 ${shortHash(got)}）`)
      continue
    }

    // 内容已通过比对。临时文件 + rename 就位。
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(tmp, buf)
      await rename(tmp, dest)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      mirrorFailures.push(`${url}：写入失败（${errorText(err)}）`)
      continue
    }

    onProgress?.(compact({ phase: 'download', url, done: true, bytes: buf.length, verified: true }))
    return dest
  }

  // 全部镜像失败。到这一步才去取 SUMS：只为诊断，不改变任何判定。
  const { note, failures: sumsFailures } = await diagnoseSums(fetchImpl, tag, expected, signal)

  const source = config.ytDlpSha256 ? 'config.ytDlpSha256' : '插件内置 YTDLP_SHA256'
  const hint = [`已尝试 ${mirrors.length} 个镜像，全部失败：`, ...mirrorFailures.map((f) => `  · ${f}`)]
  if (note) hint.push(note)
  if (sumsFailures.length > 0) {
    hint.push(`${YTDLP_SUMS} 只用于诊断、不参与判定，但这次也没取到：`, ...sumsFailures.map((f) => `  · ${f}`))
  }
  hint.push(`信任锚（${source}，tag ${tag}）：${YTDLP_EXE} SHA-256 = ${expected}`)
  hint.push(`可手动下载 ${YTDLP_EXE} 放到 ${dest}，或配置 ytDlpPath 指向已有文件`)
  throw new BiliDigestError('YTDLP_DOWNLOAD_FAILED', 'yt-dlp 下载失败', hint.join('\n'))
}
