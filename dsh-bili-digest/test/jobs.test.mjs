import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from '../src/jobs.js'
import { writeJsonAtomic } from '../src/cache.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withRegistry(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'))
  const reg = new Registry(dir)
  try {
    await fn(reg, dir)
  } finally {
    await reg.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

test('作业完成后 status 为 done 且带 result', async () => {
  await withRegistry(async (reg) => {
    const job = await reg.start({ url: 'u', options: {}, run: async () => ({ ok: 1 }) })
    const done = await reg.wait(job.id, 5)
    assert.equal(done.status, 'done')
    assert.deepEqual(done.result, { ok: 1 })
  })
})

test('作业抛错时 status 为 failed 且带 error 信息', async () => {
  await withRegistry(async (reg) => {
    const job = await reg.start({ url: 'u', options: {}, run: async () => { throw new Error('boom') } })
    const done = await reg.wait(job.id, 5)
    assert.equal(done.status, 'failed')
    assert.match(done.error.message, /boom/)
  })
})

test('wait 超时返回运行中的快照而不是抛错', async () => {
  await withRegistry(async (reg) => {
    const job = await reg.start({ url: 'u', options: {}, run: async () => { await sleep(300); return 1 } })
    const snap = await reg.wait(job.id, 0)
    assert.equal(snap.status, 'running')
  })
})

test('作业串行执行，第二个在前一个结束后才开始', async () => {
  await withRegistry(async (reg) => {
    const order = []
    const a = await reg.start({ url: 'a', options: {}, run: async () => { order.push('a-start'); await sleep(80); order.push('a-end') } })
    const b = await reg.start({ url: 'b', options: {}, run: async () => { order.push('b-start') } })
    await reg.wait(a.id, 5)
    await reg.wait(b.id, 5)
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start'])
  })
})

test('cancel 后 status 为 cancelled', async () => {
  await withRegistry(async (reg) => {
    const job = await reg.start({ url: 'u', options: {}, run: (j, signal) => new Promise((_, rej) => {
      signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
    }) })
    await sleep(30)
    reg.cancel(job.id)
    const done = await reg.wait(job.id, 5)
    assert.equal(done.status, 'cancelled')
  })
})

test('dispose 中止在跑作业', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'))
  const reg = new Registry(dir)
  const job = await reg.start({ url: 'u', options: {}, run: (j, signal) => new Promise((_, rej) => {
    signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
  }) })
  await sleep(30)
  await reg.dispose()
  assert.equal(reg.get(job.id).status, 'cancelled')
  await rm(dir, { recursive: true, force: true })
})

test('setPhase 记录阶段序列', async () => {
  await withRegistry(async (reg) => {
    const job = await reg.start({ url: 'u', options: {}, run: async (j) => {
      await reg.setPhase(j.id, 'probe')
      await reg.setPhase(j.id, 'audio')
      return 1
    } })
    const done = await reg.wait(job.id, 5)
    assert.deepEqual(done.phases.map((p) => p.phase), ['queued', 'probe', 'audio'])
  })
})

test('作业状态落盘，新 Registry 实例可读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'))
  const reg = new Registry(dir)
  const job = await reg.start({ url: 'u', options: {}, run: async () => ({ v: 7 }) })
  await reg.wait(job.id, 5)
  await reg.dispose()
  const reg2 = new Registry(dir)
  await reg2.load()
  assert.deepEqual(reg2.get(job.id).result, { v: 7 })
  await rm(dir, { recursive: true, force: true })
})

test('load() 读回磁盘上的全部作业', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'))
  const reg = new Registry(dir)
  const job = await reg.start({ url: 'u', options: {}, run: async () => 1 })
  await reg.wait(job.id, 5)
  await reg.dispose()
  const reg2 = new Registry(dir)
  await reg2.load()
  await reg2.load() // 幂等：重复读盘不得产生重复条目
  assert.equal(reg2.list().length, 1)
  assert.equal(reg2.list()[0].id, job.id)
  await rm(dir, { recursive: true, force: true })
})

test('options 与 result 里的 undefined 在落盘前就被剥掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'))
  const reg = new Registry(dir)
  const job = await reg.start({ url: 'u', options: { keep: 1, drop: undefined }, run: async () => ({ ok: 1, missing: undefined }) })
  await reg.wait(job.id, 5)
  await reg.dispose()
  const raw = JSON.parse(await readFile(join(dir, 'jobs', job.id, 'job.json'), 'utf8'))
  assert.equal(raw.options.keep, 1)
  assert.equal('drop' in raw.options, false)
  assert.equal('missing' in raw.result, false)
  await rm(dir, { recursive: true, force: true })
})

test('cancel 同步返回作业对象或 undefined（契约：Job|undefined）', async () => {
  await withRegistry(async (reg) => {
    const job = await reg.start({ url: 'u', options: {}, run: async () => 1 })
    const cancelled = reg.cancel(job.id)
    assert.ok(!(cancelled instanceof Promise), 'cancel 必须同步返回，不能返回 Promise')
    assert.equal(cancelled.id, job.id)
    assert.equal(reg.cancel('no-such-id'), undefined)
  })
})

test('作业 id 钉死为 YYYYMMDD-HHmmss-XXXXXX（短随机串补零）', async () => {
  const realRandom = Math.random
  // (0.5).toString(36) === '0.i'，后缀只剩 1 位；不补零就凑不满 6 位。
  Math.random = () => 0.5
  try {
    await withRegistry(async (reg) => {
      const job = await reg.start({ url: 'u', options: {}, run: async () => 1 })
      assert.match(job.id, /^\d{8}-\d{6}-[0-9a-z]{6}$/)
      assert.equal(job.id.slice(-6), 'i00000')
    })
  } finally {
    Math.random = realRandom
  }
})

test('list() 在同一秒创建的作业间也按 id 倒序（决定性排序）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'))
  const reg = new Registry(dir)
  const at = '2026-10-12T14:00:00.000Z'
  const record = (id) => ({ id, status: 'done', phase: 'done', url: 'u', options: {}, createdAt: at, updatedAt: at, phases: [] })
  // createdAt 完全相同；目录名（=读盘顺序）与 id 逆序，只看时间的排序会露馅。
  for (const [name, id] of [
    ['slot-a', '20261012-140000-aaa003'],
    ['slot-b', '20261012-140000-aaa002'],
    ['slot-c', '20261012-140000-aaa001'],
  ]) {
    await writeJsonAtomic(join(dir, 'jobs', name, 'job.json'), record(id))
  }
  await reg.load()
  assert.deepEqual(
    reg.list().map((j) => j.id),
    ['20261012-140000-aaa003', '20261012-140000-aaa002', '20261012-140000-aaa001'],
  )
  await rm(dir, { recursive: true, force: true })
})

test('dispose 把排队作业按 cancelled 落盘，重启后读回仍是 cancelled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'))
  const reg = new Registry(dir)
  // 第一个作业不响应 abort 前占住泵，第二个只会待在队列里
  let began
  const started = new Promise((r) => { began = r })
  const running = await reg.start({ url: 'a', options: {}, run: (j, signal) => {
    began()
    return new Promise((_, rej) => {
      signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
    })
  } })
  await started // 等 run 真的挂上 abort 监听，否则 dispose 可能抢在它之前
  const queued = await reg.start({ url: 'b', options: {}, run: async () => 1 })
  assert.equal(queued.status, 'queued')
  await reg.dispose()
  assert.equal(reg.get(queued.id).status, 'cancelled')
  const reg2 = new Registry(dir)
  await reg2.load()
  assert.equal(reg2.get(queued.id).status, 'cancelled')
  assert.equal(reg2.get(running.id).status, 'cancelled')
  await rm(dir, { recursive: true, force: true })
})

test('dispose 之后 start 的作业直接落 cancelled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'))
  const reg = new Registry(dir)
  await reg.dispose()
  const job = await reg.start({ url: 'u', options: {}, run: async () => 1 })
  assert.equal(reg.get(job.id).status, 'cancelled')
  await rm(dir, { recursive: true, force: true })
})

test('宿主 logger 抛错不会把异常泄漏成作业失败或未处理拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-'))
  const blocked = join(dir, 'blocked')
  await writeFile(blocked, 'not a directory')
  // root 指向一个普通文件：落盘必定失败，于是必然走到 logger.warn
  const reg = new Registry(blocked, { warn() { throw new Error('logger boom') } })
  const job = await reg.start({ url: 'u', options: {}, run: async () => 1 })
  assert.equal((await reg.wait(job.id, 5)).status, 'done')
  await rm(dir, { recursive: true, force: true })
})
