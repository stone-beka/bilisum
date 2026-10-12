import { existsSync, mkdirSync } from 'node:fs'
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
