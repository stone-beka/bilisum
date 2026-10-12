import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './cache.js'
import { compact } from './json.js'

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/** `YYYYMMDD-HHmmss-XXXXXX`，用于日志与「拿 jobId 回来查」的收据。 */
function newId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

const nowIso = () => new Date().toISOString()

/**
 * 作业注册表。串行执行、状态落盘、重启可查。
 *
 * 串行是硬要求，不是优化：SenseVoice 推理峰值内存按 GB 计（规格 F19），
 * 并发会把机器打爆。作业制本身是为了绕开工具/命令的超时（规格 F22）。
 *
 * 会话可见性说明：`get()`/`list()` 是同步的，而 Node 没有任何办法把异步 I/O 的
 * 结果同步取出来，所以历史作业必须在构造函数返回前就进内存——磁盘扫描是
 * **同步**做的（只读 jobs 目录下一层的小 job.json，不碰日志与音频）。
 * 这样 `new Registry(dir)` 之后立刻 `get(id)` 才看得见历史记录。
 */
export class Registry {
  #root
  #logger
  #jobs = new Map()
  #queue = []
  #active = null
  #controller = null
  #disposed = false
  /** 串行化所有状态变更，避免 cancel 与作业收尾交错写同一条记录。 */
  #ops = Promise.resolve()

  constructor(root, logger) {
    this.#root = root
    this.#logger = logger
    this.#readFromDisk()
  }

  /** 历史作业已在构造时读回；此方法保留给显式调用方，可安全重复调用。 */
  async load() {}

  list() {
    return [...this.#jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  get(id) {
    return this.#jobs.get(id)
  }

  /**
   * 登记并排队一个作业，立即返回快照。作业体 `run(job, signal)` 串行执行。
   * 快照是活对象：`wait()` 轮询它就能看到终态。
   */
  async start({ url, options = {}, run }) {
    const at = nowIso()
    const job = compact({
      id: newId(),
      status: 'queued',
      phase: 'queued',
      url,
      options,
      createdAt: at,
      updatedAt: at,
      phases: [{ phase: 'queued', at }],
    })
    this.#jobs.set(job.id, job)
    // 释放之后泵不会再起作业，直接落终态：否则这个作业会永远挂在 queued 上
    if (this.#disposed) {
      job.status = 'cancelled'
      job.phases.push(compact({ phase: 'cancelled', detail: '注册表已释放', at }))
    } else {
      this.#queue.push({ job, run })
    }
    await this.#persist(job)
    this.#pump()
    return job
  }

  /** 记录阶段推进。终态作业不再改（避免把 done 又拉回 running）。 */
  async setPhase(id, phase, detail) {
    const job = this.#jobs.get(id)
    if (!job || TERMINAL.has(job.status)) return
    job.phase = phase
    job.updatedAt = nowIso()
    job.phases.push(compact({ phase, detail, at: job.updatedAt }))
    await this.#persist(job)
  }

  /**
   * 取消作业。在跑的走 abort（真正的中止由作业体对 signal 的响应决定），
   * 排队的直接落到 cancelled。返回当前快照。
   */
  cancel(id) {
    return this.#enqueue(async () => {
      const job = this.#jobs.get(id)
      if (!job || TERMINAL.has(job.status)) return job
      job.updatedAt = nowIso()
      if (this.#active?.job.id === id) {
        this.#controller?.abort(new Error('已取消'))
      } else {
        this.#queue = this.#queue.filter((item) => item.job.id !== id)
        job.status = 'cancelled'
        await this.#persist(job)
      }
      return job
    })
  }

  /**
   * 至多等 `waitSeconds` 秒。超时不抛错，返回运行中的快照——命令层据此回
   * 一张「拿这个 jobId 稍后再来」的收据（规格 F22）。
   */
  async wait(id, waitSeconds = 0, signal) {
    const seconds = Number.isFinite(waitSeconds) ? Math.max(0, waitSeconds) : 0
    const deadline = Date.now() + seconds * 1000
    for (;;) {
      const job = this.#jobs.get(id)
      if (!job) return undefined
      if (TERMINAL.has(job.status)) return job
      if (signal?.aborted) return job
      if (Date.now() >= deadline) return job
      await delay(Math.min(50, Math.max(1, deadline - Date.now())))
    }
  }

  /**
   * 中止在跑的作业并等它收尾（`ctx.effect` 的清理会调这里）。
   * 反复调用安全：第一次之后不再有作业能起来。
   */
  async dispose() {
    this.#disposed = true
    for (const item of this.#queue) {
      if (!TERMINAL.has(item.job.status)) {
        item.job.status = 'cancelled'
        item.job.updatedAt = nowIso()
      }
    }
    this.#queue = []
    this.#controller?.abort(new Error('插件已卸载'))
    while (this.#active) await delay(10)
  }

  /**
   * 串行泵：一次只跑一个作业。`#active` 在第一次 await 之前就落定，
   * 所以同步跟进的 `dispose()` 一定能看见在跑的作业。
   */
  async #pump() {
    if (this.#active || this.#disposed) return
    const item = this.#queue.shift()
    if (!item) return
    const { job, run } = item
    const controller = new AbortController()
    this.#active = item
    this.#controller = controller
    job.status = 'running'
    job.updatedAt = nowIso()
    await this.#persist(job)
    try {
      const result = await run(job, controller.signal)
      if (controller.signal.aborted) {
        job.status = 'cancelled'
      } else {
        job.status = 'done'
        job.result = compact(result)
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      job.status = aborted ? 'cancelled' : 'failed'
      job.error = compact({
        code: aborted ? 'CANCELLED' : (err?.code ?? 'JOB_FAILED'),
        message: err instanceof Error ? err.message : String(err),
        hint: err?.hint,
      })
    } finally {
      job.updatedAt = nowIso()
      await this.#persist(job)
      if (this.#active === item) {
        this.#active = null
        this.#controller = null
      }
      void this.#pump().catch((err) => this.#log(`作业泵异常: ${err?.message ?? err}`))
    }
  }

  /** 落盘失败不能让作业失败：作业的正确性不依赖磁盘，只记一条 warn。 */
  async #persist(job) {
    try {
      await writeJsonAtomic(join(this.#root, 'jobs', job.id, 'job.json'), compact(job))
    } catch (err) {
      this.#log(`作业落盘失败 ${job.id}: ${err?.message ?? err}`)
    }
  }

  /** 读回磁盘上的历史作业；目录不存在（首次运行）就当空处理。 */
  #readFromDisk() {
    let names = []
    try {
      names = readdirSync(join(this.#root, 'jobs'))
    } catch {
      return
    }
    for (const name of names) {
      const job = this.#readJobFile(join(this.#root, 'jobs', name, 'job.json'))
      if (!job || typeof job.id !== 'string' || this.#jobs.has(job.id)) continue
      // 上次进程死掉留下的 running/queued 一律视为已中断：进程没了就不可能还在跑
      if (!TERMINAL.has(job.status)) {
        job.status = 'failed'
        job.updatedAt = nowIso()
        job.error = { code: 'INTERRUPTED', message: '进程重启，作业已中断' }
      }
      this.#jobs.set(job.id, job)
    }
  }

  /** 半截/损坏的记录（第二次修改前 kill 掉的进程）直接跳过，不让它毁掉整个列表。 */
  #readJobFile(file) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  #log(message) {
    this.#logger?.warn?.(`bili-digest: ${message}`)
  }

  /** 所有异步状态变更排到同一条链上，顺序执行。 */
  #enqueue(fn) {
    const next = this.#ops.then(fn, fn)
    this.#ops = next.then(
      () => {},
      () => {},
    )
    return next
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
