import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 派生一次作业的全部缓存路径。纯函数，不碰文件系统。
 * @param cacheDir 缓存根目录（绝对路径）
 * @param bvid 视频号
 */
export function cachePaths(cacheDir, bvid) {
  const root = join(cacheDir, bvid)
  return {
    root,
    probe: join(root, 'probe.json'),
    segments: join(root, 'segments.json'),
    digest: join(root, 'digest.json'),
    audioM4s: join(root, 'audio.m4s'),
    audioWav: join(root, 'audio.wav'),
    runLog: join(root, 'run.log'),
    jobDir: (jobId) => join(cacheDir, 'jobs', jobId),
    jobFile: (jobId) => join(cacheDir, 'jobs', jobId, 'job.json'),
    binDir: join(cacheDir, 'bin'),
    tmpDir: join(cacheDir, 'tmp'),
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

/** 临时文件 + rename 写入，避免半截文件被后续复用。 */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** 读文本；缺失返回 null。 */
export async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}
