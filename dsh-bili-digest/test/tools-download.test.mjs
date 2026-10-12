import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseSums, downloadYtDlp, YTDLP_MIRRORS } from '../src/media/tools.js'
import { resolveConfig } from '../src/config.js'

const SUMS = `abc123  yt-dlp.exe\ndef456  yt-dlp.tar.gz\n`

test('parseSums 解析文件名到哈希', () => {
  const m = parseSums(SUMS)
  assert.equal(m.get('yt-dlp.exe'), 'abc123')
  assert.equal(m.get('yt-dlp.tar.gz'), 'def456')
})

test('镜像链至少三个且以官方直连结尾', () => {
  const list = YTDLP_MIRRORS('2026.08.19')
  assert.ok(list.length >= 3)
  assert.match(list.at(-1), /^https:\/\/github\.com\//)
})

test('下载内容 SHA-256 不符时换下一个镜像', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dl-'))
  const cfg = resolveConfig({ cacheDir: dir })
  const real = Buffer.from('the real binary')
  const realHash = createHash('sha256').update(real).digest('hex')
  let calls = 0
  const fetchImpl = async (url) => {
    calls += 1
    if (url.endsWith('SHA2-256SUMS')) {
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(`bad000  yt-dlp.exe\n${realHash}  yt-dlp.exe\n`).buffer }
    }
    // 第一个镜像给错内容，第二个给对内容
    const body = calls <= 2 ? Buffer.from('corrupted') : real
    return { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
  }
  const dest = await downloadYtDlp(cfg, { fetchImpl })
  assert.equal(await readFile(dest, 'utf8'), 'the real binary')
  await rm(dir, { recursive: true, force: true })
})

test('全部镜像失败抛 YTDLP_DOWNLOAD_FAILED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dl-'))
  const cfg = resolveConfig({ cacheDir: dir })
  const fetchImpl = async () => ({ ok: false, status: 500 })
  await assert.rejects(() => downloadYtDlp(cfg, { fetchImpl }), (e) => e.code === 'YTDLP_DOWNLOAD_FAILED')
  await rm(dir, { recursive: true, force: true })
})

// ---------- 下面是「换下一个镜像」这句话的判别性用例 ----------
// brief 里的那条只断言了最终成功（把「第一个镜像都别试、直接下第二个」写进去它也过），
// 所以这里把「谁被请求过、bin 里最后留下什么」也钉住。

/** 在一次性目录里跑用例，结束后整棵删掉。tmpdir() 先 resolve，
 *  否则在 TMP 非规范的环境里，join(dir, ...) 与实现里 resolve() 过的路径对不上。 */
async function withDir(fn) {
  const dir = resolve(await mkdtemp(join(tmpdir(), 'dl-')))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** 造一个 fetch 替身响应；arrayBuffer 要按 byteOffset 切片——
 *  Buffer.from 常从小对象池里切，直接给 buf.buffer 会多带前一个 Buffer 的字节。 */
function bytesResponse(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }
}

test('校验失败的镜像不留任何文件，成功的是第二个镜像', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    const mirrors = YTDLP_MIRRORS()
    const real = Buffer.from('the real binary')
    const exeUrls = []
    const events = []
    const fetchImpl = async (url) => {
      if (url.endsWith('SHA2-256SUMS')) return bytesResponse(`0badc0de  other.exe\n${sha256(real)}  yt-dlp.exe\n`)
      exeUrls.push(url)
      return bytesResponse(exeUrls.length === 1 ? 'corrupted' : real)
    }
    const dest = await downloadYtDlp(cfg, { fetchImpl, onProgress: (e) => events.push(e) })

    assert.deepEqual(exeUrls, [mirrors[0], mirrors[1]], '第一个镜像内容不符后必须换第二个镜像')
    assert.equal(sha256(await readFile(dest)), sha256(real))
    assert.deepEqual(
      await readdir(join(dir, 'bin')),
      ['yt-dlp.exe'],
      'bin 里只能有已校验的成品，不能留 .tmp-* 或可疑文件',
    )

    assert.deepEqual(
      events.map((e) => [e.phase, e.url]),
      [
        ['download', mirrors[0]],
        ['download', mirrors[1]],
        ['download', mirrors[1]],
      ],
      '每次尝试前报一次、成功后报一次',
    )
    const done = events.at(-1)
    assert.equal(done.done, true)
    assert.equal(done.bytes, real.length)
    assert.equal(done.verified, true)
    assert.ok(
      events.slice(0, -1).every((e) => e.done === undefined),
      '尝试中的事件不能提前报 done',
    )
  })
})

test('全部镜像内容都不符时拒绝，且 bin 里不留任何文件（含 .tmp-*）', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    const expected = sha256('expected content')
    const fetchImpl = async (url) =>
      url.endsWith('SHA2-256SUMS') ? bytesResponse(`${expected}  yt-dlp.exe\n`) : bytesResponse('corrupted')

    await assert.rejects(
      () => downloadYtDlp(cfg, { fetchImpl }),
      (err) => err.code === 'YTDLP_DOWNLOAD_FAILED',
    )

    const left = await readdir(dir, { recursive: true })
    assert.deepEqual(
      left.filter((p) => p.includes('.tmp-')),
      [],
      '失败路径不能留临时文件',
    )
    assert.equal(
      existsSync(join(dir, 'bin', 'yt-dlp.exe')),
      false,
      '最终路径绝不能出现未校验的二进制',
    )
    assert.deepEqual(await readdir(join(dir, 'bin')), [])
  })
})

test('镜像 HTTP 500 时换下一个镜像', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    const mirrors = YTDLP_MIRRORS()
    const real = Buffer.from('ok binary')
    const seen = []
    const fetchImpl = async (url) => {
      if (url.endsWith('SHA2-256SUMS')) return bytesResponse(`${sha256(real)}  yt-dlp.exe\n`)
      seen.push(url)
      return seen.length === 1
        ? { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }
        : bytesResponse(real)
    }
    const dest = await downloadYtDlp(cfg, { fetchImpl })
    assert.deepEqual(seen, [mirrors[0], mirrors[1]])
    assert.equal(await readFile(dest, 'utf8'), 'ok binary')
  })
})

test('就位失败时清掉临时文件并继续下一个镜像', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    const real = Buffer.from('ok binary')
    // 把最终路径先占成目录：Windows 上 rename(file → 已存在目录) 抛 EPERM，
    // 用来复现「内容已校验、却在就位那一步失败」这条路径。
    mkdirSync(join(dir, 'bin', 'yt-dlp.exe'), { recursive: true })
    const fetchImpl = async (url) =>
      url.endsWith('SHA2-256SUMS') ? bytesResponse(`${sha256(real)}  yt-dlp.exe\n`) : bytesResponse(real)

    await assert.rejects(
      () => downloadYtDlp(cfg, { fetchImpl }),
      (err) => err.code === 'YTDLP_DOWNLOAD_FAILED',
    )

    const left = await readdir(dir, { recursive: true })
    assert.deepEqual(
      left.filter((p) => p.includes('.tmp-')),
      [],
      '就位失败必须清掉临时文件，否则 bin 目录会积一堆 .tmp-* 垃圾',
    )
    assert.deepEqual(await readdir(join(dir, 'bin', 'yt-dlp.exe')), [], '就差最后一步重命名，不能有字节落进去')
  })
})

test('最终路径已有只读成品时，失败的下载不改动它也不留临时文件', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    const dest = join(dir, 'bin', 'yt-dlp.exe')
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(dest, 'ORIGINAL-BINARY')
    chmodSync(dest, 0o444) // 只读属性：模拟 AV/索引器占用最终路径
    try {
      const real = Buffer.from('ok binary')
      const fetchImpl = async (url) =>
        url.endsWith('SHA2-256SUMS') ? bytesResponse(`${sha256(real)}  yt-dlp.exe\n`) : bytesResponse(real)

      await assert.rejects(
        () => downloadYtDlp(cfg, { fetchImpl }),
        (err) => err.code === 'YTDLP_DOWNLOAD_FAILED',
      )

      assert.equal(await readFile(dest, 'utf8'), 'ORIGINAL-BINARY', '失败的下载绝不能毁掉已有的可用成品')
      const left = await readdir(dir, { recursive: true })
      assert.deepEqual(
        left.filter((p) => p.includes('.tmp-')),
        [],
      )
    } finally {
      chmodSync(dest, 0o666) // 让 withDir 的清理能删掉它
    }
  })
})

test('中途被中止时抛中止原因，不当作镜像失败继续重试', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    const ac = new AbortController()
    let calls = 0
    const fetchImpl = async (url) => {
      calls += 1
      if (url.endsWith('SHA2-256SUMS')) return bytesResponse(`${sha256('x')}  yt-dlp.exe\n`)
      ac.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    await assert.rejects(
      () => downloadYtDlp(cfg, { fetchImpl, signal: ac.signal }),
      (err) => err.name === 'AbortError',
    )
    assert.equal(calls, 2, '中止之后不该再试后面的镜像')
  })
})

test('SHA2-256SUMS 拿不到时不致命：不校验照样下载，但以 verified:false 明确上报', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    const events = []
    const fetchImpl = async (url) =>
      url.endsWith('SHA2-256SUMS') ? { ok: false, status: 404 } : bytesResponse('unverified binary')
    const dest = await downloadYtDlp(cfg, { fetchImpl, onProgress: (e) => events.push(e) })
    assert.equal(await readFile(dest, 'utf8'), 'unverified binary')
    const done = events.at(-1)
    assert.equal(done.verified, false, '没有校验源时必须自曝其短，不能假装校验过了')
    assert.match(done.note, /SHA2-256SUMS/)
  })
})

test('全部失败时 hint 列出每个镜像、失败原因与手工放置路径', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    const err = await downloadYtDlp(cfg, { fetchImpl: async () => ({ ok: false, status: 503 }) }).catch((e) => e)
    assert.equal(err.name, 'BiliDigestError')
    assert.equal(err.code, 'YTDLP_DOWNLOAD_FAILED')
    for (const url of YTDLP_MIRRORS()) {
      assert.ok(err.hint.includes(url), `hint 必须列出镜像 ${url}`)
    }
    assert.ok(err.hint.includes('503'), 'hint 必须带上失败原因')
    assert.ok(err.hint.includes('SHA2-256SUMS'), '拿不到校验和也要说出来')
    assert.ok(err.hint.includes(join(dir, 'bin', 'yt-dlp.exe')), 'hint 必须给出手工放置路径')
  })
})

test('已中止的 signal 不发起任何请求，也不吞成 YTDLP_DOWNLOAD_FAILED', async () => {
  await withDir(async (dir) => {
    const cfg = resolveConfig({ cacheDir: dir })
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return bytesResponse('x')
    }
    await assert.rejects(
      () => downloadYtDlp(cfg, { fetchImpl, signal: AbortSignal.abort() }),
      (err) => err.name === 'AbortError',
    )
    assert.equal(calls, 0, '已中止时一个请求都不该发')
  })
})

test('cacheDir 为空时 downloadYtDlp 拒绝为 BAD_CONFIG（绝不往 cwd 落二进制）', async () => {
  await assert.rejects(
    () => downloadYtDlp(resolveConfig({}), { fetchImpl: async () => bytesResponse('x') }),
    (err) => err.code === 'BAD_CONFIG',
  )
})
