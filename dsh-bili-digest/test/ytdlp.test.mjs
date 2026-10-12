import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  buildProbeArgs,
  classifyYtDlpFailure,
  probe,
  probeVideo,
  reduceProbe,
  runYtDlp,
  version,
  ytDlpVersion,
} from '../src/media/ytdlp.js'
import { resolveConfig } from '../src/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(await readFile(join(here, 'fixtures', 'probe.json'), 'utf8'))

/**
 * 可注入的假 spawn：只回放预设的 stdout/stderr/退出码，**永不启动真实进程**。
 * runYtDlp 在 spawn 返回后才挂监听，所以数据走 setImmediate 异步发。
 * @param options.hang true = 不主动 close，只能靠 kill 收场（测中止）
 */
function fakeSpawn({ stdout = '', stderr = '', code = 0, error, hang = false } = {}) {
  const calls = []
  const spawnImpl = (exe, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const kills = []
    child.kill = () => {
      kills.push(true)
      if (hang) setImmediate(() => child.emit('close', null))
      return true
    }
    calls.push({ exe, args, options, kills })
    setImmediate(() => {
      if (error) {
        child.emit('error', error)
        return
      }
      if (stdout) child.stdout.write(stdout)
      if (stderr) child.stderr.write(stderr)
      child.stdout.end()
      child.stderr.end()
      if (!hang) setImmediate(() => child.emit('close', code))
    })
    return child
  }
  return { spawnImpl, calls }
}

/** 建一个带 cacheDir 的配置，并在 `<cacheDir>/bin` 放一个占位 exe。
 *  占位文件只让 resolveYtDlp 找得到路径——spawn 永远被注入，不会被真的执行。 */
async function fixtureConfig(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ytdlp-'))
  const cfg = resolveConfig({ cacheDir: dir, ...overrides })
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(join(dir, 'bin', 'yt-dlp.exe'), 'placeholder')
  return { dir, cfg }
}

/** 断言抛出的 BiliDigestError 的 code，并可选核验 message / hint 特征。 */
function errorWith(code, { message, hint } = {}) {
  return (e) => {
    assert.equal(e.code, code, `期望 code=${code}，实得 ${e.code}（${e.message}）`)
    if (message) assert.match(e.message, message)
    if (hint) assert.match(String(e.hint ?? ''), hint)
    return true
  }
}

// ---------- reduceProbe：纯函数，离线可测 ----------

test('reduceProbe 抽出需要的字段', () => {
  const info = reduceProbe(fixture)
  assert.equal(info.id, 'BV1GJ411x7h7')
  assert.equal(info.duration, 212.393)
  assert.equal(info.uploader, '索尼音乐中国')
  assert.equal(info.chapters.length, 0)
  assert.deepEqual(info.subtitles, [])
  assert.equal(info.webpageUrl, 'https://www.bilibili.com/video/BV1GJ411x7h7')
})

test('reduceProbe 把 chapters 归一化为 {start,end,title}', () => {
  const info = reduceProbe({
    ...fixture,
    chapters: [{ start_time: 0, end_time: 90, title: '开场' }, { start_time: 90, end_time: 200, title: '正题' }],
  })
  assert.deepEqual(info.chapters, [
    { start: 0, end: 90, title: '开场' },
    { start: 90, end: 200, title: '正题' },
  ])
})

test('reduceProbe 对缺字段容错', () => {
  const info = reduceProbe({ id: 'BVx' })
  assert.equal(info.duration, 0)
  assert.equal(info.title, 'BVx')
  assert.deepEqual(info.tags, [])
  // 可选字段一律降级成空值，绝不 undefined：Pipeline 宁可少信息也不能炸
  assert.deepEqual(info.chapters, [])
  assert.deepEqual(info.subtitles, [])
  assert.equal(info.uploader, '')
  assert.equal(info.webpageUrl, '')
  assert.equal(info.description, '')
  assert.equal(info.isPlaylist, false)
  assert.equal(info.playlistCount, 1)
})

test('reduceProbe 把非数值 duration 降级为 0（NaN 不是合法 JSON）', () => {
  const info = reduceProbe({ id: 'BV1', duration: 'abc' })
  assert.equal(info.duration, 0)
  assert.ok(Number.isFinite(reduceProbe({ id: 'BV1', duration: null }).duration))
})

test('reduceProbe 丢弃退化章节，非数组 chapters 归一为空数组', () => {
  const info = reduceProbe({
    id: 'BV1',
    chapters: [
      { start_time: 10, end_time: 10, title: '零长度' },
      { start_time: 30, end_time: 20, title: '倒序' },
      { start_time: 0, end_time: 8, title: '正常' },
    ],
  })
  assert.deepEqual(info.chapters, [{ start: 0, end: 8, title: '正常' }])
  assert.deepEqual(reduceProbe({ id: 'BV1', chapters: 'nope' }).chapters, [])
})

test('reduceProbe 保留显式章节标题为空字符串的情况（不伪造名字）', () => {
  const info = reduceProbe({ id: 'BV1', chapters: [{ start_time: 0, end_time: 5 }] })
  assert.deepEqual(info.chapters, [{ start: 0, end: 5, title: '' }])
})

test('reduceProbe 把 subtitles 的对象键取成语言列表，非对象归一为空数组', () => {
  const withSubs = reduceProbe({ id: 'BV1', subtitles: { 'zh-Hans': [{ ext: 'json' }], en: [] } })
  assert.deepEqual(withSubs.subtitles, ['zh-Hans', 'en'])
  assert.deepEqual(reduceProbe({ id: 'BV1', subtitles: null }).subtitles, [])
})

test('reduceProbe 在 id 与 title 都缺失时抛错：这不是能降级的信息', () => {
  assert.throws(() => reduceProbe({ duration: 12 }), errorWith('YTDLP_FAILED', { message: /id|title/ }))
  assert.throws(() => reduceProbe(null), errorWith('YTDLP_FAILED'))
})

test('reduceProbe 的返回值没有 undefined 键（compact 语义）', () => {
  const info = reduceProbe(fixture)
  for (const [key, value] of Object.entries(info)) {
    assert.notEqual(value, undefined, `${key} 不该是 undefined`)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(info)), info)
})

// ---------- buildProbeArgs：代理策略必须经 proxyArg 翻译 ----------

test('buildProbeArgs 含离线与静默标志，且带 --proxy', () => {
  const args = buildProbeArgs('https://x/video/BV1', '')
  assert.ok(args.includes('--dump-single-json'))
  assert.ok(args.includes('--skip-download'))
  assert.ok(args.includes('--no-playlist'))
  assert.ok(args.includes('--proxy='))
  assert.equal(args.at(-1), 'https://x/video/BV1')
})

test('直连策略产出空值 --proxy，而不是把策略字面量拼进去', () => {
  // 判别性：写成 `--proxy=${policy}` 会产出非法的 --proxy=direct
  for (const policy of ['', 'direct']) {
    const proxyArgs = buildProbeArgs('https://x', '', policy).filter((a) => a.startsWith('--proxy'))
    assert.deepEqual(proxyArgs, ['--proxy='], `策略 ${JSON.stringify(policy)} 必须是空值代理`)
  }
})

test('proxy 策略为 system 时完全不传 --proxy（否则会变成非法的 --proxy=system）', () => {
  const args = buildProbeArgs('https://x', '', 'system')
  assert.ok(!args.some((a) => a.startsWith('--proxy')), 'system 策略必须靠"不传参数"来生效')
})

test('proxy 策略为显式 URL 时传 --proxy=<url>', () => {
  const args = buildProbeArgs('https://x', '', 'http://127.0.0.1:1080')
  assert.ok(args.includes('--proxy=http://127.0.0.1:1080'))
})

test('buildProbeArgs 带 cookie 文件时追加 --cookies', () => {
  const args = buildProbeArgs('https://x', 'C:/tmp/c.txt')
  assert.ok(args.includes('--cookies'))
  assert.ok(args.includes('C:/tmp/c.txt'))
})

test('buildProbeArgs 无 cookie 文件时不出现 --cookies', () => {
  assert.ok(!buildProbeArgs('https://x', '').includes('--cookies'))
})

// ---------- classifyYtDlpFailure：三类实测踩过的失败 ----------

test('classifyYtDlpFailure 把 412 归为 YTDLP_BLOCKED', () => {
  const e = classifyYtDlpFailure('ERROR: Unable to download webpage: HTTP Error 412: Precondition Failed')
  assert.equal(e.code, 'YTDLP_BLOCKED')
  assert.match(e.hint, /proxy/)
})

test('412 的提示同时指向代理策略与 BILI_SESSDATA', () => {
  const e = classifyYtDlpFailure('ERROR: HTTP Error 412: Precondition Failed')
  assert.match(e.hint, /proxy/)
  assert.match(e.hint, /BILI_SESSDATA/)
})

test('classifyYtDlpFailure 把临时目录错误归为 TOOL_TEMP_UNAVAILABLE', () => {
  const e = classifyYtDlpFailure('[PYI-25504:ERROR] Could not create temporary directory!')
  assert.equal(e.code, 'TOOL_TEMP_UNAVAILABLE')
  assert.match(e.hint, /cacheDir/)
})

test('classifyYtDlpFailure 其余归为 YTDLP_FAILED', () => {
  assert.equal(classifyYtDlpFailure('ERROR: Video unavailable').code, 'YTDLP_FAILED')
})

test('YTDLP_FAILED 的 hint 带上 stderr 尾部，便于定位', () => {
  const e = classifyYtDlpFailure('ERROR: Video unavailable')
  assert.match(e.hint, /Video unavailable/)
})

test('完全没有输出的非零退出也不能是死胡同：给出可操作的提示', () => {
  const e = classifyYtDlpFailure('')
  assert.equal(e.code, 'YTDLP_FAILED')
  assert.match(e.message, /没有任何输出/)
  assert.match(e.hint, /杀软|权限/)
})

// ---------- runYtDlp：注入 spawn，离线跑 ----------

test('runYtDlp 成功时返回 stdout/stderr/code，并用 childEnv 的环境启动子进程', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ stdout: '{"ok":true}', stderr: 'noise', code: 0 })

  const res = await runYtDlp(cfg, ['--version'], { spawnImpl })

  assert.deepEqual(res, { stdout: '{"ok":true}', stderr: 'noise', code: 0 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].exe, join(dir, 'bin', 'yt-dlp.exe'))
  assert.deepEqual(calls[0].args, ['--version'])
  assert.equal(calls[0].options.windowsHide, true)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  // PyInstaller 起不来的根因：TEMP 必须指向可写的 <cacheDir>/tmp
  assert.equal(calls[0].options.env.TEMP, join(dir, 'tmp'))
  // __proxy 是策略载具，不是环境变量，绝不能进子进程环境
  assert.ok(!('__proxy' in calls[0].options.env), '__proxy 不能外泄给子进程')
})

test('runYtDlp 非零退出且 stderr 含 412 时抛 YTDLP_BLOCKED', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stderr: 'ERROR: HTTP Error 412: Precondition Failed', code: 1 })

  await assert.rejects(
    () => runYtDlp(cfg, ['x'], { spawnImpl }),
    errorWith('YTDLP_BLOCKED', { message: /412|风控|拒绝/, hint: /BILI_SESSDATA/ }),
  )
})

test('runYtDlp 非零退出且非 412 时抛 YTDLP_FAILED 并附 stderr 尾部', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stderr: 'ERROR: Video unavailable', code: 1 })

  await assert.rejects(
    () => runYtDlp(cfg, ['x'], { spawnImpl }),
    errorWith('YTDLP_FAILED', { hint: /Video unavailable/ }),
  )
})

test('runYtDlp 把 PyInstaller 临时目录错误归为 TOOL_TEMP_UNAVAILABLE', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stderr: '[PYI-1:ERROR] Could not create temporary directory!', code: 1 })

  await assert.rejects(() => runYtDlp(cfg, ['x'], { spawnImpl }), errorWith('TOOL_TEMP_UNAVAILABLE'))
})

test('runYtDlp 在 exe 缺失时抛 YTDLP_MISSING，且不启动进程', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytdlp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ stdout: '{}' })

  await assert.rejects(
    () => runYtDlp(resolveConfig({ cacheDir: dir }), ['x'], { spawnImpl }),
    errorWith('YTDLP_MISSING', { message: /yt-dlp/, hint: /yt-dlp\.exe/ }),
  )
  assert.equal(calls.length, 0, '找不到 exe 时不该 spawn')
})

test('runYtDlp 把 spawn 的 error 事件转成 YTDLP_FAILED 并保留 cause', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const boom = new Error('spawn EPERM')
  const { spawnImpl } = fakeSpawn({ error: boom })

  const err = await runYtDlp(cfg, ['x'], { spawnImpl }).then(
    () => null,
    (e) => e,
  )
  assert.equal(err.code, 'YTDLP_FAILED')
  assert.equal(err.cause, boom)
})

test('runYtDlp 已中止的 signal 不启动进程，直接抛 CANCELLED', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ stdout: '{}' })

  await assert.rejects(
    () => runYtDlp(cfg, ['x'], { spawnImpl, signal: AbortSignal.abort() }),
    errorWith('CANCELLED'),
  )
  assert.equal(calls.length, 0)
})

test('runYtDlp 运行中中止时 kill 子进程并抛 CANCELLED', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ hang: true })
  const ac = new AbortController()

  const pending = runYtDlp(cfg, ['x'], { spawnImpl, signal: ac.signal })
  await new Promise((resolve) => setImmediate(resolve))
  ac.abort()

  await assert.rejects(() => pending, errorWith('CANCELLED'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kills.length, 1, '中止必须 kill 子进程')
})

test('runYtDlp 把 stderr 分片透给 onStderr', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stderr: 'progress 1\nprogress 2\n' })
  const seen = []

  await runYtDlp(cfg, ['x'], { spawnImpl, onStderr: (chunk) => seen.push(chunk) })

  assert.equal(seen.join(''), 'progress 1\nprogress 2\n')
})

// ---------- probe ----------

test('probe 解析 JSON 输出并归约成 Probe', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ stdout: JSON.stringify(fixture) })

  const info = await probe(cfg, 'https://www.bilibili.com/video/BV1GJ411x7h7', { spawnImpl })

  assert.equal(info.id, 'BV1GJ411x7h7')
  assert.equal(info.duration, 212.393)
  assert.deepEqual(info.chapters, [])
  assert.deepEqual(calls[0].args.slice(0, 3), ['--dump-single-json', '--skip-download', '--no-playlist'])
  assert.equal(calls[0].args.at(-1), 'https://www.bilibili.com/video/BV1GJ411x7h7')
})

test('probe 的代理参数来自 childEnv 的 __proxy 策略（直连 → --proxy=）', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ stdout: JSON.stringify(fixture) })

  await probe(cfg, 'https://x', { spawnImpl })

  assert.deepEqual(
    calls[0].args.filter((a) => a.startsWith('--proxy')),
    ['--proxy='],
    'B 站必须直连（系统代理会 412）',
  )
})

test('probe 在 proxy=system 时不传 --proxy', async (t) => {
  const { dir, cfg } = await fixtureConfig({ proxy: 'system' })
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ stdout: JSON.stringify(fixture) })

  await probe(cfg, 'https://x', { spawnImpl })

  assert.ok(!calls[0].args.some((a) => a.startsWith('--proxy')))
})

test('probe 带 cookieFile 时传 --cookies，并保留字幕清单', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const withSubs = { ...fixture, subtitles: { 'zh-Hans': [{ ext: 'json' }] } }
  const { spawnImpl, calls } = fakeSpawn({ stdout: JSON.stringify(withSubs) })

  const info = await probe(cfg, 'https://x', { spawnImpl, cookieFile: 'C:/tmp/cookies.txt' })

  assert.ok(calls[0].args.includes('--cookies'))
  assert.ok(calls[0].args.includes('C:/tmp/cookies.txt'))
  assert.deepEqual(info.subtitles, ['zh-Hans'])
})

test('匿名跑（无 cookieFile）不宣称有字幕，即使 yt-dlp 报出了 subtitles', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const withSubs = { ...fixture, subtitles: { 'zh-Hans': [{ ext: 'json' }] } }
  const { spawnImpl } = fakeSpawn({ stdout: JSON.stringify(withSubs) })

  const info = await probe(cfg, 'https://x', { spawnImpl })

  // yt-dlp 自己的提示是 "Subtitles are only available when logged in"；
  // 实测匿名跑 10 个分区 40 个视频字幕条目恒为 0，故匿名一律视为无字幕
  assert.deepEqual(info.subtitles, [])
})

test('probe 把 stderr 里的 412 归为 YTDLP_BLOCKED', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stderr: 'ERROR: HTTP Error 412: Precondition Failed', code: 1 })

  await assert.rejects(
    () => probe(cfg, 'https://x', { spawnImpl }),
    errorWith('YTDLP_BLOCKED', { message: /412/, hint: /BILI_SESSDATA/ }),
  )
})

test('probe 在 stdout 是 412 的 HTML 错误页时给风控消息，而不是 JSON 解析错', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const html = '<!DOCTYPE html><html><head><title>412 Precondition Failed</title></head><body></body></html>'
  const { spawnImpl } = fakeSpawn({ stdout: html })

  const err = await probe(cfg, 'https://x', { spawnImpl }).then(
    () => null,
    (e) => e,
  )
  assert.equal(err.code, 'YTDLP_BLOCKED')
  assert.doesNotMatch(err.message, /JSON/)
  assert.match(String(err.hint), /BILI_SESSDATA/)
})

test('probe 在 stdout 是 HTML 但不含 412 时抛 YTDLP_FAILED 并说明是 HTML', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stdout: '<html><body>captcha</body></html>' })

  await assert.rejects(
    () => probe(cfg, 'https://x', { spawnImpl }),
    errorWith('YTDLP_FAILED', { message: /HTML/ }),
  )
})

test('probe 对既非 JSON 也非 HTML 的输出抛 YTDLP_FAILED', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stdout: 'WARNING: something went wrong' })

  await assert.rejects(
    () => probe(cfg, 'https://x', { spawnImpl }),
    errorWith('YTDLP_FAILED', { message: /JSON/ }),
  )
})

test('probe 对合集/番剧的 entries 输出抛 BILI_UNSUPPORTED_CONTENT', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stdout: JSON.stringify({ _type: 'playlist', entries: [fixture] }) })

  await assert.rejects(
    () => probe(cfg, 'https://x', { spawnImpl }),
    errorWith('BILI_UNSUPPORTED_CONTENT', { hint: /单个视频/ }),
  )
})

test('probe 上报 phase=probe 的进度事件', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stdout: JSON.stringify(fixture) })
  const seen = []

  await probe(cfg, 'https://x', { spawnImpl, onProgress: (p) => seen.push(p) })

  assert.ok(seen.some((p) => p.phase === 'probe'))
})

test('probe 在已中止的 signal 下不启动进程', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ stdout: JSON.stringify(fixture) })

  await assert.rejects(() => probe(cfg, 'https://x', { spawnImpl, signal: AbortSignal.abort() }), errorWith('CANCELLED'))
  assert.equal(calls.length, 0)
})

// ---------- version ----------

test('version 返回 trim 过的 yt-dlp 版本号', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ stdout: '2026.08.19\n' })

  assert.equal(await version(cfg, { spawnImpl }), '2026.08.19')
  assert.deepEqual(calls[0].args, ['--version'])
})

// ---------- 别名：任务书用的是 probeVideo / ytDlpVersion ----------

test('probeVideo / ytDlpVersion 是 probe / version 的别名（同一函数）', () => {
  assert.equal(probeVideo, probe)
  assert.equal(ytDlpVersion, version)
})
