import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { BiliDigestError } from './errors.js'

/**
 * 派生一次作业的全部缓存路径。纯函数，不碰文件系统。
 *
 * **保证返回绝对路径。** 这不是可有可无的洁癖：`binDir`/`tmpDir` 会被拿去
 * 拼子进程可执行文件路径与 `TEMP`，相对路径会跟着子进程的 cwd 漂移，
 * 在 DSH 里表现为「工具明明装了却找不到」。
 *
 * @param {string} cacheDir 缓存根目录；相对路径会按当前 cwd 解析成绝对路径
 * @param {string} bvid 视频号
 * @throws BAD_CONFIG 当 cacheDir 为空——空串解析出来是进程 cwd，会把缓存
 *         悄悄散到应用安装目录里去，宁可响亮地失败
 */
export function cachePaths(cacheDir, bvid) {
  if (typeof cacheDir !== 'string' || cacheDir.trim() === '') {
    throw new BiliDigestError(
      'BAD_CONFIG',
      'cacheDir 未配置',
      '在 profile 的 cordis.patch.yml 里设置 cacheDir（例如 dshCachePath(\'bili-digest\')）。',
    )
  }
  const base = resolve(cacheDir)
  const root = join(base, bvid)
  return {
    root,
    probe: join(root, 'probe.json'),
    segments: join(root, 'segments.json'),
    digest: join(root, 'digest.json'),
    audioM4s: join(root, 'audio.m4s'),
    audioWav: join(root, 'audio.wav'),
    runLog: join(root, 'run.log'),
    jobDir: (jobId) => join(base, 'jobs', jobId),
    jobFile: (jobId) => join(base, 'jobs', jobId, 'job.json'),
    binDir: join(base, 'bin'),
    tmpDir: join(base, 'tmp'),
  }
}

/**
 * 读 JSON。缺失或非法都返回 null——缓存是尽力而为的，不该让作业失败。
 * @returns 解析结果或 null
 */
export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 临时文件 + rename 写入，避免半截文件被后续复用。
 * 失败时清理临时文件：Windows 上 rename 会因目标被占用（AV/索引器）抛
 * EPERM/EACCES，不清就会在缓存目录里留一地 .tmp-* 垃圾。
 */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** 读文本；缺失返回 null。 */
export async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}
