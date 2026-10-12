import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  resolveYtDlp,
  resolveFfmpeg,
  checkTools,
  childEnv,
  ensureTmpDir,
  spawnEnv,
  proxyArg,
} from '../src/media/tools.js'
import { resolveConfig } from '../src/config.js'
import { BiliDigestError } from '../src/errors.js'

/** 在一次性目录里跑用例，结束后整棵删掉。 */
async function withDir(fn) {
  const dir = resolve(await mkdtemp(join(tmpdir(), 'tools-')))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 本模块关心的六个代理环境变量。Windows 的 process.env 大小写不敏感，
 *  同名不同大小写在 Node 里会合并成同一个变量，故读写都走同一份清单。 */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']

/**
 * 在「父进程已被代理变量污染」的前提下跑一段逻辑，结束后逐字恢复。
 * 用例必须自己制造污染：本机系统代理（127.0.0.1:7890）只写在 WinINET 注册表里，
 * 命令行环境的 process.env 是干净的——不主动注入就测不出「没清干净」这个回归。
 */
function withProxyEnv(values, fn) {
  const saved = PROXY_VARS.map((key) => [key, process.env[key]])
  try {
    for (const key of PROXY_VARS) delete process.env[key]
    Object.assign(process.env, values)
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ---------- 工具定位：显式配置 → <cacheDir>/bin → undefined ----------

test('ytDlpPath 显式配置优先（bin 里也有一份时）', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'yt-dlp.exe'), 'x')
    const exe = join(dir, 'yt-dlp.exe')
    writeFileSync(exe, 'x')
    const cfg = resolveConfig({ cacheDir: dir, ytDlpPath: exe })
    assert.equal(resolveYtDlp(cfg), exe)
  })
})

test('未配置时回落到 cacheDir/bin/yt-dlp.exe', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    const exe = join(dir, 'bin', 'yt-dlp.exe')
    writeFileSync(exe, 'x')
    const cfg = resolveConfig({ cacheDir: dir })
    assert.equal(resolveYtDlp(cfg), exe)
  })
})

test('都找不到时返回 undefined', async () => {
  await withDir(async (dir) => {
    assert.equal(resolveYtDlp(resolveConfig({ cacheDir: dir })), undefined)
  })
})

test('ffmpegPath 显式配置优先（bin 里也有一份时）', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'ffmpeg.exe'), 'x')
    const exe = join(dir, 'ffmpeg.exe')
    writeFileSync(exe, 'x')
    const cfg = resolveConfig({ cacheDir: dir, ffmpegPath: exe })
    assert.equal(resolveFfmpeg(cfg), exe)
  })
})

test('未配置时回落到 cacheDir/bin/ffmpeg.exe', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    const exe = join(dir, 'bin', 'ffmpeg.exe')
    writeFileSync(exe, 'x')
    const cfg = resolveConfig({ cacheDir: dir })
    assert.equal(resolveFfmpeg(cfg), exe)
  })
})

test('ffmpeg 都找不到时返回 undefined', async () => {
  await withDir(async (dir) => {
    assert.equal(resolveFfmpeg(resolveConfig({ cacheDir: dir, ffmpegPath: join(dir, 'nope.exe') })), undefined)
  })
})

test('checkTools 报出缺失项，键存在即有问题', async () => {
  await withDir(async (dir) => {
    const problems = checkTools(resolveConfig({ cacheDir: dir, ffmpegPath: join(dir, 'nope.exe') }))
    assert.equal(typeof problems.ytDlp, 'string')
    assert.equal(typeof problems.ffmpeg, 'string')
    // 只有两个键
    assert.deepEqual(Object.keys(problems).sort(), ['ffmpeg', 'ytDlp'])
  })
})

test('两个工具都在时 checkTools 不含任何键', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'yt-dlp.exe'), 'x')
    writeFileSync(join(dir, 'bin', 'ffmpeg.exe'), 'x')
    assert.deepEqual(checkTools(resolveConfig({ cacheDir: dir })), {})
  })
})

test('只有一个工具缺失时只报那一个键', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'yt-dlp.exe'), 'x')
    const problems = checkTools(resolveConfig({ cacheDir: dir }))
    assert.deepEqual(Object.keys(problems), ['ffmpeg'])
  })
})

// ---------- 子进程环境：TEMP ----------

test('childEnv 必须设置 TEMP/TMP/TMPDIR 到 cacheDir/tmp', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    const env = childEnv(cfg, 'bilibili')
    const expected = join(dir, 'tmp')
    assert.equal(env.TEMP, expected)
    assert.equal(env.TMP, expected)
    assert.equal(env.TMPDIR, expected)
    assert.ok(existsSync(expected), 'TEMP 目录应被创建')
  })
})

test('cacheDir 为相对路径时 TEMP 仍解析成绝对路径，且与 ensureTmpDir 指向同一目录', async () => {
  const cwd = process.cwd()
  const dir = resolve(await mkdtemp(join(tmpdir(), 'tools-rel-')))
  try {
    // 相对 cacheDir 会跟着子进程 cwd 漂移（cache.js 已为此保证绝对路径），
    // 只有真的切到别的 cwd 才能把这个回归测出来。
    process.chdir(dir)
    const cfg = resolveConfig({ cacheDir: 'cache' })
    const tmp = await ensureTmpDir(cfg)
    assert.ok(isAbsolute(tmp), `ensureTmpDir 应返回绝对路径，实际 ${tmp}`)
    assert.equal(tmp, join(dir, 'cache', 'tmp'))
    assert.equal(childEnv(cfg, 'bilibili').TEMP, tmp)
  } finally {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureTmpDir 创建并返回 cacheDir/tmp', async () => {
  await withDir(async (dir) => {
    const result = await ensureTmpDir(resolveConfig({ cacheDir: dir }))
    assert.equal(result, join(dir, 'tmp'))
    assert.ok(existsSync(result))
  })
})

test('cacheDir 为空时 ensureTmpDir 拒绝为 BAD_CONFIG', async () => {
  await assert.rejects(() => ensureTmpDir(resolveConfig({})), {
    name: 'BiliDigestError',
    code: 'BAD_CONFIG',
  })
})

// ---------- 子进程环境：分目标代理策略 ----------

test('childEnv 对 bilibili 目标强制直连', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir, proxy: '' })
    const env = childEnv(cfg, 'bilibili')
    assert.equal(env.__proxy, '')
    assert.equal(env.HTTP_PROXY, '')
    assert.equal(env.HTTPS_PROXY, '')
    assert.equal(env.NO_PROXY, '*')
  })
})

test('childEnv 对 tool-download 目标跟随系统（保留代理变量）', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir, toolDownloadProxy: 'system' })
    const env = childEnv(cfg, 'tool-download')
    assert.equal(env.__proxy, 'system')
    assert.equal(env.NO_PROXY, undefined)
  })
})

test('childEnv 显式代理 URL 被采纳', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir, proxy: 'http://127.0.0.1:1080' })
    const env = childEnv(cfg, 'bilibili')
    assert.equal(env.__proxy, 'http://127.0.0.1:1080')
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1080')
  })
})

test('直连策略清掉从父进程继承的代理变量，并让 no_proxy 覆盖一切', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir, proxy: '' })
    withProxyEnv({ HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' }, () => {
      const env = childEnv(cfg, 'bilibili')
      assert.equal(env.__proxy, '')
      assert.equal(env.HTTP_PROXY, '', '继承来的 HTTP_PROXY 必须被清空')
      assert.equal(env.HTTPS_PROXY, '')
      assert.equal(env.http_proxy, '')
      assert.equal(env.https_proxy, '')
      assert.equal(env.NO_PROXY, '*')
      assert.equal(env.no_proxy, '*')
    })
  })
})

test('system 策略删除继承来的 NO_PROXY，让 Python 能读 WinINET', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir, toolDownloadProxy: 'system' })
    withProxyEnv({ NO_PROXY: 'localhost', HTTP_PROXY: 'http://127.0.0.1:7890' }, () => {
      const env = childEnv(cfg, 'tool-download')
      assert.equal(env.NO_PROXY, undefined, '残留的 NO_PROXY 会挡住系统代理')
      assert.equal(env.no_proxy, undefined)
      assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890', 'system=跟随系统，已有的代理变量不能动')
    })
  })
})

test('显式代理覆盖继承来的代理变量并删掉 NO_PROXY', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir, proxy: 'http://127.0.0.1:1080' })
    withProxyEnv({ HTTP_PROXY: 'http://system:7890', NO_PROXY: 'localhost' }, () => {
      const env = childEnv(cfg, 'bilibili')
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
        assert.equal(env[key], 'http://127.0.0.1:1080', `${key} 应被显式代理覆盖`)
      }
      assert.equal(env.NO_PROXY, undefined)
      assert.equal(env.no_proxy, undefined)
    })
  })
})

test('未知 target 响亮失败，不静默沿用另一个目标的代理策略', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir, proxy: '', toolDownloadProxy: 'system' })
    assert.throws(
      () => childEnv(cfg, 'tool_download'),
      (err) => err instanceof BiliDigestError && err.code === 'BAD_CONFIG',
    )
  })
})

test('cacheDir 为空时 childEnv 抛 BAD_CONFIG（绝不把 TEMP 设成相对目录）', () => {
  assert.throws(
    () => childEnv(resolveConfig({}), 'bilibili'),
    (err) => err instanceof BiliDigestError && err.code === 'BAD_CONFIG',
  )
})

// ---------- 交给 spawn 前的载具剥离 ----------

test('spawnEnv 剥掉 __proxy 载具且不动其它键', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir, proxy: 'http://127.0.0.1:1080' })
    const env = childEnv(cfg, 'bilibili')
    const ready = spawnEnv(env)
    assert.equal('__proxy' in ready, false, '__proxy 不是环境变量，不能传给子进程')
    const { __proxy, ...expected } = env
    assert.equal(__proxy, 'http://127.0.0.1:1080')
    assert.deepEqual(ready, expected)
  })
})

// ---------- 代理策略 → yt-dlp --proxy 参数 ----------

test('proxyArg 把直连策略翻译成空的 --proxy=', () => {
  assert.deepEqual(proxyArg(''), ['--proxy='])
  assert.deepEqual(proxyArg('direct'), ['--proxy='])
  assert.deepEqual(proxyArg(undefined), ['--proxy='])
})

test('proxyArg 对 system 策略返回空数组（必须靠不传参数生效）', () => {
  assert.deepEqual(proxyArg('system'), [], '传 --proxy=system 是非法参数，传 --proxy= 又会禁掉系统代理')
})

test('proxyArg 对显式 URL 返回 --proxy=<url>', () => {
  assert.deepEqual(proxyArg('http://127.0.0.1:1080'), ['--proxy=http://127.0.0.1:1080'])
})

test('proxyArg 与 childEnv 的策略值配套使用', async () => {
  await withDir(async (dir) => {
    // 这是本模块存在的理由：策略值不能直接拼进 --proxy=
    const direct = childEnv(resolveConfig({ cacheDir: dir }), 'bilibili')
    const follow = childEnv(resolveConfig({ cacheDir: dir, toolDownloadProxy: 'system' }), 'tool-download')
    assert.deepEqual(proxyArg(direct.__proxy), ['--proxy='])
    assert.deepEqual(proxyArg(follow.__proxy), [])
    assert.ok(!proxyArg(follow.__proxy).some((a) => a.includes('system')))
  })
})

// ---------- 测试自身的 env 卫生 ----------

test('withProxyEnv 结束后 process.env 被逐字恢复（不泄漏给同文件其它用例）', () => {
  const before = PROXY_VARS.map((key) => process.env[key])
  withProxyEnv({ HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' }, () => {
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890')
    assert.equal(process.env.NO_PROXY, 'localhost')
  })
  assert.deepEqual(
    PROXY_VARS.map((key) => process.env[key]),
    before,
  )
})
