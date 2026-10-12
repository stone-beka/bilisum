import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { decodeToPcm, installFfmpeg } from '../src/media/ffmpeg.js'
import { resolveBundledFfmpeg } from '../src/media/tools.js'

/**
 * 可注入的假 spawn：只回放预设的 stdout/stderr/退出码，**永不启动真实进程**
 * （真二进制 61.5 MB，且单测必须离线）。套路与 ytdlp.test.mjs 一致；差别只在
 * stdout 分片是 **Buffer**——PCM 是二进制，用字符串回放会把「实现偷偷 toString」
 * 这类 bug 掩盖掉。
 * @param options.stdoutChunks stdout 的多个二进制分片，每片占一个 setImmediate
 * @param options.hang true = 不主动 close，只能靠 kill 收场（测中止）
 */
function fakeSpawn({ stdoutChunks = [], stderr = '', code = 0, error, hang = false } = {}) {
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
    const writeEach = (stream, chunks, done) => {
      let index = 0
      const step = () => {
        if (index >= chunks.length) {
          done()
          return
        }
        stream.write(chunks[index])
        index += 1
        setImmediate(step)
      }
      step()
    }
    setImmediate(() => {
      if (error) {
        child.emit('error', error)
        return
      }
      writeEach(child.stdout, stdoutChunks, () => {
        if (stderr) child.stderr.write(stderr)
        child.stdout.end()
        child.stderr.end()
        if (!hang) setImmediate(() => child.emit('close', code))
      })
    })
    return child
  }
  return { spawnImpl, calls }
}

/** 建一个带 cacheDir 的配置，并在 `<cacheDir>/bin` 放一个占位 exe——它只让
 *  resolveFfmpeg 找得到路径，spawn 永远被注入，占位文件不会被真的执行。 */
async function fixtureConfig(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ffmpeg-'))
  const cfg = resolveConfig({ cacheDir: dir, ...overrides })
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'ffmpeg.exe'), 'placeholder')
  return { dir, cfg }
}

// ---------- installFfmpeg：把依赖里的二进制复制进 <cacheDir>/bin ----------

test('installFfmpeg 把内置依赖里的 ffmpeg.exe 复制进 cacheDir/bin', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ffmpeg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const dest = await installFfmpeg(resolveConfig({ cacheDir: dir }))

  assert.equal(dest, join(dir, 'bin', 'ffmpeg.exe'))
  assert.ok(existsSync(dest), '安装后目标文件必须存在')
  // 与源文件同尺寸：证明复制的是真二进制，不是被截断的残片
  assert.equal(statSync(dest).size, statSync(resolveBundledFfmpeg()).size)
  assert.ok(statSync(dest).size > 1024 * 1024, 'ffmpeg.exe 只有几十 MB 量级才可能是真的')
})

test('installFfmpeg 幂等：已存在时不再复制，且不留下 .tmp- 残片', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ffmpeg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cfg = resolveConfig({ cacheDir: dir })

  const first = await installFfmpeg(cfg)
  const second = await installFfmpeg(cfg)

  assert.equal(second, first)
  assert.ok(existsSync(second))
  // 落盘走「临时文件 + rename」：成功路径上不该有临时文件残留
  assert.deepEqual(readdirSync(join(dir, 'bin')).filter((name) => name.includes('.tmp-')), [])
})

// ---------- decodeToPcm：唯一的解码点 ----------

test('decodeToPcm 参数锁死：-nostdin / 16kHz / 单声道 / PCM16 / pipe:1，且不写文件、不用 -y', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const input = join(dir, 'audio.m4s')
  const { spawnImpl, calls } = fakeSpawn({ stdoutChunks: [Buffer.from([1, 2])] })

  await decodeToPcm(cfg, input, { spawnImpl })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].exe, join(dir, 'bin', 'ffmpeg.exe'))
  assert.deepEqual(calls[0].args, [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    'pipe:1',
  ])
  // 输出走 stdout，ffmpeg 不该被允许覆盖/拒绝任何文件
  assert.ok(!calls[0].args.includes('-y'), 'stdout 输出不该出现 -y')
  assert.ok(!calls[0].args.includes('-n'), 'stdout 输出不该出现 -n')
  assert.equal(calls[0].args.at(-1), 'pipe:1')
})

test('decodeToPcm 必须带 -nostdin：否则 ffmpeg 会吃掉父进程 stdin 而挂住', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({})

  await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl })

  assert.ok(calls[0].args.includes('-nostdin'), '参数里必须有 -nostdin')
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(calls[0].options.windowsHide, true)
})

test('decodeToPcm 把采样率/声道数钉死在 ASR 接受的规格上（16kHz 单声道）', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({})

  const res = await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl })
  const args = calls[0].args
  const valueOf = (flag) => args[args.indexOf(flag) + 1]

  // 不显式给 -ar/-ac，ffmpeg 会按输入原样输出（常见 44.1kHz 立体声），SenseVoice 会拒收
  assert.equal(valueOf('-ar'), '16000')
  assert.equal(valueOf('-ac'), '1')
  assert.equal(valueOf('-f'), 's16le')
  assert.deepEqual(
    { sampleRate: res.sampleRate, channels: res.channels, bitsPerSample: res.bitsPerSample },
    { sampleRate: 16000, channels: 1, bitsPerSample: 16 },
  )
})

test('decodeToPcm 返回裸 PCM：bytes 精确等于 stdout 拼接，不含 WAV 头', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const chunks = [Buffer.from([0, 1, 2, 3]), Buffer.from([0xff, 0x80, 0x7f, 0xfe])]
  const { spawnImpl, calls } = fakeSpawn({ stdoutChunks: chunks })

  const res = await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl })

  assert.equal(Buffer.compare(res.pcm, Buffer.concat(chunks)), 0, 'PCM 必须逐字节等于 stdout')
  assert.equal(res.pcm.length, 8)
  assert.notEqual(res.pcm.subarray(0, 4).toString('latin1'), 'RIFF', '裸 PCM 不该带 WAV 头')
  assert.equal(calls[0].args.includes(join(dir, 'a.m4s')), true)
})

test('decodeToPcm 按二进制读 stdout：非 UTF-8 字节不能被 toString 毁掉', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  // 这些字节转成字符串再回来会变成 U+FFFD（0xef 0xbf 0xbd），长度也会变
  const raw = Buffer.from([0x80, 0xff, 0xc0, 0xfe, 0x00, 0x7f])
  const { spawnImpl } = fakeSpawn({ stdoutChunks: [raw] })

  const res = await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl })

  assert.equal(res.pcm.length, raw.length, '字节数不能因为编码转换而改变')
  assert.equal(Buffer.compare(res.pcm, raw), 0)
})

test('decodeToPcm 的返回值过 compact() 后 pcm 仍是 Buffer，键只有四个', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stdoutChunks: [Buffer.from([9])] })

  const res = await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl })

  // 若 compact() 把 Buffer 当普通对象递归，pcm 会变成 {'0':..} 这样的字节下标对象
  assert.ok(Buffer.isBuffer(res.pcm), 'pcm 必须是 Buffer')
  assert.deepEqual(Object.keys(res).sort(), ['bitsPerSample', 'channels', 'pcm', 'sampleRate'])
})

test('decodeToPcm 用 childEnv 的环境启动子进程（TEMP 指向 cacheDir/tmp）', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({})

  await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl })

  assert.equal(calls[0].options.env.TEMP, join(dir, 'tmp'))
  assert.ok(!('__proxy' in calls[0].options.env), '__proxy 不能外泄给子进程')
})

test('不再配置 ffmpegPath 且 bin 为空时，回落到内置依赖里的 ffmpeg.exe', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ffmpeg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const cfg = resolveConfig({ cacheDir: dir })
  const { spawnImpl, calls } = fakeSpawn({ stdoutChunks: [Buffer.from([7, 7])] })

  const res = await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl })

  assert.equal(calls[0].exe, resolveBundledFfmpeg())
  assert.equal(res.pcm.length, 2)
})

test('decodeToPcm 找不到 ffmpeg 时抛 FFMPEG_MISSING，hint 给出两条补救路径，且不启动进程', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ffmpeg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const cfg = resolveConfig({ cacheDir: dir, ffmpegPath: join(dir, 'nope.exe') })
  const { spawnImpl, calls } = fakeSpawn({})

  const err = await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl }).then(
    () => null,
    (e) => e,
  )

  assert.equal(err?.code, 'FFMPEG_MISSING')
  assert.match(String(err.hint), /ffmpegPath/, 'hint 要提 ffmpegPath 配置')
  assert.match(String(err.hint), /bin/, 'hint 要提插件的 binDir')
  assert.equal(calls.length, 0, '找不到 exe 时不该 spawn')
})

test('decodeToPcm 非零退出抛 AUDIO_DECODE_FAILED，hint 只留 stderr 尾部', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const lines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`)
  const { spawnImpl } = fakeSpawn({ stderr: lines.join('\n'), code: 1 })

  const err = await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl }).then(
    () => null,
    (e) => e,
  )

  assert.equal(err?.code, 'AUDIO_DECODE_FAILED')
  assert.match(String(err.hint), /line-25/, '末尾的报错正文必须在 hint 里')
  assert.ok(!String(err.hint).includes('line-5\n'), 'hint 只留末尾若干行，不带几十行噪声')
})

test('decodeToPcm 退出码为 0 但没有 stderr 时正常返回空输出', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl } = fakeSpawn({ stdoutChunks: [] })

  const res = await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl })

  assert.ok(Buffer.isBuffer(res.pcm))
  assert.equal(res.pcm.length, 0)
})

test('decodeToPcm 把 spawn 的 error 事件转成 AUDIO_DECODE_FAILED 并保留 cause', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const boom = new Error('spawn EPERM')
  const { spawnImpl } = fakeSpawn({ error: boom })

  const err = await decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl }).then(
    () => null,
    (e) => e,
  )

  assert.equal(err?.code, 'AUDIO_DECODE_FAILED')
  assert.equal(err.cause, boom)
  assert.match(String(err.hint), /spawn EPERM/)
})

test('decodeToPcm 已中止的 signal 不启动进程，直接抛 CANCELLED', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({})

  const err = await decodeToPcm(cfg, join(dir, 'a.m4s'), {
    spawnImpl,
    signal: AbortSignal.abort(),
  }).then(
    () => null,
    (e) => e,
  )

  assert.equal(err?.code, 'CANCELLED')
  assert.equal(calls.length, 0)
})

test('decodeToPcm 运行中中止时 kill 子进程并抛 CANCELLED', async (t) => {
  const { dir, cfg } = await fixtureConfig()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { spawnImpl, calls } = fakeSpawn({ hang: true })
  const ac = new AbortController()

  const pending = decodeToPcm(cfg, join(dir, 'a.m4s'), { spawnImpl, signal: ac.signal })
  await new Promise((resolve) => setImmediate(resolve))
  ac.abort()

  const err = await pending.then(
    () => null,
    (e) => e,
  )
  assert.equal(err?.code, 'CANCELLED')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kills.length, 1, '中止必须 kill 子进程')
})

// ---------- 真实性检查：内置依赖确实带着一个可执行文件 ----------

test('内置依赖里确实有一份 ffmpeg.exe，installFfmpeg 的源是它', () => {
  const exe = resolveBundledFfmpeg()
  assert.equal(typeof exe, 'string')
  assert.ok(existsSync(exe))
  assert.equal(exe.endsWith(join('@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')), true)
})
