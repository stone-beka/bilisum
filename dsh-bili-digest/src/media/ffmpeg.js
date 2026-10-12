import { spawn as defaultSpawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { cachePaths } from '../cache.js'
import { BiliDigestError } from '../errors.js'
import { compact } from '../json.js'
import { childEnv, resolveBundledFfmpeg, resolveFfmpeg, spawnEnv } from './tools.js'

/** 平台目标 Windows x64。 */
const FFMPEG_EXE = 'ffmpeg.exe'

/** 输出规格：`ctx.speechToText`（SenseVoice int8）只收这一种，且逐字节校验。 */
const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16

/** stderr 累积上限。诊断只需要最后几行，别让 ffmpeg 的噪声把内存吃掉。 */
const MAX_STDERR = 64 * 1024

const cancelled = () => new BiliDigestError('CANCELLED', '已取消')

/**
 * 把内置依赖里的 ffmpeg.exe 复制到 `<cacheDir>/bin`。
 *
 * 为什么要有这一步（而不是直接跑 node_modules 里那份）：
 * 1. `checkTools` / `resolveFfmpeg` 的「工具就位」判定看的就是 `<cacheDir>/bin`，
 *    profile 里 `link:` 安装的插件目录随时可能被重装清空；
 * 2. 本机没有系统 ffmpeg，这份副本是唯一可用的 CLI（`E:\dsh\ffmpeg.dll` 是 Chromium 的）。
 *
 * 幂等：目标已存在就直接返回。**落盘走「临时文件 + rename」**，避免半截的 61.5 MB
 * 文件被后续复用（Windows 上另一个进程可能正打开它）。
 *
 * @param config 已解析配置（`resolveConfig()` 的结果）
 * @returns `<cacheDir>/bin/ffmpeg.exe` 的绝对路径
 * @throws BiliDigestError BAD_CONFIG（cacheDir 未配置）/ FFMPEG_MISSING（依赖里没有二进制，或复制失败）
 */
export async function installFfmpeg(config) {
  const binDir = cachePaths(config.cacheDir, '_').binDir
  mkdirSync(binDir, { recursive: true })
  const dest = join(binDir, FFMPEG_EXE)
  if (existsSync(dest)) return dest

  const src = resolveBundledFfmpeg()
  if (!src) {
    throw new BiliDigestError(
      'FFMPEG_MISSING',
      '插件依赖里没有 ffmpeg.exe',
      `期望 ${join('<node_modules>', '@ffmpeg-installer', 'win32-x64', FFMPEG_EXE)}。` +
        '在插件目录里跑 `pnpm install` 补上依赖，或配置 ffmpegPath 指向已有的 ffmpeg.exe。',
    )
  }

  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`
  try {
    copyFileSync(src, tmp)
    renameSync(tmp, dest)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw new BiliDigestError(
      'FFMPEG_MISSING',
      '复制 ffmpeg.exe 失败',
      `把 ${src} 复制到 ${dest} 时出错：${err.message}。检查杀软/权限，或手动复制后重试。`,
      err,
    )
  }
  return dest
}

/**
 * 解码用的 exe 解析。
 *
 * 顺序：`<cacheDir>/bin/ffmpeg.exe`（含显式 `ffmpegPath`，即 `resolveFfmpeg`）→ 内置依赖副本。
 * **内置副本只在用户没有显式配置 `ffmpegPath` 时启用**：用户指了位置就该尊重那个位置，
 * 指错时报 `FFMPEG_MISSING` 而不是悄悄换一份二进制跑（症状会晚很久才暴露）。
 *
 * `resolveFfmpeg` 自身保持 Task 6 的两段查找语义不变——`checkTools` 依赖它报「工具未就位」。
 */
function resolveDecoderExe(config) {
  const exe = resolveFfmpeg(config)
  if (exe) return exe
  return config.ffmpegPath ? undefined : resolveBundledFfmpeg()
}

/** ffmpeg 缺失的统一错误。hint 必须同时给出两条补救路径：ffmpegPath 配置、插件自己的 binDir。 */
function missingFfmpegError(config) {
  const bin = config.cacheDir ? cachePaths(config.cacheDir, '_').binDir : join('<cacheDir>', 'bin')
  const current = config.ffmpegPath ? `（当前配置：${config.ffmpegPath}，文件不存在）` : '（未配置）'
  return new BiliDigestError(
    'FFMPEG_MISSING',
    '找不到 ffmpeg.exe',
    [
      `1) 配置 ffmpegPath 指向已有的 ffmpeg.exe${current}；`,
      `2) 或把 ffmpeg.exe 放到 ${join(bin, FFMPEG_EXE)}——调用 installFfmpeg() 会把插件依赖`,
      '   @ffmpeg-installer/win32-x64 里的副本复制过去。',
    ].join('\n'),
  )
}

/** 带上限的 stderr 累积器：满了就停止累积（末尾几行足够诊断，不必留全量噪声）。 */
function cappedStderr() {
  let text = ''
  return {
    push(chunk) {
      if (text.length < MAX_STDERR) text += chunk
    },
    value() {
      return text
    },
  }
}

/**
 * 构造解码参数。**唯一允许拼 ffmpeg 参数的地方。**
 *
 * 三条都是实测/规格逼出来的：
 * - `-nostdin` 必须给：不给的话 ffmpeg 会去读父进程的 stdin，在宿主里表现为整次调用挂住；
 * - `-ar 16000 -ac 1 -c:a pcm_s16le` 必须显式给：不写就按输入原样输出（常见 44.1kHz 立体声），
 *   而 `ctx.speechToText` 只收 16 kHz 单声道 PCM16，且逐字节校验；
 * - 输出走 `pipe:1` 且**不给 `-y`/`-n`**：`-y`/`-n` 只在写文件时才有意义，这里一个文件都不写。
 *
 * 注意产出的是**裸 PCM**（无 WAV 头）：ffmpeg 的 WAV 会插 LIST/fact chunk，不是规范头，
 * 所以规范 WAV 头由 `audio/window.js` 自己拼（规格 F7）。
 * @param inputPath 输入文件（yt-dlp 下载的 audio.m4s）
 */
function buildDecodeArgs(inputPath) {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    String(CHANNELS),
    '-ar',
    String(SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    'pipe:1',
  ]
}

/**
 * 解码成 ASR 要的裸 PCM。**这是唯一的解码点**：其它模块不得直接依赖 ffmpeg，
 * 换解码方案只改这里（规格 F12）。
 *
 * PCM 从 stdout 逐字节捕获、不落临时文件——所以没有「半截文件」需要清理，也就不需要
 * 临时文件 + rename。代价是整段音频驻留内存（16 kHz 单声道 ≈ 32 KB/s，4 小时 ≈ 460 MB，
 * 见规格 maxDurationSec 上限）；P0 接受这个量级，不额外引入磁盘往返。
 *
 * @param config 已解析配置（`resolveConfig()` 的结果）
 * @param inputPath 输入文件绝对路径
 * @param options.signal 取消信号；中止时 kill 子进程并抛 CANCELLED
 * @param options.spawnImpl spawn 注入点，默认 `node:child_process` 的 spawn（全部单测离线跑）
 * @returns `{ pcm, sampleRate, channels, bitsPerSample }`——pcm 是裸 PCM（无 WAV 头）
 * @throws BiliDigestError FFMPEG_MISSING / BAD_CONFIG（cacheDir 未配置等）/
 *         AUDIO_DECODE_FAILED（起不来或非零退出）/ CANCELLED
 */
export function decodeToPcm(config, inputPath, { signal, spawnImpl = defaultSpawn } = {}) {
  if (signal?.aborted) return Promise.reject(cancelled())

  const exe = resolveDecoderExe(config)
  if (!exe) return Promise.reject(missingFfmpegError(config))

  let env
  try {
    env = childEnv(config, 'bilibili')
  } catch (err) {
    // BAD_CONFIG（cacheDir 未配置等）原样上抛：这不是解码失败，别误分类
    return Promise.reject(err)
  }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(exe, buildDecodeArgs(inputPath), {
        env: spawnEnv(env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(new BiliDigestError('AUDIO_DECODE_FAILED', `无法启动 ffmpeg：${err.message}`, undefined, err))
      return
    }

    // PCM 必须按 Buffer 累积：转成字符串再拼会把非 UTF-8 字节毁成 U+FFFD 并改变长度
    const chunks = []
    const err = cappedStderr()
    const onAbort = () => {
      // ffmpeg 不派生子进程，不需要 taskkill 式的进程树清理
      try {
        child.kill()
      } catch {
        // 进程可能已经退出；kill 失败不该盖住原本的失败原因
      }
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => {
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err.push(chunk.toString())
    })

    child.on('error', (e) => {
      cleanup()
      reject(
        new BiliDigestError(
          'AUDIO_DECODE_FAILED',
          `无法启动 ffmpeg：${e.message}`,
          `无法启动 ${exe}：${e.message}。多半是杀软拦截或权限不足；也可用 ffmpegPath 换一份 ffmpeg.exe。`,
          e,
        ),
      )
    })
    child.on('close', (code) => {
      cleanup()
      if (signal?.aborted) {
        reject(cancelled())
        return
      }
      if (code !== 0) {
        const tail = err.value().split(/\r?\n/).slice(-20).join('\n').trim()
        reject(
          new BiliDigestError(
            'AUDIO_DECODE_FAILED',
            'ffmpeg 解码失败',
            tail
              ? `ffmpeg 输出（末尾）：\n${tail}`
              : 'ffmpeg 非零退出且没有任何 stderr。多半是输入文件损坏，或被系统/杀软直接杀掉了。',
          ),
        )
        return
      }
      resolve(
        compact({
          pcm: Buffer.concat(chunks),
          sampleRate: SAMPLE_RATE,
          channels: CHANNELS,
          bitsPerSample: BITS_PER_SAMPLE,
        }),
      )
    })
  })
}
