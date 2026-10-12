# dsh-bili-digest P0 实施计划（本地全链路）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/bilisum <B站链接>` 在 DSH 里跑通完整本地链路：yt-dlp 取音频 → ffmpeg 转 16k PCM → 静音点对齐切窗 → 本地 SenseVoice 逐窗识别 → LLM 总结与章节划分 → 落盘 Markdown。

**Architecture:** 一个 DSH Cordis 插件（Host 单半身），注册一个斜杠命令。流水线分 11 个阶段，每阶段产物落盘可复用。长任务走作业制：命令等在 `waitSeconds` 内完成，否则返回 `jobId` 供 `status` 查询。

**Tech Stack:** Node.js ≥20（ESM，`node --test`）、yt-dlp.exe、ffmpeg.exe（`@ffmpeg-installer/win32-x64`）、DSH 的 `ctx.speechToText`（SenseVoice 本地识别）、`ctx.llm`。

**设计规格：** [`docs/superpowers/specs/2026-10-12-dsh-bili-digest-design.md`](../specs/2026-10-12-dsh-bili-digest-design.md)

## Global Constraints

以下约束适用于**每一个**任务，不再逐条重复：

- **零 `@deepseek-ai/*` import。** 服务只用 `ctx.get(name)` 按结构调用。规格 F11。
- **所有子进程的 env 一律由 `childEnv()` 构造**，绝不直接继承 `process.env`。规格 F25/F26。
- **所有对外返回值过 `compact()`**，剥离 `undefined`。规格 F21。
- **命令 handler 绝不抛异常**，一律转成 `{ kind:'error', text }`。
- 包为 ESM（`"type": "module"`），只 import `node:` 内置模块。
- 时间单位统一用**秒**（浮点）；只有配置文件里写成 `windowSeconds` 这类带单位后缀的名字。
- Segment 形状固定为 `{ start: number, end: number, text: string }`（秒）。
- 所有文件写入走「临时文件 + rename」。
- 测试用 `node --test`，断言用 `node:assert/strict`。
- 每个任务结束时必须：`node --test test/` 全绿 → `git commit`。
- 平台目标为 Windows x64；路径一律用 `node:path` 拼接。
- **不实现**（P0 范围外）：字幕通路、UP 主章节对照、L2 证据源、缓存 LRU、map-reduce。

---

## 文件结构

```
dsh-bili-digest/
├── package.json              # 包元数据 + dsh.bundle.patch
├── cordis.patch.yml          # 挂载 Host 半身
├── index.js                  # apply(ctx, config)：命令注册 + 生命周期
├── src/
│   ├── config.js             # resolveConfig()：手写默认值与越界校验
│   ├── errors.js             # BiliDigestError + 错误码
│   ├── json.js               # compact()：无损 JSON 出口
│   ├── jobs.js               # Registry：作业注册表
│   ├── cache.js              # 缓存路径与原子读写
│   ├── evidence.js           # 证据包组装
│   ├── pipeline.js           # 阶段编排
│   ├── media/
│   │   ├── url.js            # URL/BV/分P 归一化
│   │   ├── tools.js          # 外部工具定位 / 下载 / childEnv
│   │   ├── ytdlp.js          # yt-dlp 子进程封装
│   │   └── ffmpeg.js         # 唯一解码点
│   ├── audio/
│   │   └── window.js         # 规范 WAV + planSegments
│   ├── asr/
│   │   ├── sensevoice.js     # ctx.speechToText 适配
│   │   └── index.js          # 转写后端选择
│   ├── digest/
│   │   ├── prompt.js         # 系统提示词 + JSON 契约
│   │   ├── llm.js            # ctx.llm 调用与 JSON 解析
│   │   └── validate.js       # 章节校验与边界吸附
│   └── render/
│       └── markdown.js       # Markdown 渲染
└── test/
    ├── fixtures/
    └── *.test.mjs
```

**边界原则**：`media/ffmpeg.js` 是唯一的解码点；`audio/window.js` 是唯一知道规范 WAV 长什么样的地方；`media/tools.js` 是唯一构造子进程环境的地方；`evidence.js` 是唯一的证据聚合点。改动这些模块之外的地方不得触碰它们对应的知识。

---

## Task 1: 包骨架 + 无损 JSON 出口

**Files:**
- Create: `package.json`
- Create: `cordis.patch.yml`
- Create: `src/json.js`
- Create: `test/json.test.mjs`
- Create: `.gitignore`

**Interfaces:**
- Consumes: 无
- Produces: `compact(value): value` —— 递归剥离对象里的 `undefined`；数组保序、逐项处理；`null` 保留；其它类型原样返回。

- [ ] **Step 1: 建包骨架**

`package.json`：

```json
{
  "name": "dsh-bili-digest",
  "version": "0.1.0",
  "description": "DeepSeek Harness 插件：B站视频 → 带时间戳文稿 → AI 重点总结与章节划分",
  "type": "module",
  "license": "MIT",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "src", "cordis.patch.yml", "THIRD_PARTY_NOTICES.md"],
  "scripts": {
    "test": "node --test test/",
    "check": "node --check index.js"
  },
  "engines": { "node": ">=20" },
  "keywords": ["dsh", "dsh-plugin", "deepseek-harness", "cordis", "bilibili", "transcribe"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
# dsh-bili-digest 的 bundle patch：插入唯一一行 Host 插件。
# profile 侧可按需覆盖 config。
- insert:
    - id: bili-digest
      name: 'dsh-bili-digest'
      config:
        cacheDir: !!js dshCachePath('bili-digest')
```

`.gitignore`：

```
node_modules/
*.log
bili-digest/
.scratch/
```

- [ ] **Step 2: 写失败测试**

`test/json.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { compact } from '../src/json.js'

test('compact 剥离顶层 undefined 键', () => {
  assert.deepEqual(compact({ a: 1, b: undefined }), { a: 1 })
})

test('compact 递归处理嵌套对象', () => {
  assert.deepEqual(
    compact({ a: { b: undefined, c: 2 }, d: [{ e: undefined, f: 3 }] }),
    { a: { c: 2 }, d: [{ f: 3 }] },
  )
})

test('compact 保留 null 与 false 与 0 与空串', () => {
  assert.deepEqual(compact({ a: null, b: false, c: 0, d: '' }), { a: null, b: false, c: 0, d: '' })
})

test('compact 保持数组顺序与长度', () => {
  assert.deepEqual(compact([1, undefined, 2]), [1, undefined, 2])
})

test('compact 原样返回标量', () => {
  assert.equal(compact(5), 5)
  assert.equal(compact('x'), 'x')
  assert.equal(compact(null), null)
})

test('compact 不修改入参', () => {
  const input = { a: 1, b: undefined }
  compact(input)
  assert.equal('b' in input, true)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/json.test.mjs`
Expected: FAIL —— `Cannot find module '../src/json.js'`

- [ ] **Step 4: 写最小实现**

`src/json.js`：

```js
/**
 * 无损 JSON 出口。
 *
 * DSH 宿主对工具/命令返回值做**运行时**无损 JSON 校验：一个值为 undefined 的键
 * 会让整次调用被判 `value is not lossless JSON` 而拒收。单测里假的 register
 * 不会校验，所以规则是「所有出口统一过 compact()」，而不是在每个构造点记得删字段。
 *
 * 数组里的 undefined 会被 JSON.stringify 转成 null，属合法 JSON，故保留不删——
 * 删元素会破坏下标语义。
 */

/**
 * 递归剥离对象中值为 undefined 的键。
 * @param value 任意值
 * @returns 剥离后的新值；标量原样返回
 */
export function compact(value) {
  if (Array.isArray(value)) return value.map((item) => compact(item))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = compact(item)
    }
    return out
  }
  return value
}
```

- [ ] **Step 5: 跑测试确认通过并提交**

Run: `node --test test/json.test.mjs`
Expected: PASS，6 个用例全绿

```bash
git add package.json cordis.patch.yml .gitignore src/json.js test/json.test.mjs
git commit -m "feat(bili-digest): 包骨架与无损 JSON 出口"
```

---

## Task 2: 错误分类 + 配置校验

**Files:**
- Create: `src/errors.js`
- Create: `src/config.js`
- Create: `test/errors.test.mjs`
- Create: `test/config.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class BiliDigestError extends Error`，构造签名 `new BiliDigestError(code, message, hint?, cause?)`；字段 `code / hint / cause`；`String(err)` 为 `message`。
  - `toCommandError(err): { kind:'error', text:string }`
  - `resolveConfig(raw = {}): Config` —— 越界抛 `BAD_CONFIG`
  - Config 字段与默认值（见下表）

- [ ] **Step 1: 写失败测试**

`test/errors.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { BiliDigestError, toCommandError } from '../src/errors.js'

test('BiliDigestError 携带 code 与 hint', () => {
  const e = new BiliDigestError('BAD_INPUT', '坏输入', '请贴完整链接')
  assert.equal(e.code, 'BAD_INPUT')
  assert.equal(e.message, '坏输入')
  assert.equal(e.hint, '请贴完整链接')
  assert.ok(e instanceof Error)
})

test('toCommandError 输出错误结果并包含 hint', () => {
  const r = toCommandError(new BiliDigestError('BAD_INPUT', '坏输入', '请贴完整链接'))
  assert.equal(r.kind, 'error')
  assert.match(r.text, /坏输入/)
  assert.match(r.text, /请贴完整链接/)
})

test('toCommandError 对非 BiliDigestError 兜底', () => {
  const r = toCommandError(new Error('boom'))
  assert.equal(r.kind, 'error')
  assert.match(r.text, /boom/)
})

test('toCommandError 对非 Error 值兜底', () => {
  const r = toCommandError('字符串错误')
  assert.equal(r.kind, 'error')
  assert.match(r.text, /字符串错误/)
})
```

`test/config.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { BiliDigestError } from '../src/errors.js'

test('空配置产出全部默认值', () => {
  const c = resolveConfig()
  assert.equal(c.command, 'bilisum')
  assert.equal(c.windowSeconds, 30)
  assert.equal(c.snapSeconds, 1.5)
  assert.equal(c.audioQuality, 'balanced')
  assert.equal(c.proxy, '')
  assert.equal(c.toolDownloadProxy, 'system')
  assert.equal(c.waitSeconds, 45)
  assert.equal(c.keepTranscript, true)
})

test('windowSeconds 上限 60（F19：120 秒已进入衰退区）', () => {
  assert.equal(resolveConfig({ windowSeconds: 60 }).windowSeconds, 60)
  assert.throws(() => resolveConfig({ windowSeconds: 120 }), (e) => e.code === 'BAD_CONFIG')
  assert.throws(() => resolveConfig({ windowSeconds: 20 }), (e) => e.code === 'BAD_CONFIG')
})

test('audioQuality 只接受三个枚举值', () => {
  assert.equal(resolveConfig({ audioQuality: 'smallest' }).audioQuality, 'smallest')
  assert.throws(() => resolveConfig({ audioQuality: 'ultra' }), (e) => e.code === 'BAD_CONFIG')
})

test('未知配置键被拒绝', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), (e) => e.code === 'BAD_CONFIG')
})

test('cacheDir 为空时由调用方补默认值，resolveConfig 不碰文件系统', () => {
  assert.equal(resolveConfig().cacheDir, '')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/errors.test.mjs test/config.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/errors.js`：

```js
/** dsh-bili-digest 的分类错误。hint 是给用户看的中文补救建议。 */
export class BiliDigestError extends Error {
  /**
   * @param code 见 spec §9 的错误码
   * @param message 给开发者看的描述
   * @param hint 给用户看的补救建议
   * @param cause 原始错误
   */
  constructor(code, message, hint, cause) {
    super(message)
    this.name = 'BiliDigestError'
    this.code = code
    this.hint = hint
    this.cause = cause
  }
}

/**
 * 把任意抛出物转成命令的 error 结果。命令 handler 绝不抛异常到宿主。
 * @param err 任意抛出物
 * @returns {{ kind:'error', text:string }}
 */
export function toCommandError(err) {
  if (err instanceof BiliDigestError) {
    const text = err.hint ? `❌ ${err.message}\n${err.hint}` : `❌ ${err.message}`
    return { kind: 'error', text }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { kind: 'error', text: `❌ ${message}` }
}
```

`src/config.js`：

```js
import { BiliDigestError } from './errors.js'

const AUDIO_QUALITY = ['balanced', 'smallest', 'best']
const LANGS = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** 每个字段的校验：返回 null 表示通过，否则返回中文问题描述。 */
const VALIDATORS = {
  command: (v) => (/^[a-z][a-z0-9_-]*$/.test(v) ? null : '必须是小写字母开头的命令名'),
  outputDir: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  cacheDir: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  language: (v) => (LANGS.includes(v) ? null : `必须是 ${LANGS.join('/')} 之一`),
  preferredSubtitleLang: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  windowSeconds: (v) => (v >= 30 && v <= 60 ? null : '必须是 30–60 之间的数字（上限 60 是实测结论，见规格 F19）'),
  snapSeconds: (v) => (v >= 0 && v <= 5 ? null : '必须是 0–5 之间的数字'),
  minSegmentSeconds: (v) => (v >= 1 && v <= 30 ? null : '必须是 1–30 之间的数字'),
  audioQuality: (v) => (AUDIO_QUALITY.includes(v) ? null : `必须是 ${AUDIO_QUALITY.join('/')} 之一`),
  proxy: (v) => (typeof v === 'string' ? null : '必须是字符串：空串=直连，system=跟随系统，其它=代理 URL'),
  toolDownloadProxy: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  ytDlpPath: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  ffmpegPath: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  sttProvider: (v) => (typeof v === 'string' ? null : '必须是字符串'),
  summaryModel: (v) =>
    v && typeof v === 'object' && typeof v.provider === 'string' && typeof v.model === 'string'
      ? null
      : '必须是 { provider: string, model: string }',
  waitSeconds: (v) => (v >= 0 && v <= 120 ? null : '必须是 0–120 之间的数字'),
  maxDurationSec: (v) => (v >= 60 ? null : '必须 >= 60'),
  maxKeyPoints: (v) => (v >= 3 && v <= 20 ? null : '必须是 3–20 之间的整数'),
  keepTranscript: (v) => (typeof v === 'boolean' ? null : '必须是布尔值'),
}

const DEFAULTS = {
  command: 'bilisum',
  outputDir: '',
  cacheDir: '',
  language: 'auto',
  preferredSubtitleLang: 'zh-Hans',
  windowSeconds: 30,
  snapSeconds: 1.5,
  minSegmentSeconds: 5,
  audioQuality: 'balanced',
  proxy: '',
  toolDownloadProxy: 'system',
  ytDlpPath: '',
  ffmpegPath: '',
  sttProvider: '',
  summaryModel: { provider: '', model: '' },
  waitSeconds: 45,
  maxDurationSec: 14400,
  maxKeyPoints: 8,
  keepTranscript: true,
}

/**
 * 归一化并校验配置。手写而非用 Schemastery：第三方插件不 import @deepseek-ai/*（规格 F11）。
 * @param raw profile 里的 config 对象
 * @returns 完整配置；越界抛 BAD_CONFIG
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BiliDigestError('BAD_CONFIG', '配置必须是一个对象', '检查 profile 的 cordis.patch.yml')
  }
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULTS)) {
      throw new BiliDigestError('BAD_CONFIG', `未知配置项：${key}`, `可用项：${Object.keys(DEFAULTS).join(', ')}`)
    }
  }
  const out = {}
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key] === undefined ? fallback : raw[key]
    const problem = VALIDATORS[key](value)
    if (problem) {
      throw new BiliDigestError('BAD_CONFIG', `配置项 ${key} 非法：${problem}`, `当前值：${JSON.stringify(value)}`)
    }
    // summaryModel 复制一份，避免调用方后续改动影响已解析配置
    out[key] = key === 'summaryModel' ? { provider: value.provider, model: value.model } : value
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/errors.test.mjs test/config.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/errors.js src/config.js test/errors.test.mjs test/config.test.mjs
git commit -m "feat(bili-digest): 错误分类与配置校验"
```

---

## Task 3: 缓存路径与原子读写

**Files:**
- Create: `src/cache.js`
- Create: `test/cache.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `cachePaths(cacheDir, bvid): { root, probe, segments, digest, audioM4s, audioWav, runLog, jobDir(jobId), jobFile(jobId), binDir, tmpDir }` —— 全部为绝对路径
  - `readJson(file): Promise<value|null>` —— 文件不存在或 JSON 非法都返回 `null`（不抛）
  - `writeJsonAtomic(file, value): Promise<void>`
  - `readTextIfExists(file): Promise<string|null>`

- [ ] **Step 1: 写失败测试**

`test/cache.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachePaths, readJson, writeJsonAtomic, readTextIfExists } from '../src/cache.js'

test('cachePaths 全部是绝对路径且以 bvid 分目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-'))
  const p = cachePaths(dir, 'BV1xx')
  assert.ok(p.probe.startsWith(dir))
  assert.match(p.probe, /BV1xx/)
  assert.equal(p.jobFile('j1').endsWith('job.json'), true)
  await rm(dir, { recursive: true, force: true })
})

test('writeJsonAtomic 后可读回，且临时文件不残留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-'))
  const f = join(dir, 'a.json')
  await writeJsonAtomic(f, { x: 1 })
  assert.deepEqual(await readJson(f), { x: 1 })
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(dir), ['a.json'])
  await rm(dir, { recursive: true, force: true })
})

test('readJson 对缺失文件返回 null 而不抛', async () => {
  assert.equal(await readJson(join(tmpdir(), 'definitely-missing-xyz.json')), null)
})

test('readJson 对非法 JSON 返回 null 而不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-'))
  const f = join(dir, 'bad.json')
  await writeFile(f, '{ not json')
  assert.equal(await readJson(f), null)
  await rm(dir, { recursive: true, force: true })
})

test('writeJsonAtomic 自动建父目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-'))
  const f = join(dir, 'deep', 'nested', 'a.json')
  await writeJsonAtomic(f, [1, 2])
  assert.deepEqual(await readJson(f), [1, 2])
  await rm(dir, { recursive: true, force: true })
})

test('readTextIfExists 对缺失文件返回 null', async () => {
  assert.equal(await readTextIfExists(join(tmpdir(), 'nope-abc.txt')), null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/cache.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/cache.js`：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/cache.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cache.js test/cache.test.mjs
git commit -m "feat(bili-digest): 缓存路径与原子读写"
```

---

## Task 4: 作业注册表

**Files:**
- Create: `src/jobs.js`
- Create: `test/jobs.test.mjs`

**Interfaces:**
- Consumes: `writeJsonAtomic` / `readJson`（Task 3）、`compact`（Task 1）
- Produces:
  - `class Registry`
    - `constructor(root, logger)` —— `root` 为 cacheDir；`logger` 可为 `undefined`
    - `start({ url, options, run }) : Promise<Job>` —— `run` 是 `(job, signal) => Promise<unknown>` 的作业体；**串行执行**；立即返回作业快照
    - `get(id) : Job|undefined`、`list() : Job[]`
    - `cancel(id) : Job|undefined`
    - `wait(id, waitSeconds, signal) : Promise<Job|undefined>` —— 至多等 `waitSeconds` 秒
    - `dispose() : Promise<void>` —— 中止全部在跑作业并等待收尾
    - `setPhase(id, phase, detail?) : Promise<void>`
  - Job 形状：`{ id, status:'queued'|'running'|'done'|'failed'|'cancelled', phase, url, options, createdAt, updatedAt, error?, result?, phases: [{ phase, at }] }`

- [ ] **Step 1: 写失败测试**

`test/jobs.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from '../src/jobs.js'

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
  assert.equal(reg2.list().length, 1)
  assert.equal(reg2.list()[0].id, job.id)
  await rm(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/jobs.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/jobs.js`：

```js
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './cache.js'
import { compact } from './json.js'

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

function newId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 作业注册表。串行执行、状态落盘、重启可查。
 *
 * 串行是硬要求，不是优化：SenseVoice 推理峰值内存按 GB 计（规格 F19），
 * 并发会把机器打爆。作业制本身是为了绕开工具/命令的超时（规格 F22）。
 */
export class Registry {
  #root
  #logger
  #jobs = new Map()
  #queue = []
  #active = null
  #controller = null
  #disposed = false

  constructor(root, logger) {
    this.#root = root
    this.#logger = logger
  }

  /** 从磁盘读回历史作业（不含在跑的，跑的也读不回来）。 */
  async load() {
    let names = []
    try {
      names = await readdir(join(this.#root, 'jobs'))
    } catch {
      return
    }
    for (const name of names) {
      const job = await readJson(join(this.#root, 'jobs', name, 'job.json'))
      if (!job || typeof job.id !== 'string' || this.#jobs.has(job.id)) continue
      // 上次进程死掉留下的 running/queued 一律视为已中断
      if (!TERMINAL.has(job.status)) {
        job.status = 'failed'
        job.error = { code: 'INTERRUPTED', message: '进程重启，作业已中断' }
      }
      this.#jobs.set(job.id, job)
    }
  }

  list() {
    return [...this.#jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  get(id) {
    return this.#jobs.get(id)
  }

  async start({ url, options = {}, run }) {
    const job = compact({
      id: newId(),
      status: 'queued',
      phase: 'queued',
      url,
      options,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phases: [{ phase: 'queued', at: new Date().toISOString() }],
    })
    this.#jobs.set(job.id, job)
    await this.#persist(job)
    this.#queue.push({ job, run })
    this.#pump()
    return job
  }

  async setPhase(id, phase, detail) {
    const job = this.#jobs.get(id)
    if (!job || TERMINAL.has(job.status)) return
    job.phase = phase
    job.updatedAt = new Date().toISOString()
    job.phases.push(compact({ phase, detail, at: job.updatedAt }))
    await this.#persist(job)
  }

  cancel(id) {
    const job = this.#jobs.get(id)
    if (!job || TERMINAL.has(job.status)) return job
    if (this.#active?.job.id === id) {
      this.#controller?.abort(new Error('已取消'))
    } else {
      this.#queue = this.#queue.filter((item) => item.job.id !== id)
      job.status = 'cancelled'
      job.updatedAt = new Date().toISOString()
      void this.#persist(job)
    }
    return job
  }

  async wait(id, waitSeconds, signal) {
    const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
    for (;;) {
      const job = this.#jobs.get(id)
      if (!job) return undefined
      if (TERMINAL.has(job.status)) return job
      if (signal?.aborted) return job
      if (Date.now() >= deadline) return job
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))))
    }
  }

  async dispose() {
    this.#disposed = true
    this.#queue = []
    this.#controller?.abort(new Error('插件已卸载'))
    // 等在跑作业收尾
    while (this.#active) await new Promise((r) => setTimeout(r, 20))
  }

  async #pump() {
    if (this.#active || this.#disposed) return
    const item = this.#queue.shift()
    if (!item) return
    const { job, run } = item
    this.#active = item
    this.#controller = new AbortController()
    job.status = 'running'
    job.updatedAt = new Date().toISOString()
    await this.#persist(job)
    try {
      const result = await run(job, this.#controller.signal)
      if (this.#controller.signal.aborted) {
        job.status = 'cancelled'
      } else {
        job.status = 'done'
        job.result = compact(result)
      }
    } catch (err) {
      const aborted = this.#controller.signal.aborted
      job.status = aborted ? 'cancelled' : 'failed'
      job.error = compact({
        code: aborted ? 'CANCELLED' : (err?.code ?? 'JOB_FAILED'),
        message: err instanceof Error ? err.message : String(err),
        hint: err?.hint,
      })
    } finally {
      job.updatedAt = new Date().toISOString()
      await this.#persist(job)
      this.#active = null
      this.#controller = null
      this.#pump()
    }
  }

  async #persist(job) {
    try {
      await writeJsonAtomic(join(this.#root, 'jobs', job.id, 'job.json'), job)
    } catch (err) {
      this.#logger?.warn?.(`bili-digest: 作业落盘失败 ${job.id}: ${err?.message ?? err}`)
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/jobs.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/jobs.js test/jobs.test.mjs
git commit -m "feat(bili-digest): 作业注册表（串行、落盘、可取消）"
```

---

## Task 5: URL 归一化

**Files:**
- Create: `src/media/url.js`
- Create: `test/url.test.mjs`

**Interfaces:**
- Consumes: `BiliDigestError`（Task 2）
- Produces:
  - `normalizeUrl(raw): { url: string, bvid: string|null, page: number }` —— 非法输入抛 `BAD_INPUT`
  - `isAllowed(url): boolean` —— 只放行 `http`/`https` 且 host 属 `bilibili.com` 子域、`b23.tv`、`bilibili.tv`

- [ ] **Step 1: 写失败测试**

`test/url.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrl, isAllowed } from '../src/media/url.js'

test('裸 BV 号归一化为视频页 URL', () => {
  const r = normalizeUrl('BV1GJ411x7h7')
  assert.equal(r.bvid, 'BV1GJ411x7h7')
  assert.equal(r.url, 'https://www.bilibili.com/video/BV1GJ411x7h7')
  assert.equal(r.page, 1)
})

test('BV 号大小写归一化', () => {
  assert.equal(normalizeUrl('bv1gj411x7h7').bvid, 'BV1GJ411x7h7')
})

test('完整 URL 透传并抽出分P', () => {
  const r = normalizeUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=3&t=10')
  assert.equal(r.bvid, 'BV1GJ411x7h7')
  assert.equal(r.page, 3)
  assert.match(r.url, /p=3/)
  assert.doesNotMatch(r.url, /t=10/)
})

test('av 号归一化为 av 形式 URL', () => {
  const r = normalizeUrl('av80433022')
  assert.equal(r.bvid, null)
  assert.match(r.url, /\/video\/av80433022/)
})

test('b23.tv 短链原样透传，不做网络请求', () => {
  const r = normalizeUrl('https://b23.tv/abc123')
  assert.equal(r.url, 'https://b23.tv/abc123')
  assert.equal(r.bvid, null)
})

test('空输入抛 BAD_INPUT', () => {
  assert.throws(() => normalizeUrl('   '), (e) => e.code === 'BAD_INPUT')
})

test('非法输入抛 BAD_INPUT', () => {
  assert.throws(() => normalizeUrl('随便什么'), (e) => e.code === 'BAD_INPUT')
  assert.throws(() => normalizeUrl('BV123'), (e) => e.code === 'BAD_INPUT')
})

test('file: 协议被拒绝', () => {
  assert.throws(() => normalizeUrl('file:///C:/secret.mp4'), (e) => e.code === 'UNSUPPORTED_URL')
})

test('isAllowed 放行 B站与短链域名', () => {
  assert.equal(isAllowed('https://www.bilibili.com/video/BV1GJ411x7h7'), true)
  assert.equal(isAllowed('https://b23.tv/abc'), true)
  assert.equal(isAllowed('https://m.bilibili.com/video/BV1GJ411x7h7'), true)
})

test('isAllowed 挡掉非白名单域名与协议', () => {
  assert.equal(isAllowed('https://evil.com/video/BV1GJ411x7h7'), false)
  assert.equal(isAllowed('file:///C:/x'), false)
  assert.equal(isAllowed('http://127.0.0.1:8080/x'), false)
  assert.equal(isAllowed('not a url'), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/url.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/media/url.js`：

```js
import { BiliDigestError } from '../errors.js'

const BV_RE = /^BV[0-9A-Za-z]{10}$/
const AV_RE = /^av(\d+)$/i
const ALLOWED_HOSTS = ['bilibili.com', 'b23.tv', 'bilibili.tv']

/** host 是否属白名单（含子域，且防 `evil-bilibili.com` 这类后缀伪造）。 */
function hostAllowed(host) {
  const h = host.toLowerCase()
  return ALLOWED_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`))
}

/**
 * URL 是否在允许范围内：http(s) + 白名单 host。
 * 挡掉 file: 一类本地读取面——yt-dlp 拿到任意 URL 都能读本地文件。
 */
export function isAllowed(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return hostAllowed(parsed.hostname)
}

/**
 * 把用户输入归一化成 yt-dlp 能吃的 URL。纯函数，不做网络请求（短链交给 yt-dlp 跟随跳转）。
 * @param raw 用户输入：BV号 / av号 / 完整 URL / b23.tv 短链
 * @returns {{ url:string, bvid:string|null, page:number }}
 * @throws BAD_INPUT / UNSUPPORTED_URL
 */
export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') {
    throw new BiliDigestError('BAD_INPUT', '没有给出视频地址', '用法：/bilisum <BV号|链接>')
  }

  // 裸 BV 号
  const bv = BV_RE.test(text) ? text : BV_RE.test(text.toUpperCase()) ? text.toUpperCase() : null
  if (bv) {
    return { url: `https://www.bilibili.com/video/${bv}`, bvid: bv, page: 1 }
  }

  // 裸 av 号
  const av = AV_RE.exec(text)
  if (av) {
    return { url: `https://www.bilibili.com/video/av${av[1]}`, bvid: null, page: 1 }
  }

  // URL 形态
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new BiliDigestError('BAD_INPUT', `无法识别为视频地址：${text}`, '支持 BV号 / av号 / 完整链接')
  }
  if (parsed.protocol === 'file:') {
    throw new BiliDigestError('UNSUPPORTED_URL', '不接受 file: 协议', '只支持 http(s) 的 B 站链接')
  }
  if (!isAllowed(text)) {
    throw new BiliDigestError('UNSUPPORTED_URL', `不支持的站点：${parsed.hostname}`, 'P0 只支持 B 站（bilibili.com / b23.tv）')
  }

  const pageRaw = Number(parsed.searchParams.get('p'))
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
  const bvInPath = /\/(BV[0-9A-Za-z]{10})/.exec(parsed.pathname)
  // 只保留 p 参数，其余（t、spm_id_from 等）丢掉，避免把跟踪参数传下去
  if (page > 1) parsed.searchParams.set('p', String(page))
  else parsed.searchParams.delete('p')
  for (const key of [...parsed.searchParams.keys()]) {
    if (key !== 'p') parsed.searchParams.delete(key)
  }
  return {
    url: parsed.toString(),
    bvid: bvInPath ? bvInPath[1] : null,
    page,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/url.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/media/url.js test/url.test.mjs
git commit -m "feat(bili-digest): URL 归一化与域名白名单"
```

---

## Task 6: 外部工具定位 + 子进程环境（childEnv）

**Files:**
- Create: `src/media/tools.js`
- Create: `test/tools.test.mjs`

**Interfaces:**
- Consumes: `BiliDigestError`（Task 2）、`cachePaths`（Task 3）
- Produces:
  - `resolveYtDlp(config): string|undefined`
  - `resolveFfmpeg(config): string|undefined`
  - `checkTools(config): { ytDlp?: string, ffmpeg?: string }` —— 值为问题描述，无问题则不出现该键
  - `childEnv(config, target): object` —— `target` 为 `'bilibili'` 或 `'tool-download'`
  - `ensureTmpDir(config): Promise<string>`

- [ ] **Step 1: 写失败测试**

`test/tools.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveYtDlp, resolveFfmpeg, checkTools, childEnv } from '../src/media/tools.js'
import { resolveConfig } from '../src/config.js'

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tools-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('ytDlpPath 显式配置优先', async () => {
  await withDir(async (dir) => {
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

test('checkTools 报出缺失项，键存在即有问题', async () => {
  await withDir(async (dir) => {
    const problems = checkTools(resolveConfig({ cacheDir: dir, ffmpegPath: join(dir, 'nope.exe') }))
    assert.equal(typeof problems.ytDlp, 'string')
    assert.equal(typeof problems.ffmpeg, 'string')
    // 只有两个键
    assert.deepEqual(Object.keys(problems).sort(), ['ffmpeg', 'ytDlp'])
  })
})

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/tools.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/media/tools.js`：

```js
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { cachePaths } from '../cache.js'

/**
 * 找出 yt-dlp.exe 的绝对路径。
 * 顺序：显式配置 → <cacheDir>/bin/yt-dlp.exe → undefined
 */
export function resolveYtDlp(config) {
  if (config.ytDlpPath && existsSync(config.ytDlpPath)) return config.ytDlpPath
  if (config.cacheDir) {
    const local = join(cachePaths(config.cacheDir, '_').binDir, 'yt-dlp.exe')
    if (existsSync(local)) return local
  }
  return undefined
}

/** 找出 ffmpeg.exe 的绝对路径。顺序：显式配置 → <cacheDir>/bin/ffmpeg.exe → undefined。 */
export function resolveFfmpeg(config) {
  if (config.ffmpegPath && existsSync(config.ffmpegPath)) return config.ffmpegPath
  if (config.cacheDir) {
    const local = join(cachePaths(config.cacheDir, '_').binDir, 'ffmpeg.exe')
    if (existsSync(local)) return local
  }
  return undefined
}

/** 返回缺失工具的问题描述；无问题则不含该键。 */
export function checkTools(config) {
  const problems = {}
  if (!resolveYtDlp(config)) {
    problems.ytDlp = `找不到 yt-dlp.exe。放置到 ${join(config.cacheDir, 'bin', 'yt-dlp.exe')}，或配置 ytDlpPath，或用 --update-tools 自动下载。`
  }
  if (!resolveFfmpeg(config)) {
    problems.ffmpeg = `找不到 ffmpeg.exe。放置到 ${join(config.cacheDir, 'bin', 'ffmpeg.exe')}，或配置 ffmpegPath。`
  }
  return problems
}

/** 确保并返回子进程共用的临时目录。 */
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
 * @param config 已解析配置
 * @param target 'bilibili'（访问 B 站） | 'tool-download'（下载工具）
 * @returns 可直接传给 spawn 的 env；额外带 __proxy 字段供调用方拼 --proxy 参数
 */
export function childEnv(config, target) {
  const tmp = join(config.cacheDir, 'tmp')
  mkdirSync(tmp, { recursive: true })

  const env = {
    ...process.env,
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
  }

  const proxy = target === 'bilibili' ? config.proxy : config.toolDownloadProxy
  env.__proxy = proxy

  if (proxy === '' || proxy === 'direct') {
    // 强制直连：清掉所有可能被 urllib 读到的代理变量，并让 no_proxy 覆盖一切
    env.HTTP_PROXY = ''
    env.HTTPS_PROXY = ''
    env.http_proxy = ''
    env.https_proxy = ''
    env.NO_PROXY = '*'
    env.no_proxy = '*'
  } else if (proxy === 'system') {
    // 跟随系统：删掉我们可能从父进程继承来的空值，让 Python 去读 WinINET
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

  return env
}

/** 把 childEnv 的结果拆成 spawn 用的 env（去掉 __proxy）。 */
export function spawnEnv(env) {
  const { __proxy, ...rest } = env
  return rest
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/tools.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/media/tools.js test/tools.test.mjs
git commit -m "feat(bili-digest): 外部工具定位与子进程环境（TEMP + 分目标代理）"
```

---

## Task 7: yt-dlp 镜像链下载 + SHA-256 校验

**Files:**
- Modify: `src/media/tools.js`（追加导出）
- Create: `test/tools-download.test.mjs`

**Interfaces:**
- Consumes: `childEnv` / `spawnEnv` / `ensureTmpDir`（Task 6）
- Produces:
  - `const YTDLP_MIRRORS: (tag:string)=>string[]`
  - `downloadYtDlp(config, { fetchImpl, onProgress, signal }): Promise<string>` —— 下载到 `<cacheDir>/bin/yt-dlp.exe` 并校验成功后才 rename 就位；全部失败抛 `YTDLP_DOWNLOAD_FAILED`
  - `parseSums(text): Map<string,string>` —— 解析 `SHA2-256SUMS`

- [ ] **Step 1: 写失败测试**

`test/tools-download.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/tools-download.test.mjs`
Expected: FAIL —— `parseSums is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `src/media/tools.js`：

```js
import { createHash } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { BiliDigestError } from '../errors.js'

const YTDLP_TAG = '2026.08.19'

/**
 * yt-dlp.exe 的下载镜像链。
 * 实测（规格 F28）：本机 github.com release 直连不通（status 000），ghproxy 通。
 * 官方直连放最后，因为它在部分网络下也能用。
 */
export function YTDLP_MIRRORS(tag = YTDLP_TAG) {
  const path = `github.com/yt-dlp/yt-dlp/releases/download/${tag}`
  return [
    `https://ghproxy.net/https://${path}/yt-dlp.exe`,
    `https://gh-proxy.com/https://${path}/yt-dlp.exe`,
    `https://${path}/yt-dlp.exe`,
  ]
}

/** 解析 SHA2-256SUMS：每行 `<hash>  <filename>`。 */
export function parseSums(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())
    if (m) map.set(m[2], m[1].toLowerCase())
  }
  return map
}

async function fetchBytes(fetchImpl, url) {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * 从镜像链下载 yt-dlp.exe，逐个镜像校验 SHA-256，第一个通过的胜出。
 * 校验不通过就当这个镜像失败，换下一个——绝不把可疑二进制写进最终路径。
 * @returns 落位后的绝对路径
 */
export async function downloadYtDlp(config, { fetchImpl = fetch, onProgress, signal } = {}) {
  const binDir = cachePaths(config.cacheDir, '_').binDir
  mkdirSync(binDir, { recursive: true })
  const dest = join(binDir, 'yt-dlp.exe')
  const failures = []

  signal?.throwIfAborted()

  let sums = new Map()
  try {
    const sumsUrl = `https://ghproxy.net/https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_TAG}/SHA2-256SUMS`
    sums = parseSums((await fetchBytes(fetchImpl, sumsUrl)).toString('utf8'))
  } catch (err) {
    // 拿不到 SUMS 不致命：退化为"不校验"，但必须记录
    failures.push(`SHA2-256SUMS 获取失败：${err.message}`)
  }
  const expected = sums.get('yt-dlp.exe')

  for (const url of YTDLP_MIRRORS()) {
    signal?.throwIfAborted()
    try {
      onProgress?.({ phase: 'download', url })
      const buf = await fetchBytes(fetchImpl, url)
      if (expected) {
        const got = createHash('sha256').update(buf).digest('hex')
        if (got !== expected) {
          failures.push(`${new URL(url).host}：SHA-256 不符（期望 ${expected.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）`)
          continue
        }
      }
      const tmp = `${dest}.tmp-${process.pid}`
      await writeFile(tmp, buf)
      await rename(tmp, dest)
      onProgress?.({ phase: 'download', url, done: true, bytes: buf.length })
      return dest
    } catch (err) {
      failures.push(`${new URL(url).host}：${err.message}`)
      try { await unlink(`${dest}.tmp-${process.pid}`) } catch { /* 忽略 */ }
    }
  }

  throw new BiliDigestError(
    'YTDLP_DOWNLOAD_FAILED',
    'yt-dlp 下载失败',
    `已尝试 ${YTDLP_MIRRORS().length} 个镜像，全部失败：\n${failures.map((f) => `  · ${f}`).join('\n')}\n可手动下载 yt-dlp.exe 放到 ${dest}`,
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/tools-download.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/media/tools.js test/tools-download.test.mjs
git commit -m "feat(bili-digest): yt-dlp 镜像链下载与 SHA-256 校验"
```

---

## Task 8: yt-dlp 子进程封装（probe / version）

**Files:**
- Create: `src/media/ytdlp.js`
- Create: `test/ytdlp.test.mjs`
- Create: `test/fixtures/probe.json`

**Interfaces:**
- Consumes: `resolveYtDlp` / `childEnv` / `spawnEnv` / `ensureTmpDir`（Task 6）、`normalizeUrl`（Task 5）、`BiliDigestError`（Task 2）
- Produces:
  - `runYtDlp(config, args, { signal, onStderr }): Promise<{ stdout:string, stderr:string, code:number }>` —— 内部使用；非零退出抛 `YTDLP_FAILED`，stderr 含 412 时抛 `YTDLP_BLOCKED`
  - `probe(config, url, { signal }): Promise<ProbeInfo>`
  - `version(config, { signal }): Promise<string>`
  - ProbeInfo：`{ id, title, duration, uploader, webpageUrl, description, tags:string[], chapters: {start,end,title}[], subtitles: string[], isPlaylist: boolean, playlistCount: number }`

- [ ] **Step 1: 造 fixture**

`test/fixtures/probe.json`（从真实 probe 输出裁剪、脱敏；不要改动结构）：

```json
{
  "id": "BV1GJ411x7h7",
  "title": "【官方 MV】Never Gonna Give You Up - Rick Astley",
  "duration": 212.393,
  "uploader": "索尼音乐中国",
  "webpage_url": "https://www.bilibili.com/video/BV1GJ411x7h7",
  "description": "-",
  "tags": [],
  "chapters": null,
  "subtitles": {},
  "extractor": "BiliBili",
  "formats": [
    { "format_id": "30216", "ext": "m4a", "acodec": "mp4a.40.5", "vcodec": "none", "abr": 43.962 },
    { "format_id": "30232", "ext": "m4a", "acodec": "mp4a.40.2", "vcodec": "none", "abr": 102.931 },
    { "format_id": "30280", "ext": "m4a", "acodec": "mp4a.40.2", "vcodec": "none", "abr": 203.786 }
  ]
}
```

- [ ] **Step 2: 写失败测试**

`test/ytdlp.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { reduceProbe, buildProbeArgs, classifyYtDlpFailure } from '../src/media/ytdlp.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(await readFile(join(here, 'fixtures', 'probe.json'), 'utf8'))

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
})

test('buildProbeArgs 含离线与静默标志，且带 --proxy', () => {
  const args = buildProbeArgs('https://x/video/BV1', '')
  assert.ok(args.includes('--dump-single-json'))
  assert.ok(args.includes('--skip-download'))
  assert.ok(args.includes('--no-playlist'))
  assert.ok(args.includes('--proxy='))
  assert.equal(args.at(-1), 'https://x/video/BV1')
})

test('buildProbeArgs 带 cookie 文件时追加 --cookies', () => {
  const args = buildProbeArgs('https://x', 'C:/tmp/c.txt')
  assert.ok(args.includes('--cookies'))
  assert.ok(args.includes('C:/tmp/c.txt'))
})

test('classifyYtDlpFailure 把 412 归为 YTDLP_BLOCKED', () => {
  const e = classifyYtDlpFailure('ERROR: Unable to download webpage: HTTP Error 412: Precondition Failed')
  assert.equal(e.code, 'YTDLP_BLOCKED')
  assert.match(e.hint, /proxy/)
})

test('classifyYtDlpFailure 把临时目录错误归为 TOOL_TEMP_UNAVAILABLE', () => {
  const e = classifyYtDlpFailure('[PYI-25504:ERROR] Could not create temporary directory!')
  assert.equal(e.code, 'TOOL_TEMP_UNAVAILABLE')
})

test('classifyYtDlpFailure 其余归为 YTDLP_FAILED', () => {
  assert.equal(classifyYtDlpFailure('ERROR: Video unavailable').code, 'YTDLP_FAILED')
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/ytdlp.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 4: 写最小实现**

`src/media/ytdlp.js`：

```js
import { spawn } from 'node:child_process'
import { BiliDigestError } from '../errors.js'
import { childEnv, ensureTmpDir, resolveYtDlp, spawnEnv } from './tools.js'

const MAX_BUFFER = 64 * 1024 * 1024

/**
 * 把 yt-dlp 的失败归到具体错误码，便于用户自助。
 * 这三类都是实测踩过的（规格 §17.2）。
 */
export function classifyYtDlpFailure(stderr) {
  const text = String(stderr ?? '')
  if (/HTTP Error 412|Precondition Failed/.test(text)) {
    return new BiliDigestError(
      'YTDLP_BLOCKED',
      'B 站拒绝了这次请求（HTTP 412）',
      '最常见原因是出口 IP 被风控。若本机开着代理（Clash 等），把配置 proxy 设为 "" 强制直连；否则稍后重试。',
    )
  }
  if (/Could not create temporary directory/.test(text)) {
    return new BiliDigestError(
      'TOOL_TEMP_UNAVAILABLE',
      'yt-dlp 无法创建临时目录',
      '把 cacheDir 指到一个可写目录，然后重试。',
    )
  }
  return new BiliDigestError('YTDLP_FAILED', 'yt-dlp 执行失败', `yt-dlp 输出（末尾）：\n${text.split(/\r?\n/).slice(-8).join('\n')}`)
}

/**
 * 跑一次 yt-dlp。参数一律走数组、不经 shell。
 * @returns { stdout, stderr, code }
 */
export function runYtDlp(config, args, { signal } = {}) {
  const exe = resolveYtDlp(config)
  if (!exe) {
    return Promise.reject(new BiliDigestError('YTDLP_MISSING', '找不到 yt-dlp.exe', `放置到 ${config.cacheDir}/bin/yt-dlp.exe，或用 --update-tools 下载。`))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      env: spawnEnv(childEnv(config, 'bilibili')),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const onAbort = () => {
      try { child.kill() } catch { /* 忽略 */ }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => { if (out.length < MAX_BUFFER) out += d.toString() })
    child.stderr.on('data', (d) => { if (err.length < MAX_BUFFER) err += d.toString() })
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new BiliDigestError('YTDLP_FAILED', `无法启动 yt-dlp：${e.message}`, undefined, e))
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) {
        reject(new BiliDigestError('CANCELLED', '已取消'))
        return
      }
      if (code !== 0) {
        reject(classifyYtDlpFailure(err || out))
        return
      }
      resolve({ stdout: out, stderr: err, code })
    })
  })
}

/** 构造 probe 的参数。 */
export function buildProbeArgs(url, cookieFile, proxy = '') {
  const args = [
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    `--proxy=${proxy}`,
  ]
  if (cookieFile) args.push('--cookies', cookieFile)
  args.push(url)
  return args
}

/** 把 yt-dlp 的 info dict 归约成我们需要的形状。纯函数，可离线测。 */
export function reduceProbe(raw) {
  const chapters = Array.isArray(raw?.chapters)
    ? raw.chapters
      .map((c) => ({
        start: Number(c?.start_time ?? 0),
        end: Number(c?.end_time ?? 0),
        title: String(c?.title ?? '').trim() || '未命名章节',
      }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    : []
  const subtitles = raw?.subtitles && typeof raw.subtitles === 'object' ? Object.keys(raw.subtitles) : []
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? raw?.id ?? '未命名视频'),
    duration: Number(raw?.duration ?? 0),
    uploader: String(raw?.uploader ?? ''),
    webpageUrl: String(raw?.webpage_url ?? ''),
    description: String(raw?.description ?? ''),
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : [],
    chapters,
    subtitles,
    isPlaylist: false,
    playlistCount: 1,
  }
}

/** 取元信息 / 章节 / 字幕清单。一次调用。 */
export async function probe(config, url, { cookieFile, signal, onProgress } = {}) {
  const proxy = childEnv(config, 'bilibili').__proxy ?? ''
  onProgress?.({ phase: 'probe' })
  const { stdout } = await runYtDlp(config, buildProbeArgs(url, cookieFile, proxy), { signal })
  let raw
  try {
    raw = JSON.parse(stdout)
  } catch (e) {
    throw new BiliDigestError('YTDLP_FAILED', 'yt-dlp 返回的不是合法 JSON', stdout.slice(0, 300), e)
  }
  if (Array.isArray(raw?.entries)) {
    throw new BiliDigestError('BILI_UNSUPPORTED_CONTENT', '这是一个合集/番剧，P0 不支持', '请给出单个视频的链接。')
  }
  return reduceProbe(raw)
}

/** yt-dlp 版本号，用于诊断与 --update-tools。 */
export async function version(config, { signal } = {}) {
  const { stdout } = await runYtDlp(config, ['--version'], { signal })
  return stdout.trim()
}
```

- [ ] **Step 5: 跑测试确认通过并提交**

Run: `node --test test/ytdlp.test.mjs`
Expected: PASS

```bash
git add src/media/ytdlp.js test/ytdlp.test.mjs test/fixtures/probe.json
git commit -m "feat(bili-digest): yt-dlp 封装（probe/version + 失败分类）"
```

---

## Task 9: ffmpeg 解码（唯一解码点）

**Files:**
- Create: `src/media/ffmpeg.js`
- Create: `test/ffmpeg.test.mjs`
- Modify: `package.json`（新增依赖）

**Interfaces:**
- Consumes: `resolveFfmpeg` / `childEnv`（Task 6）
- Produces:
  - `toWav16k(config, inputPath, outputPath, { signal }): Promise<void>` —— 非零退出抛 `AUDIO_DECODE_FAILED`；找不到 ffmpeg 抛 `FFMPEG_MISSING`
  - `installFfmpeg(config): Promise<string>` —— 从 `@ffmpeg-installer/win32-x64` 复制到 `<cacheDir>/bin/ffmpeg.exe`

- [ ] **Step 1: 装依赖并写失败测试**

```bash
pnpm add @ffmpeg-installer/win32-x64
```

`test/ffmpeg.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { installFfmpeg } from '../src/media/ffmpeg.js'

test('installFfmpeg 把二进制复制进 cacheDir/bin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ff-'))
  const cfg = resolveConfig({ cacheDir: dir })
  const dest = await installFfmpeg(cfg)
  assert.equal(dest, join(dir, 'bin', 'ffmpeg.exe'))
  assert.ok(existsSync(dest))
  await rm(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ffmpeg.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/media/ffmpeg.js`：

```js
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { BiliDigestError } from '../errors.js'
import { cachePaths } from '../cache.js'
import { childEnv, resolveFfmpeg, spawnEnv } from './tools.js'

const require = createRequire(import.meta.url)

/**
 * 把 @ffmpeg-installer 里的 ffmpeg.exe 复制到 <cacheDir>/bin。
 * 选这个包而不是 ffmpeg-static：二进制随 tarball 分发，没有 postinstall 网络下载（规格 F12）。
 */
export async function installFfmpeg(config) {
  const binDir = cachePaths(config.cacheDir, '_').binDir
  mkdirSync(binDir, { recursive: true })
  const dest = join(binDir, 'ffmpeg.exe')
  if (existsSync(dest)) return dest
  const pkgPath = require.resolve('@ffmpeg-installer/win32-x64/package.json')
  const src = join(dirname(pkgPath), 'ffmpeg.exe')
  if (!existsSync(src)) {
    throw new BiliDigestError('FFMPEG_MISSING', '依赖里的 ffmpeg.exe 不存在', `期望位置：${src}`)
  }
  copyFileSync(src, dest)
  return dest
}

/**
 * m4s → 16kHz 单声道 PCM16 WAV。
 *
 * **这是唯一的解码点**：其它模块不得直接依赖 ffmpeg，换解码方案只改这里。
 * 注意产出的 WAV 不是「规范 WAV」——ffmpeg 会插入 LIST/fact chunk，
 * 所以 audio/window.js 必须自己解析 chunk 再重写规范头（规格 F7）。
 */
export function toWav16k(config, inputPath, outputPath, { signal } = {}) {
  const exe = resolveFfmpeg(config)
  if (!exe) {
    return Promise.reject(new BiliDigestError('FFMPEG_MISSING', '找不到 ffmpeg.exe', `运行 installFfmpeg()，或配置 ffmpegPath。`))
  }
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-f', 'wav', outputPath,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      env: spawnEnv(childEnv(config, 'bilibili')),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    const onAbort = () => {
      // Windows 上 kill() 不一定带走子进程树，用 taskkill 兜底
      try { child.kill() } catch { /* 忽略 */ }
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch { /* 忽略 */ }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d.toString() })
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new BiliDigestError('AUDIO_DECODE_FAILED', `无法启动 ffmpeg：${e.message}`, undefined, e))
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) {
        reject(new BiliDigestError('CANCELLED', '已取消'))
        return
      }
      if (code !== 0) {
        reject(new BiliDigestError('AUDIO_DECODE_FAILED', 'ffmpeg 解码失败', `ffmpeg 输出（末尾）：\n${err.split(/\r?\n/).slice(-20).join('\n')}`))
        return
      }
      resolve()
    })
  })
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/ffmpeg.test.mjs`
Expected: PASS

```bash
git add package.json pnpm-lock.yaml src/media/ffmpeg.js test/ffmpeg.test.mjs
git commit -m "feat(bili-digest): ffmpeg 解码与二进制安装"
```

---

## Task 10: 规范 WAV 解析与构造

**Files:**
- Create: `src/audio/window.js`
- Create: `test/window-wav.test.mjs`

**Interfaces:**
- Consumes: `BiliDigestError`（Task 2）
- Produces:
  - `parsePcmWav(buffer): { sampleRate:number, channels:number, bits:number, samples:Int16Array }` —— 支持任意 chunk 顺序；非 PCM16 抛 `WAV_MALFORMED`
  - `buildPcmWav(samples, sampleRate=16000): Uint8Array` —— 输出**规范 44 字节头**；样本数为奇数时丢弃最后一个
  - `CANONICAL_HEADER_BYTES = 44`

- [ ] **Step 1: 写失败测试**

`test/window-wav.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePcmWav, buildPcmWav } from '../src/audio/window.js'

/** 造一个带额外 LIST chunk 的 WAV，模拟 ffmpeg 的真实输出。 */
function wavWithListChunk(samples, sampleRate = 16000) {
  const dataLen = samples.length * 2
  const listBody = Buffer.from('INFOISFT\x08\x00\x00\x00Lavf58.29\x00')
  const listLen = 8 + listBody.length
  const total = 12 + 24 + listLen + 8 + dataLen
  const buf = Buffer.alloc(total)
  let o = 0
  buf.write('RIFF', o); o += 4
  buf.writeUInt32LE(total - 8, o); o += 4
  buf.write('WAVE', o); o += 4
  buf.write('fmt ', o); o += 4
  buf.writeUInt32LE(16, o); o += 4
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt32LE(sampleRate, o); o += 4
  buf.writeUInt32LE(sampleRate * 2, o); o += 4
  buf.writeUInt16LE(2, o); o += 2
  buf.writeUInt16LE(16, o); o += 2
  buf.write('LIST', o); o += 4
  buf.writeUInt32LE(listBody.length, o); o += 4
  listBody.copy(buf, o); o += listBody.length
  buf.write('data', o); o += 4
  buf.writeUInt32LE(dataLen, o); o += 4
  for (const s of samples) { buf.writeInt16LE(s, o); o += 2 }
  return buf
}

test('parsePcmWav 能解析带 LIST chunk 的 WAV（chunk 顺序不固定）', () => {
  const samples = Int16Array.from([1, -2, 3, -4])
  const parsed = parsePcmWav(wavWithListChunk(samples))
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.bits, 16)
  assert.deepEqual([...parsed.samples], [1, -2, 3, -4])
})

test('parsePcmWav 拒绝非 WAV', () => {
  assert.throws(() => parsePcmWav(Buffer.from('not a wav at all...............')), (e) => e.code === 'WAV_MALFORMED')
})

test('buildPcmWav 产出逐字节规范的头', () => {
  const samples = Int16Array.from([100, -100])
  const out = buildPcmWav(samples, 16000)
  const b = Buffer.from(out)
  assert.equal(b.length, 48)
  assert.equal(b.toString('ascii', 0, 4), 'RIFF')
  assert.equal(b.readUInt32LE(4), 48 - 8)
  assert.equal(b.toString('ascii', 8, 12), 'WAVE')
  assert.equal(b.toString('ascii', 12, 16), 'fmt ')
  assert.equal(b.readUInt32LE(16), 16)
  assert.equal(b.readUInt16LE(20), 1)
  assert.equal(b.readUInt16LE(22), 1)
  assert.equal(b.readUInt32LE(24), 16000)
  assert.equal(b.readUInt32LE(28), 32000)
  assert.equal(b.readUInt16LE(32), 2)
  assert.equal(b.readUInt16LE(34), 16)
  assert.equal(b.toString('ascii', 36, 40), 'data')
  assert.equal(b.readUInt32LE(40), 4)
  assert.equal(b.readInt16LE(44), 100)
  assert.equal(b.readInt16LE(46), -100)
})

test('buildPcmWav 对奇数样本数丢弃最后一个（validateWave 要求 (len-44)%2===0）', () => {
  const out = buildPcmWav(Int16Array.from([1, 2, 3]), 16000)
  assert.equal(Buffer.from(out).length, 44 + 4)
})

test('buildPcmWav 接受 Int16Array 的 subarray 视图', () => {
  const backing = Int16Array.from([9, 9, 5, 6, 9])
  const out = buildPcmWav(backing.subarray(2, 4), 16000)
  assert.equal(Buffer.from(out).readInt16LE(44), 5)
  assert.equal(Buffer.from(out).readInt16LE(46), 6)
})

test('parsePcmWav 与 buildPcmWav 往返一致', () => {
  const samples = Int16Array.from([7, -7, 1234, -1234])
  const parsed = parsePcmWav(buildPcmWav(samples, 16000))
  assert.deepEqual([...parsed.samples], [...samples])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/window-wav.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/audio/window.js`：

```js
import { BiliDigestError } from '../errors.js'

export const CANONICAL_HEADER_BYTES = 44
const CANONICAL_RATE = 16000

/**
 * 解析 PCM WAV。**容忍任意 chunk 顺序**——ffmpeg 会在 fmt 和 data 之间插 LIST/fact，
 * 所以不能假设 data 就在偏移 44。
 * @param buffer 完整文件字节
 * @returns {{ sampleRate:number, channels:number, bits:number, samples:Int16Array }}
 */
export function parsePcmWav(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new BiliDigestError('WAV_MALFORMED', '不是合法的 WAV 文件', '解码步骤可能产出了空文件或非 WAV 内容。')
  }
  let fmt = null
  let data = null
  let o = 12
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4)
    const size = b.readUInt32LE(o + 4)
    const body = o + 8
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, b.length - body) }
    }
    o = body + size + (size % 2) // chunk 按偶数字节对齐
  }
  if (!fmt || !data) {
    throw new BiliDigestError('WAV_MALFORMED', 'WAV 缺少 fmt 或 data chunk', '解码步骤可能提前中断。')
  }
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new BiliDigestError('WAV_MALFORMED', `只支持 PCM16，实得 format=${fmt.format} bits=${fmt.bits}`, '这是内部错误，说明 ffmpeg 参数被改动了。')
  }
  const count = Math.floor(data.size / 2)
  const samples = new Int16Array(count)
  for (let i = 0; i < count; i++) samples[i] = b.readInt16LE(data.start + i * 2)
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, samples }
}

/**
 * 构造规范 44 字节头 WAV。
 *
 * DSH 的 speechToText 逐字节校验头部（规格 F7）：RIFF/WAVE/fmt(16)/PCM/mono/16000/
 * byteRate 32000/blockAlign 2/16bit/data，且 (len-44)%2===0。任何偏差都会被直接拒绝。
 * @param samples PCM16 样本（可以是 subarray 视图，不会复制整段）
 */
export function buildPcmWav(samples, sampleRate = CANONICAL_RATE) {
  const usable = samples.length - (samples.length % 2)
  const dataLen = usable * 2
  const total = CANONICAL_HEADER_BYTES + dataLen
  const b = Buffer.allocUnsafe(total)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(total - 8, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(dataLen, 40)
  for (let i = 0; i < usable; i++) b.writeInt16LE(samples[i], CANONICAL_HEADER_BYTES + i * 2)
  return new Uint8Array(b.buffer, b.byteOffset, b.length)
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/window-wav.test.mjs`
Expected: PASS

```bash
git add src/audio/window.js test/window-wav.test.mjs
git commit -m "feat(bili-digest): 规范 WAV 解析与构造"
```

---

## Task 11: 静音点对齐切窗

**Files:**
- Modify: `src/audio/window.js`（追加导出）
- Create: `test/window-plan.test.mjs`
- Create: `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: `parsePcmWav` / `buildPcmWav`（Task 10）
- Produces:
  - `planSegments({ sampleRate, samples, targetSec, minSec, snapSec, silenceRms }): { startSample, endSample, startSec, endSec }[]` —— 连续、不重叠、覆盖全长，每段样本数为偶数
  - `sliceSeconds(samples, sampleRate, startSec, endSec): Int16Array`

- [ ] **Step 1: 写署名文件**

`THIRD_PARTY_NOTICES.md`：

```markdown
# 第三方声明

## dsh-video-transcribe（MIT）

`src/audio/window.js` 里的分片算法（静音点吸附、目标片长/最小片长/搜索半径的参数语义）
改编自 https://github.com/wqzhellohhwy/dsh-video-transcribe 的 `segment.js`，
其参数经该项目的实测调优（见其 README 的片长扫描数据）。

> MIT License — Copyright (c) dsh-video-transcribe contributors

我们**没有**采用它的 `joinSegments`（把片段文稿拼成纯文本）——那会丢掉时间戳，
而时间戳是本插件的核心价值。

## yt-dlp（Unlicense）

`yt-dlp.exe` 为外部可执行文件，由本插件在首次运行时下载，遵循其自身许可
（The Unlicense，公有领域）。https://github.com/yt-dlp/yt-dlp

## FFmpeg

`ffmpeg.exe` 经 npm 包 `@ffmpeg-installer/win32-x64` 分发，遵循 LGPL/GPL。
https://ffmpeg.org/legal.html
```

- [ ] **Step 2: 写失败测试**

`test/window-plan.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { planSegments, sliceSeconds } from '../src/audio/window.js'

const RATE = 16000

/** 造一段音频：全静音，但在指定的秒位置放 0.5 秒响亮的正弦。 */
function buildAudio(totalSec, loudAt = [], { amp = 12000 } = {}) {
  const n = Math.floor(totalSec * RATE)
  const s = new Int16Array(n)
  for (const t of loudAt) {
    const from = Math.floor(t * RATE)
    for (let i = 0; i < RATE / 2 && from + i < n; i++) {
      s[from + i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / RATE))
    }
  }
  return s
}

test('切窗覆盖全长、连续、不重叠', () => {
  const samples = buildAudio(100, [5, 35, 65, 95])
  const segs = planSegments({ sampleRate: RATE, samples, targetSec: 30, minSec: 5, snapSec: 1.5 })
  assert.equal(segs[0].startSample, 0)
  assert.equal(segs.at(-1).endSample, samples.length)
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].startSample, segs[i - 1].endSample)
})

test('每段样本数为偶数（validateWave 的硬要求）', () => {
  const samples = buildAudio(77, [10])
  const segs = planSegments({ sampleRate: RATE, samples, targetSec: 30, minSec: 5, snapSec: 1.5 })
  for (const s of segs) assert.equal((s.endSample - s.startSample) % 2, 0)
})

test('切点吸附到静音处，而不是切在声音里', () => {
  // 第 28 秒起有 0.5 秒的响亮声音；目标边界 30s，吸附半径 2s。
  // 吸附窗口 [28,32] 里最安静的位置是 28.5s 之后的静音区。
  const samples = buildAudio(60, [28])
  const segs = planSegments({ sampleRate: RATE, samples, targetSec: 30, minSec: 5, snapSec: 2 })
  const cut = segs[0].endSample
  let sum = 0
  const span = Math.round(RATE / 10)
  for (let i = cut - span; i < cut; i++) sum += (samples[i] / 32768) ** 2
  const rms = Math.sqrt(sum / span)
  assert.ok(rms < 0.01, `切点前 100ms 的 RMS=${rms.toFixed(4)} 过高，说明切在了声音里（cut=${cut / RATE}s）`)
})

test('吸附窗口内全是声音时退回目标边界', () => {
  // 全程响亮、没有停顿：不该硬挤到一个"最不吵"的位置，而应保持可预测的 30s
  const n = Math.round(90 * RATE)
  const samples = new Int16Array(n)
  for (let i = 0; i < n; i++) samples[i] = Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / RATE))
  const segs = planSegments({ sampleRate: RATE, samples, targetSec: 30, minSec: 5, snapSec: 2 })
  assert.ok(Math.abs(segs[0].endSec - 30) < 0.2, `期望退回 30s，实得 ${segs[0].endSec}s`)
})

test('短音频只产出一段', () => {
  const samples = buildAudio(10, [1])
  const segs = planSegments({ sampleRate: RATE, samples, targetSec: 30, minSec: 5, snapSec: 1.5 })
  assert.equal(segs.length, 1)
  assert.equal(segs[0].endSample, samples.length)
})

test('尾段不足 minSec 时并入前一段', () => {
  const samples = buildAudio(31, [1])
  const segs = planSegments({ sampleRate: RATE, samples, targetSec: 30, minSec: 5, snapSec: 0 })
  assert.equal(segs.length, 1)
})

test('snapSec 为 0 时不做吸附，边界落在目标处', () => {
  const samples = buildAudio(90, [])
  const segs = planSegments({ sampleRate: RATE, samples, targetSec: 30, minSec: 5, snapSec: 0 })
  assert.equal(segs.length, 3)
  assert.ok(Math.abs(segs[0].endSec - 30) < 0.2)
})

test('startSec/endSec 与样本下标自洽', () => {
  const samples = buildAudio(70, [3])
  const segs = planSegments({ sampleRate: RATE, samples, targetSec: 30, minSec: 5, snapSec: 1.5 })
  for (const s of segs) {
    assert.equal(s.startSec, s.startSample / RATE)
    assert.equal(s.endSec, s.endSample / RATE)
  }
})

test('sliceSeconds 返回指定区间的副本', () => {
  const samples = buildAudio(3, [1])
  const part = sliceSeconds(samples, RATE, 1, 2)
  assert.equal(part.length, RATE)
  assert.equal(part[100], samples[RATE + 100])
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/window-plan.test.mjs`
Expected: FAIL —— `planSegments is not a function`

- [ ] **Step 4: 写最小实现**

追加到 `src/audio/window.js`：

```js
const FRAME_SEC = 0.1
const DEFAULT_SILENCE_RMS = 0.012

/** 按 100ms 帧算归一化 RMS。 */
function frameRms(samples, rate) {
  const frameLen = Math.max(1, Math.round(FRAME_SEC * rate))
  const count = Math.floor(samples.length / frameLen)
  const out = new Float64Array(count)
  for (let f = 0; f < count; f++) {
    let sum = 0
    const from = f * frameLen
    for (let i = 0; i < frameLen; i++) {
      const v = samples[from + i] / 32768
      sum += v * v
    }
    out[f] = Math.sqrt(sum / frameLen)
  }
  return out
}

/**
 * 静音点对齐切窗。
 *
 * 目标片长默认 30 秒不是拍的：实测片长扫描显示 30s 产出密度最高，
 * 60s 起明显衰退，240s 开始丢内容（规格 F19）。吸附半径默认 1.5 秒，
 * 实测比固定切点多保留 3.8% 内容（规格 F20）。
 *
 * @returns 连续、不重叠、覆盖全长的区间；每段样本数为偶数
 */
export function planSegments({
  sampleRate,
  samples,
  targetSec = 30,
  minSec = 5,
  snapSec = 1.5,
  silenceRms = DEFAULT_SILENCE_RMS,
}) {
  const total = samples.length
  if (total === 0) return []
  const target = Math.max(1, Math.round(targetSec * sampleRate))
  const minSamples = Math.max(2, Math.round(minSec * sampleRate))
  const snap = Math.max(0, Math.round(snapSec * sampleRate))
  const rms = snap > 0 ? frameRms(samples, sampleRate) : null
  const frameLen = Math.max(1, Math.round(FRAME_SEC * sampleRate))

  /** 在目标边界附近找能量最低的帧，返回吸附后的样本下标。 */
  const snapTo = (nominal) => {
    if (!rms || rms.length === 0 || snap === 0) return nominal
    const lo = Math.max(0, Math.floor((nominal - snap) / frameLen))
    const hi = Math.min(rms.length - 1, Math.ceil((nominal + snap) / frameLen))
    if (hi < lo) return nominal
    let best = lo
    for (let f = lo; f <= hi; f++) if (rms[f] < rms[best]) best = f
    const at = best * frameLen
    // 最安静的帧仍然很吵时，说明这里没有停顿，保持目标边界更可预测
    if (rms[best] > silenceRms * 4) return nominal
    return at
  }

  const cuts = [0]
  let cursor = 0
  while (total - cursor > target * 1.5) {
    const nominal = cursor + target
    let next = snapTo(nominal)
    if (next - cursor < minSamples) next = Math.min(cursor + target, total)
    if (total - next < minSamples) next = total
    if (next <= cursor) break
    cuts.push(next)
    cursor = next
    if (next >= total) break
  }
  cuts.push(total)

  const segments = []
  for (let i = 0; i < cuts.length - 1; i++) {
    let startSample = cuts[i]
    let endSample = cuts[i + 1]
    // validateWave 要求 (len-44)%2===0
    if ((endSample - startSample) % 2 !== 0) endSample -= 1
    if (endSample <= startSample) continue
    segments.push({
      startSample,
      endSample,
      startSec: startSample / sampleRate,
      endSec: endSample / sampleRate,
    })
  }
  return segments
}

/** 取 [startSec, endSec) 的样本副本。 */
export function sliceSeconds(samples, sampleRate, startSec, endSec) {
  const from = Math.max(0, Math.round(startSec * sampleRate))
  const to = Math.min(samples.length, Math.round(endSec * sampleRate))
  return samples.slice(from, Math.max(from, to))
}
```

- [ ] **Step 5: 跑测试确认通过并提交**

Run: `node --test test/window-plan.test.mjs`
Expected: PASS

```bash
git add src/audio/window.js test/window-plan.test.mjs THIRD_PARTY_NOTICES.md
git commit -m "feat(bili-digest): 静音点对齐切窗（30s/±1.5s）"
```

---

## Task 12: 音频下载

**Files:**
- Modify: `src/media/ytdlp.js`（追加导出）
- Create: `test/ytdlp-audio.test.mjs`

**Interfaces:**
- Consumes: `runYtDlp`（Task 8）
- Produces:
  - `buildAudioArgs(url, { formatId, destTemplate, cookieFile, proxy }): string[]`
  - `AUDIO_FORMAT_ID = { balanced: '30232', smallest: '30216', best: '30280' }`
  - `downloadAudio(config, url, destPath, { cookieFile, signal, onProgress }): Promise<string>` —— 返回实际落盘路径

- [ ] **Step 1: 写失败测试**

`test/ytdlp-audio.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIO_FORMAT_ID, buildAudioArgs } from '../src/media/ytdlp.js'

test('AUDIO_FORMAT_ID 三个档位映射到实测到的 format_id', () => {
  assert.equal(AUDIO_FORMAT_ID.balanced, '30232')
  assert.equal(AUDIO_FORMAT_ID.smallest, '30216')
  assert.equal(AUDIO_FORMAT_ID.best, '30280')
})

test('buildAudioArgs 使用显式 format_id 而不是 bestaudio', () => {
  const args = buildAudioArgs('https://x/video/BV1', { formatId: '30232', destTemplate: 'C:/t/a.%(ext)s', proxy: '' })
  assert.ok(args.includes('-f'))
  assert.ok(args.includes('30232'))
  assert.ok(!args.some((a) => a.includes('bestaudio')))
})

test('buildAudioArgs 带代理与输出模板，URL 在最后', () => {
  const args = buildAudioArgs('https://x/video/BV1', { formatId: '30216', destTemplate: 'C:/t/a.%(ext)s', proxy: 'http://p:1' })
  assert.ok(args.includes('--proxy=http://p:1'))
  assert.ok(args.includes('-o'))
  assert.ok(args.includes('C:/t/a.%(ext)s'))
  assert.equal(args.at(-1), 'https://x/video/BV1')
})

test('buildAudioArgs 带 cookie 文件', () => {
  const args = buildAudioArgs('https://x', { formatId: '30232', destTemplate: 'd', cookieFile: 'C:/c.txt', proxy: '' })
  assert.ok(args.includes('--cookies'))
  assert.ok(args.includes('C:/c.txt'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/ytdlp-audio.test.mjs`
Expected: FAIL —— `AUDIO_FORMAT_ID is not defined`

- [ ] **Step 3: 写最小实现**

追加到 `src/media/ytdlp.js`，**并在文件顶部的 import 区补上**：

```js
import { readdir, rename, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
```

```js
/** 实测到的 B 站音轨档位（规格 F29）。显式指定比 bestaudio 可预测得多。 */
export const AUDIO_FORMAT_ID = {
  balanced: '30232', // AAC-LC 103 kbps
  smallest: '30216', // HE-AAC 44 kbps
  best: '30280',     // AAC-LC 204 kbps
}

export function buildAudioArgs(url, { formatId, destTemplate, cookieFile, proxy = '' }) {
  const args = [
    '-f', formatId,
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    `--proxy=${proxy}`,
    '-o', destTemplate,
  ]
  if (cookieFile) args.push('--cookies', cookieFile)
  args.push(url)
  return args
}

/**
 * 下载音轨到 destPath。yt-dlp 的 -o 是模板，实际扩展名由它决定，
 * 所以下载后要把真实文件改名为 destPath。
 * @returns 实际文件路径
 */
export async function downloadAudio(config, url, destPath, { cookieFile, signal, onProgress } = {}) {
  const proxy = childEnv(config, 'bilibili').__proxy ?? ''
  const formatId = AUDIO_FORMAT_ID[config.audioQuality] ?? AUDIO_FORMAT_ID.balanced
  const destDir = dirname(destPath)
  const stem = basename(destPath, extname(destPath))
  const template = join(destDir, `${stem}.%(ext)s`)

  onProgress?.({ phase: 'audio', formatId })
  await runYtDlp(config, buildAudioArgs(url, { formatId, destTemplate: template, cookieFile, proxy }), { signal })

  // 找到 yt-dlp 实际写出的文件（扩展名可能是 m4a/webm）
  const entries = await readdir(destDir).catch(() => [])
  const produced = entries.find((n) => n.startsWith(`${stem}.`) && !n.endsWith('.part'))
  if (!produced) {
    throw new BiliDigestError('AUDIO_DOWNLOAD_FAILED', 'yt-dlp 完成了但没有产出音频文件', `期望在 ${destDir} 下看到 ${stem}.*`)
  }
  const producedPath = join(destDir, produced)
  if (producedPath !== destPath) await rename(producedPath, destPath)
  const info = await stat(destPath)
  if (info.size === 0) {
    throw new BiliDigestError('AUDIO_DOWNLOAD_FAILED', '下载到的音频是空文件', `路径：${destPath}`)
  }
  onProgress?.({ phase: 'audio', done: true, bytes: info.size })
  return destPath
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/ytdlp-audio.test.mjs`
Expected: PASS

```bash
git add src/media/ytdlp.js test/ytdlp-audio.test.mjs
git commit -m "feat(bili-digest): 音频下载（显式 format_id）"
```

---

## Task 13: 本地识别适配（ctx.speechToText）

**Files:**
- Create: `src/asr/sensevoice.js`
- Create: `test/asr.test.mjs`

**Interfaces:**
- Consumes: `buildPcmWav`（Task 10）、`BiliDigestError`（Task 2）
- Produces:
  - `getService(ctx): object|undefined` —— `ctx.get('speechToText')`
  - `pickProvider(service, preferred): string` —— 返回 provider id
  - `ensureReady(service, providerId, onProgress, signal): Promise<string>`
  - `transcribeClips(service, { clips, samples, language }, onProgress, signal): Promise<Segment[]>`
  - `STT_LANGUAGES = ['auto','zh','en','yue','ja','ko']`

- [ ] **Step 1: 写失败测试**

`test/asr.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { getService, pickProvider, ensureReady, transcribeClips, STT_LANGUAGES } from '../src/asr/sensevoice.js'
import { buildPcmWav } from '../src/audio/window.js'

/** 造一个假的 speechToText 服务，形状对齐真实服务。 */
function fakeService({ phase = 'ready', texts = ['甲', '乙'] } = {}) {
  const calls = []
  return {
    calls,
    snapshot: () => ({
      providers: [{ id: 'sensevoice-local', languages: STT_LANGUAGES, preparation: { phase } }],
      selection: { providerId: 'sensevoice-local', language: 'auto' },
    }),
    prepare: (id) => { calls.push(['prepare', id]) },
    async *follow() { yield { providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }] } },
    resolve: (req) => ({ ...req, provider: { info: { id: 'sensevoice-local' } } }),
    transcribe: async (spec) => {
      calls.push(['transcribe', spec.language, spec.audio.length])
      return { text: texts[calls.filter((c) => c[0] === 'transcribe').length - 1] ?? '' }
    },
  }
}

const ctx = (service) => ({ get: (name) => (name === 'speechToText' ? service : undefined) })

test('getService 从 ctx 取服务，缺失返回 undefined', () => {
  assert.ok(getService(ctx(fakeService())))
  assert.equal(getService({ get: () => undefined }), undefined)
})

test('pickProvider 优先用显式配置', () => {
  assert.equal(pickProvider(fakeService(), 'other'), 'other')
  assert.equal(pickProvider(fakeService(), ''), 'sensevoice-local')
})

test('服务缺失时抛 STT_UNAVAILABLE', async () => {
  await assert.rejects(() => ensureReady(undefined, 'x', () => {}, undefined), (e) => e.code === 'STT_UNAVAILABLE')
})

test('provider 不 ready 时触发 prepare', async () => {
  const svc = fakeService({ phase: 'idle' })
  await ensureReady(svc, 'sensevoice-local', () => {}, undefined)
  assert.deepEqual(svc.calls[0], ['prepare', 'sensevoice-local'])
})

test('provider 已 ready 时不触发 prepare', async () => {
  const svc = fakeService({ phase: 'ready' })
  await ensureReady(svc, 'sensevoice-local', () => {}, undefined)
  assert.equal(svc.calls.length, 0)
})

test('transcribeClips 逐片调用并保留时间轴', async () => {
  const svc = fakeService()
  const samples = new Int16Array(16000 * 4)
  const clips = [
    { startSample: 0, endSample: 16000, startSec: 0, endSec: 1 },
    { startSample: 16000, endSample: 32000, startSec: 1, endSec: 2 },
  ]
  const segs = await transcribeClips(svc, { clips, samples, language: 'zh' }, () => {}, undefined)
  assert.deepEqual(segs, [
    { start: 0, end: 1, text: '甲' },
    { start: 1, end: 2, text: '乙' },
  ])
})

test('转写走的是规范 WAV', async () => {
  const svc = fakeService()
  const samples = new Int16Array(200)
  const clips = [{ startSample: 0, endSample: 200, startSec: 0, endSec: 0.0125 }]
  await transcribeClips(svc, { clips, samples, language: 'zh' }, () => {}, undefined)
  const len = svc.calls.find((c) => c[0] === 'transcribe')[2]
  assert.equal(len, 44 + 200 * 2)
})

test('空文本片段保留在时间轴里', async () => {
  const svc = fakeService({ texts: ['', '乙'] })
  const samples = new Int16Array(32000)
  const clips = [
    { startSample: 0, endSample: 16000, startSec: 0, endSec: 1 },
    { startSample: 16000, endSample: 32000, startSec: 1, endSec: 2 },
  ]
  const segs = await transcribeClips(svc, { clips, samples, language: 'zh' }, () => {}, undefined)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].text, '')
})

test('buildPcmWav 结果能被假服务读到正确长度', () => {
  assert.equal(buildPcmWav(new Int16Array(10)).length, 64)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/asr.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/asr/sensevoice.js`：

```js
import { BiliDigestError } from '../errors.js'
import { buildPcmWav } from '../audio/window.js'

export const STT_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/**
 * 取语音服务。**不 import @deepseek-ai/dsh-experimental-speech-to-text**
 * （规格 F11：第三方插件解析不到该包），只按结构调用。
 */
export function getService(ctx) {
  return ctx?.get?.('speechToText') ?? undefined
}

/** 选 provider：显式配置优先，否则用服务当前选择。 */
export function pickProvider(service, preferred) {
  if (preferred) return preferred
  const selected = service?.snapshot?.()?.selection?.providerId
  if (selected) return selected
  const first = service?.snapshot?.()?.providers?.[0]?.id
  if (first) return first
  throw new BiliDigestError('STT_UNAVAILABLE', '没有可用的语音识别 Provider', '确认已启用 dsh-experimental-voice-input-bundle。')
}

function phaseOf(service, providerId) {
  const providers = service?.snapshot?.()?.providers ?? []
  return providers.find((p) => p.id === providerId)?.preparation?.phase ?? 'unknown'
}

/**
 * 确保 provider 就绪。首次会下载 SenseVoice int8 模型（239 MB），必须让用户看见进度。
 * @returns providerId
 */
export async function ensureReady(service, providerId, onProgress, signal) {
  if (!service) {
    throw new BiliDigestError('STT_UNAVAILABLE', '本地语音识别服务不可用', '确认 DSH 组合里启用了 dsh-experimental-voice-input-bundle。')
  }
  if (phaseOf(service, providerId) === 'ready') return providerId

  onProgress?.({ phase: 'transcribe', detail: 'prepare', providerId })
  service.prepare?.(providerId)
  try {
    for await (const snap of service.follow(signal)) {
      const provider = (snap?.providers ?? []).find((p) => p.id === providerId)
      onProgress?.({ phase: 'transcribe', detail: 'prepare', providerId, state: provider?.preparation })
      if (provider?.preparation?.phase === 'ready') return providerId
      if (signal?.aborted) throw new BiliDigestError('CANCELLED', '已取消')
    }
  } catch (err) {
    if (err instanceof BiliDigestError) throw err
    throw new BiliDigestError('STT_MODEL_MISSING', `语音模型准备失败：${err?.message ?? err}`, '首次使用需下载约 239 MB 的 SenseVoice int8 模型；检查网络或 HuggingFace 镜像设置。', err)
  }
  return providerId
}

/**
 * 逐片转写。**串行**——provider 的 worker 是单进程串行的。
 * @param clips planSegments 的输出
 * @param samples 完整 PCM
 * @returns Segment[]（秒），空文本片段也保留以维持时间轴连续
 */
export async function transcribeClips(service, { clips, samples, language }, onProgress, signal) {
  const segments = []
  const lang = STT_LANGUAGES.includes(language) ? language : 'auto'
  for (let i = 0; i < clips.length; i++) {
    signal?.throwIfAborted()
    const clip = clips[i]
    const audio = buildPcmWav(samples.subarray(clip.startSample, clip.endSample))
    let text = ''
    try {
      const spec = service.resolve({ audio, language: lang })
      const result = await service.transcribe(spec, signal)
      text = String(result?.text ?? '').trim()
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw new BiliDigestError('CANCELLED', '已取消')
      throw new BiliDigestError('STT_FAILED', `第 ${i + 1}/${clips.length} 片识别失败：${err?.message ?? err}`, '可以重跑；已完成的阶段会被复用。', err)
    }
    segments.push({ start: clip.startSec, end: clip.endSec, text })
    onProgress?.({ phase: 'transcribe', done: i + 1, total: clips.length, chars: text.length })
  }
  return segments
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/asr.test.mjs`
Expected: PASS

```bash
git add src/asr/sensevoice.js test/asr.test.mjs
git commit -m "feat(bili-digest): ctx.speechToText 适配（逐片串行转写）"
```

---

## Task 14: 转写后端选择（P0 只有本地）

**Files:**
- Create: `src/asr/index.js`
- Create: `test/asr-select.test.mjs`

**Interfaces:**
- Consumes: `getService` / `pickProvider` / `ensureReady` / `transcribeClips`（Task 13）、`planSegments`（Task 11）、`resolveFfmpeg`（Task 6）、`toWav16k`（Task 9）、`downloadAudio`（Task 12）、`parsePcmWav`（Task 10）
- Produces:
  - `transcribeAll(ctx, config, { probe, audioPath, wavPath, language }, onProgress, signal): Promise<Transcript>`，其中 `Transcript = { source:'subtitle'|'local', precision:'sentence'|'window', language, segments, chapters, notes:string[] }`
  - `LOCAL_WINDOW_PRECISION = 'window'`

- [ ] **Step 1: 写失败测试**

`test/asr-select.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { transcribeAll } from '../src/asr/index.js'
import { buildPcmWav } from '../src/audio/window.js'
import { resolveConfig } from '../src/config.js'

function fakeService() {
  return {
    snapshot: () => ({
      providers: [{ id: 'sensevoice-local', languages: ['auto', 'zh'], preparation: { phase: 'ready' } }],
      selection: { providerId: 'sensevoice-local' },
    }),
    resolve: (r) => r,
    transcribe: async () => ({ text: '内容' }),
  }
}

/** 写一个 3 秒的 16k 单声道 wav 到临时目录。 */
async function makeWav(dir, seconds = 3) {
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const samples = new Int16Array(Math.round(16000 * seconds))
  const p = join(dir, 'audio.wav')
  await writeFile(p, Buffer.from(buildPcmWav(samples)))
  return p
}

test('本地通路产出 window 精度并标注来源', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'asr-'))
  const wavPath = await makeWav(dir)
  const cfg = resolveConfig({ cacheDir: dir, windowSeconds: 30 })
  const ctx = { get: (n) => (n === 'speechToText' ? fakeService() : undefined) }

  const t = await transcribeAll(ctx, cfg, { probe: { title: 't', duration: 3, chapters: [] }, wavPath }, () => {}, undefined)
  assert.equal(t.source, 'local')
  assert.equal(t.precision, 'window')
  assert.equal(t.windowSeconds, 30)
  assert.equal(t.segments.length, 1)
  assert.equal(t.segments[0].text, '内容')
  assert.deepEqual(t.chapters, [])
  assert.deepEqual(t.notes, [])
  await rm(dir, { recursive: true, force: true })
})

test('未配 SESSDATA 时明确标注「已跳过字幕通路」，且不声称视频有字幕', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'asr-'))
  const wavPath = await makeWav(dir)
  const cfg = resolveConfig({ cacheDir: dir })
  const ctx = { get: (n) => (n === 'speechToText' ? fakeService() : undefined) }

  const t = await transcribeAll(ctx, cfg, { probe: { title: 't', duration: 3, chapters: [] }, wavPath }, () => {}, undefined)
  assert.equal(t.notes.length, 1)
  assert.match(t.notes[0], /未配置 BILI_SESSDATA/)
  assert.doesNotMatch(t.notes[0], /该视频有字幕/)
  await rm(dir, { recursive: true, force: true })
})

test('--no-local 且字幕不可用时抛 BILI_NEEDS_LOGIN', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'asr-'))
  const cfg = resolveConfig({ cacheDir: dir })
  const ctx = { get: (n) => (n === 'speechToText' ? fakeService() : undefined) }
  await assert.rejects(
    () => transcribeAll(ctx, cfg, { probe: { duration: 3, chapters: [] }, wavPath: 'x', noLocal: true }, () => {}, undefined),
    (e) => e.code === 'BILI_NEEDS_LOGIN',
  )
  await rm(dir, { recursive: true, force: true })
})

test('无 speechToText 服务且字幕不可用时抛 STT_UNAVAILABLE', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'asr-'))
  const wavPath = await makeWav(dir)
  const cfg = resolveConfig({ cacheDir: dir })
  await assert.rejects(
    () => transcribeAll({ get: () => undefined }, cfg, { probe: { duration: 3, chapters: [] }, wavPath }, () => {}, undefined),
    (e) => e.code === 'STT_UNAVAILABLE',
  )
  await rm(dir, { recursive: true, force: true })
})

test('全空文本仍返回片段但打上 STT_EMPTY 标记（由调用方决定是否报错）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'asr-'))
  const wavPath = await makeWav(dir)
  const cfg = resolveConfig({ cacheDir: dir })
  const empty = { ...fakeService(), transcribe: async () => ({ text: '' }) }
  const ctx = { get: (n) => (n === 'speechToText' ? empty : undefined) }
  const t = await transcribeAll(ctx, cfg, { probe: { duration: 3, chapters: [] }, wavPath }, () => {}, undefined)
  assert.equal(t.segments.every((s) => s.text === ''), true)
  assert.ok(t.notes.some((n) => /没有识别到任何文字/.test(n)))
  await rm(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/asr-select.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/asr/index.js`：

```js
import { BiliDigestError } from '../errors.js'
import { parsePcmWav, planSegments } from '../audio/window.js'
import { ensureReady, getService, pickProvider, transcribeClips } from './sensevoice.js'

export const LOCAL_WINDOW_PRECISION = 'window'

const NO_CREDENTIAL_NOTE = '未配置 BILI_SESSDATA，已跳过字幕通路，改用本地识别'
const EMPTY_NOTE = '本地识别没有识别到任何文字，可能是纯音乐或无人声视频；这不代表成功。'

/**
 * 选择转写后端并执行。P0 只有本地通路；字幕通路留的接口在这里。
 *
 * 回退必须**显式**：notes 会写进命令回执与 Markdown 头部，绝不静默降级。
 *
 * @returns {{ source:'subtitle'|'local', precision:'sentence'|'window',
 *             language:string, segments:Array, chapters:Array, notes:string[] }}
 */
export async function transcribeAll(ctx, config, { probe, wavPath, noLocal = false, hasCredential = false }, onProgress, signal) {
  const notes = []
  const chapters = probe?.chapters ?? []

  // P0：字幕通路尚未实现。配了凭据也走本地，并如实说明。
  if (hasCredential) {
    notes.push('字幕通路尚未实现（P1），已使用本地识别')
  } else {
    notes.push(NO_CREDENTIAL_NOTE)
  }

  if (noLocal) {
    throw new BiliDigestError(
      'BILI_NEEDS_LOGIN',
      '字幕不可用，且已用 --no-local 禁用本地识别',
      '配置 BILI_SESSDATA 以启用字幕通路（P1 实现），或去掉 --no-local。',
    )
  }

  const service = getService(ctx)
  if (!service) {
    throw new BiliDigestError('STT_UNAVAILABLE', '本地语音识别服务不可用', '启用 dsh-experimental-voice-input-bundle，或配置 BILI_SESSDATA 走字幕通路。')
  }

  const providerId = pickProvider(service, config.sttProvider)
  await ensureReady(service, providerId, onProgress, signal)

  onProgress?.({ phase: 'window' })
  const buffer = await (await import('node:fs/promises')).readFile(wavPath)
  const { sampleRate, samples } = parsePcmWav(buffer)
  const clips = planSegments({
    sampleRate,
    samples,
    targetSec: config.windowSeconds,
    minSec: config.minSegmentSeconds,
    snapSec: config.snapSeconds,
  })
  onProgress?.({ phase: 'window', clips: clips.length, durationSec: samples.length / sampleRate })

  const segments = await transcribeClips(service, { clips, samples, language: config.language }, onProgress, signal)
  if (segments.every((s) => s.text === '')) notes.push(EMPTY_NOTE)

  return {
    source: 'local',
    precision: LOCAL_WINDOW_PRECISION,
    language: config.language,
    // 窗口长度必须随转写一起传下去：下游渲染回执时要如实标注，
    // 不能靠 duration/片段数反推（那样算出来是错的）。
    windowSeconds: config.windowSeconds,
    segments,
    chapters,
    notes,
  }
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/asr-select.test.mjs`
Expected: PASS

```bash
git add src/asr/index.js test/asr-select.test.mjs
git commit -m "feat(bili-digest): 转写后端选择与显式回退"
```

---

## Task 15: 证据包组装

**Files:**
- Create: `src/evidence.js`
- Create: `test/evidence.test.mjs`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `assemble({ probe, transcript }): Evidence`，`Evidence = { meta, chapters, transcript, frames }`
  - `toPromptBlock(evidence, { maxKeyPoints }): string`
  - `transcriptChars(evidence): number`

- [ ] **Step 1: 写失败测试**

`test/evidence.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { assemble, toPromptBlock, transcriptChars } from '../src/evidence.js'

const probe = {
  id: 'BV1GJ411x7h7',
  title: '测试视频',
  duration: 212.393,
  uploader: '某人',
  webpageUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  description: '简介',
  tags: ['a', 'b'],
  chapters: [],
}
const transcript = {
  source: 'local',
  precision: 'window',
  language: 'zh',
  windowSeconds: 30,
  segments: [
    { start: 0, end: 30, text: '第一段' },
    { start: 30, end: 60, text: '' },
    { start: 60, end: 90, text: '第三段' },
  ],
  chapters: [],
  notes: [],
}

test('assemble 产出四段结构', () => {
  const e = assemble({ probe, transcript })
  assert.deepEqual(Object.keys(e).sort(), ['chapters', 'frames', 'meta', 'transcript'])
  assert.equal(e.meta.title, '测试视频')
  assert.deepEqual(e.frames, [], '本轮 frames 恒为空')
})

test('assemble 缺 probe 字段时不炸', () => {
  const e = assemble({ probe: { id: 'BVx' }, transcript })
  assert.equal(e.meta.title, 'BVx')
  assert.equal(e.meta.duration, 0)
})

test('toPromptBlock 含元信息、来源、精度与带时间戳的转写', () => {
  const block = toPromptBlock(assemble({ probe, transcript }), {})
  assert.match(block, /视频标题：测试视频/)
  assert.match(block, /视频时长：212\.393/)
  assert.match(block, /转写来源：本地识别（窗口 30s，静音点对齐）/)
  assert.match(block, /转写精度：窗口级/)
  assert.match(block, /\[00:00-00:30\] 第一段/)
  assert.match(block, /\[01:00-01:30\] 第三段/)
})

test('toPromptBlock 跳过空文本片段但仍推进时间轴', () => {
  const block = toPromptBlock(assemble({ probe, transcript }), {})
  assert.doesNotMatch(block, /00:30-01:00\] \S/)
  assert.match(block, /01:00-01:30/)
})

test('toPromptBlock 在有 UP 主章节时输出章节段落', () => {
  const p = { ...probe, chapters: [{ start: 0, end: 90, title: '开场' }, { start: 90, end: 200, title: '正题' }] }
  const block = toPromptBlock(assemble({ probe: p, transcript }), {})
  assert.match(block, /UP主章节：/)
  assert.match(block, /\[00:00-01:30\] 开场/)
  assert.match(block, /\[01:30-03:20\] 正题/)
})

test('toPromptBlock 无 UP 主章节时不输出该段落', () => {
  const block = toPromptBlock(assemble({ probe, transcript }), {})
  assert.doesNotMatch(block, /UP主章节：/)
})

test('toPromptBlock 在 frames 非空时输出关键帧段落', () => {
  const e = assemble({ probe, transcript })
  e.frames = [{ time: 12, text: 'PPT 标题页' }]
  const block = toPromptBlock(e, {})
  assert.match(block, /关键帧：/)
  assert.match(block, /\[00:12\] PPT 标题页/)
})

test('transcriptChars 只统计转写正文', () => {
  assert.equal(transcriptChars(assemble({ probe, transcript })), '第一段第三段'.length)
})

test('字幕来源的精度标注为句级', () => {
  const t = { ...transcript, source: 'subtitle', precision: 'sentence' }
  const block = toPromptBlock(assemble({ probe, transcript: t }), {})
  assert.match(block, /转写来源：B站字幕（句级）/)
  assert.match(block, /转写精度：句级/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/evidence.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/evidence.js`：

```js
/** 秒 → mm:ss（超过一小时用 h:mm:ss）。纯函数。 */
export function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}

/**
 * 证据包组装。**这是唯一的证据聚合点。**
 *
 * digest 的输入是证据包而不是一段文本：转写只是其中一种证据源，
 * 而且它只覆盖"有口播"的视频。把结构定下来，将来加画面/弹幕证据源
 * 就只是多一个字段，digest 之后的所有环节不用动。
 *
 * @returns {{ meta:object, chapters:Array, transcript:object, frames:Array }}
 */
export function assemble({ probe = {}, transcript = {} }) {
  return {
    meta: {
      id: String(probe.id ?? ''),
      title: String(probe.title ?? probe.id ?? '未命名视频'),
      duration: Number(probe.duration ?? 0),
      uploader: String(probe.uploader ?? ''),
      webpageUrl: String(probe.webpageUrl ?? ''),
      description: String(probe.description ?? ''),
      tags: Array.isArray(probe.tags) ? probe.tags.map(String) : [],
    },
    chapters: Array.isArray(transcript.chapters) && transcript.chapters.length > 0
      ? transcript.chapters
      : (Array.isArray(probe.chapters) ? probe.chapters : []),
    transcript: {
      source: transcript.source ?? 'local',
      precision: transcript.precision ?? 'window',
      language: transcript.language ?? 'auto',
      windowSeconds: Number(transcript.windowSeconds ?? 0),
      segments: Array.isArray(transcript.segments) ? transcript.segments : [],
    },
    // L2 证据源（关键帧 / B站AI总结 / 弹幕热区）本轮不实现，恒为空数组
    frames: [],
  }
}

/** 只统计转写正文的字符数，用于产出密度体检。 */
export function transcriptChars(evidence) {
  return evidence.transcript.segments.reduce((sum, s) => sum + String(s.text ?? '').length, 0)
}

/**
 * 证据包 → 喂给 LLM 的文本块。纯函数。
 *
 * 注意这里**没有** maxKeyPoints 之类的指令——那些属于系统提示词（digest/prompt.js）。
 * 本函数只负责"把证据摆出来"。
 */
export function toPromptBlock(evidence) {
  const { meta, chapters, transcript, frames } = evidence
  const lines = [
    `视频标题：${meta.title}`,
    `视频时长：${meta.duration} 秒`,
  ]
  if (meta.uploader) lines.push(`UP 主：${meta.uploader}`)

  const sourceLabel = transcript.source === 'subtitle'
    ? 'B站字幕（句级）'
    : `本地识别（窗口 ${Math.max(1, Math.round(transcript.windowSeconds || 30))}s，静音点对齐）`
  lines.push(`转写来源：${sourceLabel}`)
  lines.push(`转写精度：${transcript.precision === 'sentence' ? '句级' : '窗口级'}`)

  if (Array.isArray(chapters) && chapters.length > 0) {
    lines.push('UP主章节：')
    for (const c of chapters) lines.push(`  [${formatTime(c.start)}-${formatTime(c.end)}] ${c.title}`)
  }

  if (Array.isArray(frames) && frames.length > 0) {
    lines.push('')
    lines.push('关键帧：')
    for (const f of frames) lines.push(`  [${formatTime(f.time)}] ${f.text}`)
  }

  lines.push('')
  lines.push('带时间戳的转写：')
  for (const s of transcript.segments) {
    const text = String(s.text ?? '').trim()
    if (text === '') continue // 空片段跳过正文，但时间轴由相邻片段自然体现
    lines.push(`[${formatTime(s.start)}-${formatTime(s.end)}] ${text}`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/evidence.test.mjs`
Expected: PASS

```bash
git add src/evidence.js test/evidence.test.mjs
git commit -m "feat(bili-digest): 证据包组装与提示词文本块"
```

---

## Task 16: 提示词与 LLM 调用

**Files:**
- Create: `src/digest/prompt.js`
- Create: `src/digest/llm.js`
- Create: `test/prompt.test.mjs`
- Create: `test/llm.test.mjs`

**Interfaces:**
- Consumes: `evidence.toPromptBlock`（Task 15）、`BiliDigestError`（Task 2）
- Produces:
  - `SYSTEM_PROMPT: string`
  - `buildMessages(evidenceBlock, { retry, maxKeyPoints }): Array<{role,content}>`
  - `extractJson(text): object` —— 剥 ``` 围栏后解析；失败抛
  - `streamText(llm, { provider, model, messages, signal }): Promise<string>`
  - `resolvedModel(ctx, config, override): { provider, model }`
  - `summarize(ctx, config, evidence, { override }, signal): Promise<DigestJson>`

- [ ] **Step 1: 写失败测试**

`test/prompt.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { SYSTEM_PROMPT, buildMessages } from '../src/digest/prompt.js'

test('系统提示词要求纯 JSON 且禁止编造时间', () => {
  assert.match(SYSTEM_PROMPT, /只输出一个 JSON 对象/)
  assert.match(SYSTEM_PROMPT, /不允许编造时间|只能取给定的时间点/)
  assert.match(SYSTEM_PROMPT, /首尾相接/)
})

test('系统提示词给出完整 JSON 契约', () => {
  for (const key of ['title', 'tldr', 'keyPoints', 'chapters', 'quotes']) {
    assert.ok(SYSTEM_PROMPT.includes(key), `契约缺少 ${key}`)
  }
})

test('buildMessages 产出 system + user 两条', () => {
  const msgs = buildMessages('证据正文', {})
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[0].content, SYSTEM_PROMPT)
  assert.equal(msgs[1].role, 'user')
  assert.match(msgs[1].content, /证据正文/)
})

test('buildMessages 的 retry 版本追加 JSON 纠正语', () => {
  const first = buildMessages('X', {}).at(-1).content
  const retry = buildMessages('X', { retry: true }).at(-1).content
  assert.notEqual(first, retry)
  assert.match(retry, /不是合法 JSON/)
})

test('buildMessages 把 maxKeyPoints 接进提示词（否则这个配置是死的）', () => {
  assert.match(buildMessages('X', { maxKeyPoints: 5 }).at(-1).content, /核心要点最多 5 条/)
  assert.match(buildMessages('X', {}).at(-1).content, /核心要点最多 8 条/, '默认 8')
  assert.match(buildMessages('X', { maxKeyPoints: 0 }).at(-1).content, /最多 8 条/, '非法值回落到默认')
})
```

`test/llm.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, streamText, resolvedModel } from '../src/digest/llm.js'

/** 造一个流式 LLM 桩：按 text-delta 分片吐出给定文本。 */
function fakeLlm(chunks, { fail } = {}) {
  return {
    async *stream() {
      if (fail) {
        yield { type: 'finish', kind: 'error', failure: { code: fail } }
        return
      }
      for (const c of chunks) yield { type: 'text-delta', text: c }
      yield { type: 'finish', kind: 'stop' }
    },
  }
}

test('extractJson 直接解析裸 JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
})

test('extractJson 剥掉 markdown 围栏', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 })
})

test('extractJson 容忍前后空白与说明文字', () => {
  assert.deepEqual(extractJson('好的，结果如下：\n{"a":1}\n希望有帮助'), { a: 1 })
})

test('extractJson 对无法解析的内容抛 DIGEST_SCHEMA_INVALID', () => {
  assert.throws(() => extractJson('完全不是 JSON'), (e) => e.code === 'DIGEST_SCHEMA_INVALID')
})

test('streamText 拼接 text-delta 分片', async () => {
  const text = await streamText(fakeLlm(['{"a"', ':1}']), { provider: 'p', model: 'm', messages: [] }, undefined)
  assert.equal(text, '{"a":1}')
})

test('streamText 忽略非 text-delta 分片', async () => {
  const llm = { async *stream() { yield { type: 'block-start' }; yield { type: 'text-delta', text: 'x' }; yield { type: 'usage' } } }
  assert.equal(await streamText(llm, { provider: 'p', model: 'm', messages: [] }, undefined), 'x')
})

test('streamText 把 CONTEXT_WINDOW_EXCEEDED 映射为 LLM_CONTEXT_EXCEEDED', async () => {
  await assert.rejects(
    () => streamText(fakeLlm([], { fail: 'CONTEXT_WINDOW_EXCEEDED' }), { provider: 'p', model: 'm', messages: [] }, undefined),
    (e) => e.code === 'LLM_CONTEXT_EXCEEDED',
  )
})

test('streamText 把 RATE_LIMIT 映射为 LLM_RATE_LIMIT', async () => {
  await assert.rejects(
    () => streamText(fakeLlm([], { fail: 'RATE_LIMIT' }), { provider: 'p', model: 'm', messages: [] }, undefined),
    (e) => e.code === 'LLM_RATE_LIMIT',
  )
})

test('streamText 对其它失败码映射为 LLM_FAILED 并保留原码', async () => {
  await assert.rejects(
    () => streamText(fakeLlm([], { fail: 'AUTH' }), { provider: 'p', model: 'm', messages: [] }, undefined),
    (e) => e.code === 'LLM_FAILED' && /AUTH/.test(e.message),
  )
})

test('resolvedModel 优先 --model 覆盖', () => {
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'agent-p', model: 'agent-m' }) }) }
  assert.deepEqual(resolvedModel(ctx, { summaryModel: { provider: 'c-p', model: 'c-m' } }, 'x/y'), { provider: 'x', model: 'y' })
})

test('resolvedModel 回落到配置', () => {
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'agent-p', model: 'agent-m' }) }) }
  assert.deepEqual(resolvedModel(ctx, { summaryModel: { provider: 'c-p', model: 'c-m' } }, ''), { provider: 'c-p', model: 'c-m' })
})

test('resolvedModel 再回落到 agent 默认模型', () => {
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'agent-p', model: 'agent-m' }) }) }
  assert.deepEqual(resolvedModel(ctx, { summaryModel: { provider: '', model: '' } }, ''), { provider: 'agent-p', model: 'agent-m' })
})

test('resolvedModel 无任何来源时抛 LLM_UNAVAILABLE', () => {
  assert.throws(() => resolvedModel({ get: () => undefined }, { summaryModel: { provider: '', model: '' } }, ''), (e) => e.code === 'LLM_UNAVAILABLE')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/prompt.test.mjs test/llm.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/digest/prompt.js`：

```js
export const SYSTEM_PROMPT = `你是视频内容分析助手。用户会给你一个视频的元信息、可能的 UP 主章节，以及带时间戳的转写文本。你要产出一份结构化摘要。

严格规则：
1. 只输出一个 JSON 对象。不要 markdown 代码块，不要任何解释文字。
2. 章节边界只能取文中给出的时间点，不允许编造时间。宁可让边界粗一点，也不要凭空发明一个时间。
3. 章节必须首尾相接、覆盖全片：第一段从 00:00 开始，最后一段到视频结束，中间不留空隙、不重叠。
4. 若文中给了 UP 主章节，以其为骨架：可以合并过短的、可以细分过长的，但不得与其大幅冲突。
5. keyPoints 每一条都必须能在转写里找到依据。找不到依据的不要写。
6. 不确定时宁可少划分章节，不要把内容切碎。

输出契约（字段名与类型必须完全一致）：
{
  "title": "string，视频标题的简洁版",
  "tldr": "string，3-5 句话的一句话总结",
  "keyPoints": [{ "time": 754, "text": "string" }],
  "chapters": [{
    "start": 0,
    "end": 192,
    "title": "string，不超过 20 字",
    "summary": "string，这一章讲了什么",
    "points": ["string"]
  }],
  "quotes": [{ "time": 754, "text": "string，原文引用" }]
}

说明：time 与 start/end 都是**秒数**（整数），不是时间字符串。`

/**
 * 构造发给模型的消息。**本模块不读 probe / transcript**——
 * 证据由 evidence.toPromptBlock() 摆好，这样新增证据源时这里不用改。
 */
export function buildMessages(evidenceBlock, { retry = false, maxKeyPoints = 8 } = {}) {
  const cap = Number.isFinite(maxKeyPoints) && maxKeyPoints > 0 ? Math.round(maxKeyPoints) : 8
  let user = `${evidenceBlock}\n\n核心要点最多 ${cap} 条。`
  if (retry) {
    user += '\n\n注意：你上一次的输出不是合法 JSON。请这次只输出一个 JSON 对象，不要任何其它文字或代码块围栏。'
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}
```

`src/digest/llm.js`：

```js
import { BiliDigestError } from '../errors.js'
import { buildMessages } from './prompt.js'
import { toPromptBlock } from '../evidence.js'

/** 从模型输出里抠出 JSON。允许围栏与前后说明文字。 */
export function extractJson(text) {
  let s = String(text ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()
  try {
    return JSON.parse(s)
  } catch {
    // 退一步：取第一个 { 到最后一个 }
    const from = s.indexOf('{')
    const to = s.lastIndexOf('}')
    if (from >= 0 && to > from) {
      try { return JSON.parse(s.slice(from, to + 1)) } catch { /* 落到下面统一抛 */ }
    }
    throw new BiliDigestError('DIGEST_SCHEMA_INVALID', '模型输出不是合法 JSON', `输出前 200 字：${s.slice(0, 200)}`)
  }
}

const FAILURE_MAP = {
  CONTEXT_WINDOW_EXCEEDED: ['LLM_CONTEXT_EXCEEDED', '转写超出了模型的上下文窗口', '换一个上下文更大的模型（用 --model），或换更短的视频。'],
  RATE_LIMIT: ['LLM_RATE_LIMIT', '模型服务限流', '稍后重试；已完成的阶段会被复用。'],
  QUOTA: ['LLM_FAILED', '模型额度不足', '检查提供方账户余额。'],
  ACCOUNT_QUOTA: ['LLM_FAILED', '账户余额不足', '检查提供方账户余额。'],
  AUTH: ['LLM_FAILED', '模型认证失败', '检查提供方凭据配置。'],
  NO_ADAPTER: ['LLM_UNAVAILABLE', '没有匹配的模型提供方', '检查 profile 里的 provider 配置。'],
}

/**
 * 消费流式分片，只取 text-delta。
 * **不用 BlockAssembler**（规格 F11：不 import @deepseek-ai/*），手工拼接足够。
 */
export async function streamText(llm, { provider, model, messages, temperature = 0.2, maxTokens = 8192 }, signal) {
  let out = ''
  for await (const chunk of llm.stream({ provider, model, messages, temperature, maxTokens })) {
    signal?.throwIfAborted()
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text
      continue
    }
    if (chunk?.type === 'finish') {
      if (chunk.kind === 'error') {
        const code = chunk.failure?.code ?? 'UNKNOWN'
        const [mapped, message, hint] = FAILURE_MAP[code] ?? ['LLM_FAILED', `模型请求失败（${code}）`, '可以重跑；已完成的阶段会被复用。']
        throw new BiliDigestError(mapped, message, hint)
      }
      if (chunk.kind === 'aborted') throw new BiliDigestError('CANCELLED', '已取消')
    }
  }
  return out
}

/** 解析用哪个模型：--model 覆盖 → 配置 → agent 默认模型。 */
export function resolvedModel(ctx, config, override) {
  if (override) {
    const [provider, ...rest] = String(override).split('/')
    const model = rest.join('/')
    if (provider && model) return { provider, model }
    throw new BiliDigestError('BAD_CONFIG', `--model 格式应为 <provider>/<model>，实得：${override}`, '例如 --model opencode-go/deepseek-v4.1-flash')
  }
  if (config.summaryModel?.provider && config.summaryModel?.model) {
    return { provider: config.summaryModel.provider, model: config.summaryModel.model }
  }
  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
  if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
  throw new BiliDigestError('LLM_UNAVAILABLE', '无法确定用哪个模型来总结', '在配置里设 summaryModel，或用 --model <provider>/<model>。')
}

/**
 * 调 LLM 拿结构化摘要。JSON 不合法时重试一次。
 * @returns DigestJson
 */
export async function summarize(ctx, config, evidence, { override } = {}, signal) {
  const llm = ctx?.get?.('llm')
  if (!llm?.stream) {
    throw new BiliDigestError('LLM_UNAVAILABLE', 'LLM 服务不可用', '确认 DSH 组合里挂载了 @deepseek-ai/dsh-llm 与至少一个 provider。')
  }
  const { provider, model } = resolvedModel(ctx, config, override)
  const block = toPromptBlock(evidence)

  let lastProblem = ''
  for (const retry of [false, true]) {
    const text = await streamText(llm, { provider, model, messages: buildMessages(block, { retry, maxKeyPoints: config.maxKeyPoints }) }, signal)
    try {
      return extractJson(text)
    } catch (err) {
      lastProblem = err instanceof BiliDigestError ? err.hint ?? err.message : String(err)
    }
  }
  throw new BiliDigestError('DIGEST_SCHEMA_INVALID', '模型两次都没有产出合法 JSON', lastProblem)
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/prompt.test.mjs test/llm.test.mjs`
Expected: PASS

```bash
git add src/digest/prompt.js src/digest/llm.js test/prompt.test.mjs test/llm.test.mjs
git commit -m "feat(bili-digest): 提示词、流式调用与 JSON 解析"
```

---

## Task 17: 章节校验与边界吸附

**Files:**
- Create: `src/digest/validate.js`
- Create: `test/validate.test.mjs`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `validateDigest(digest, { duration, segments, upChapters }): { ok:true, value:DigestJson, warnings:string[] } | { ok:false, problems:string[] }`
  - `snapToSegmentBoundary(seconds, bounds, tolerance): number`

- [ ] **Step 1: 写失败测试**

`test/validate.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDigest, snapToSegmentBoundary } from '../src/digest/validate.js'

/** 30 秒一段，共 4 段 → duration 120。 */
const segments = [
  { start: 0, end: 30, text: 'a' },
  { start: 30, end: 60, text: 'b' },
  { start: 60, end: 90, text: 'c' },
  { start: 90, end: 120, text: 'd' },
]
const base = {
  title: '标题',
  tldr: '总结',
  keyPoints: [{ time: 10, text: '要点' }],
  chapters: [
    { start: 0, end: 60, title: '上', summary: 's', points: ['p'] },
    { start: 60, end: 120, title: '下', summary: 's', points: ['p'] },
  ],
  quotes: [{ time: 95, text: '引用' }],
}

test('合法摘要通过校验', () => {
  const r = validateDigest(base, { duration: 120, segments })
  assert.equal(r.ok, true)
})

test('snapToSegmentBoundary 吸附到最近的边界', () => {
  const bounds = [0, 30, 60, 90, 120]
  assert.equal(snapToSegmentBoundary(58, bounds, 5), 60)
  assert.equal(snapToSegmentBoundary(62, bounds, 5), 60)
  assert.equal(snapToSegmentBoundary(75, bounds, 5), 75, '超出容差则原样返回')
})

test('时间超出时长被吸附回范围内', () => {
  const d = { ...base, chapters: [{ start: 0, end: 130, title: 'x', summary: 's', points: [] }] }
  const r = validateDigest(d, { duration: 120, segments })
  assert.equal(r.ok, true)
  assert.equal(r.value.chapters.at(-1).end, 120)
})

test('章节必须从 0 开始', () => {
  const d = { ...base, chapters: [{ start: 30, end: 120, title: 'x', summary: 's', points: [] }] }
  const r = validateDigest(d, { duration: 120, segments })
  assert.equal(r.ok, true)
  assert.equal(r.value.chapters[0].start, 0)
})

test('章节之间的空隙被补齐（首尾相接）', () => {
  const d = {
    ...base,
    chapters: [
      { start: 0, end: 30, title: 'a', summary: 's', points: [] },
      { start: 60, end: 120, title: 'b', summary: 's', points: [] },
    ],
  }
  const r = validateDigest(d, { duration: 120, segments })
  assert.equal(r.ok, true)
  assert.equal(r.value.chapters[0].end, r.value.chapters[1].start)
})

test('重叠章节被切开', () => {
  const d = {
    ...base,
    chapters: [
      { start: 0, end: 80, title: 'a', summary: 's', points: [] },
      { start: 60, end: 120, title: 'b', summary: 's', points: [] },
    ],
  }
  const r = validateDigest(d, { duration: 120, segments })
  assert.equal(r.ok, true)
  assert.equal(r.value.chapters[0].end, r.value.chapters[1].start)
})

test('过短章节被合并进相邻章', () => {
  const d = {
    ...base,
    chapters: [
      { start: 0, end: 115, title: 'a', summary: 's', points: [] },
      { start: 115, end: 120, title: 'b', summary: 's', points: [] },
    ],
  }
  const r = validateDigest(d, { duration: 120, segments })
  assert.equal(r.ok, true)
  assert.equal(r.value.chapters.length, 1)
})

test('章节数超过上限时合并最短的相邻对', () => {
  const many = []
  for (let i = 0; i < 8; i++) many.push({ start: i * 15, end: (i + 1) * 15, title: `c${i}`, summary: 's', points: [] })
  const r = validateDigest({ ...base, chapters: many }, { duration: 120, segments })
  assert.equal(r.ok, true)
  assert.ok(r.value.chapters.length <= Math.max(2, Math.ceil(120 / 60)))
})

test('缺字段被判为不合法', () => {
  const r = validateDigest({ title: 'x' }, { duration: 120, segments })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /tldr/.test(p)))
})

test('chapters 为空数组被判为不合法', () => {
  const r = validateDigest({ ...base, chapters: [] }, { duration: 120, segments })
  assert.equal(r.ok, false)
})

test('title 过长被判为不合法', () => {
  const r = validateDigest({ ...base, title: 'x'.repeat(31) }, { duration: 120, segments })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /title/.test(p)))
})

test('与 UP 主章节对齐时不产生告警', () => {
  const upChapters = [{ start: 0, end: 60, title: '上' }, { start: 60, end: 120, title: '下' }]
  const r = validateDigest(base, { duration: 120, segments, upChapters })
  assert.equal(r.ok, true)
  assert.deepEqual(r.warnings, [])
})

test('跨越 UP 主边界且两端都不对齐时产生告警（只告警，不判失败）', () => {
  const upChapters = [{ start: 0, end: 60, title: '上' }, { start: 60, end: 120, title: '下' }]
  const d = { ...base, chapters: [{ start: 0, end: 120, title: '一整段', summary: 's', points: [] }] }
  const r = validateDigest(d, { duration: 120, segments, upChapters })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.length >= 1)
  assert.match(r.warnings[0], /跨越了 UP 主章节边界/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/validate.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/digest/validate.js`：

```js
const MIN_CHAPTER_SEC = 30
const MAX_TITLE_CHARS = 30
const MAX_TLDR_CHARS = 400
const SNAP_TOLERANCE_SEC = 5
const GAP_TOLERANCE_SEC = 2
const UP_ALIGN_TOLERANCE_SEC = 30

/** 把秒数吸附到最近的边界；超出容差则原样返回。 */
export function snapToSegmentBoundary(seconds, bounds, tolerance) {
  let best = seconds
  let bestDelta = Infinity
  for (const b of bounds) {
    const d = Math.abs(b - seconds)
    if (d < bestDelta) { bestDelta = d; best = b }
  }
  return bestDelta <= tolerance ? best : seconds
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function collectProblems(digest) {
  const problems = []
  if (!digest || typeof digest !== 'object') return ['输出不是一个对象']
  if (typeof digest.title !== 'string' || digest.title.trim() === '') problems.push('title 缺失或不是字符串')
  else if (digest.title.length > MAX_TITLE_CHARS) problems.push(`title 超过 ${MAX_TITLE_CHARS} 字`)
  if (typeof digest.tldr !== 'string' || digest.tldr.trim() === '') problems.push('tldr 缺失或不是字符串')
  else if (digest.tldr.length > MAX_TLDR_CHARS) problems.push(`tldr 超过 ${MAX_TLDR_CHARS} 字`)
  if (!Array.isArray(digest.keyPoints)) problems.push('keyPoints 不是数组')
  else if (digest.keyPoints.some((p) => !isFiniteNumber(p?.time) || typeof p?.text !== 'string')) problems.push('keyPoints 元素形状不对')
  if (!Array.isArray(digest.chapters)) problems.push('chapters 不是数组')
  else if (digest.chapters.length === 0) problems.push('chapters 为空')
  else if (digest.chapters.some((c) => !isFiniteNumber(c?.start) || !isFiniteNumber(c?.end) || typeof c?.title !== 'string')) problems.push('chapters 元素形状不对')
  if (!Array.isArray(digest.quotes)) problems.push('quotes 不是数组')
  return problems
}

/**
 * 校验并修正模型输出。**这是防 AI 编时间戳的闸门。**
 *
 * 模型只被允许「选」已有的分段边界作为章节起点；这里把所有边界吸附回真实
 * 分段边界，并强制章节连续覆盖。宁可修正也不放行一条时间轴错的章节。
 *
 * @param upChapters UP 主章节，用于对照告警（不判失败）
 * @returns {{ok:true,value}} 或 {{ok:false,problems}}
 */
export function validateDigest(digest, { duration, segments = [], upChapters = [] } = {}) {
  const problems = collectProblems(digest)
  if (problems.length > 0) return { ok: false, problems }

  const bounds = new Set([0, duration])
  for (const s of segments) {
    bounds.add(Math.max(0, Math.min(duration, Math.round(s.start))))
    bounds.add(Math.max(0, Math.min(duration, Math.round(s.end))))
  }
  const sorted = [...bounds].sort((a, b) => a - b)

  const clamp = (v) => Math.max(0, Math.min(duration, v))
  const snap = (v) => clamp(snapToSegmentBoundary(clamp(Math.round(v)), sorted, SNAP_TOLERANCE_SEC))

  // 1) 吸附每个边界
  let chapters = digest.chapters
    .map((c) => ({
      ...c,
      start: snap(c.start),
      end: snap(c.end),
    }))
    .sort((a, b) => a.start - b.start)

  // 2) 掐掉零长/反向章节
  chapters = chapters.filter((c) => c.end > c.start)
  if (chapters.length === 0) chapters = [{ ...digest.chapters[0], start: 0, end: clamp(duration) }]

  // 3) 首尾相接：强制第一段从 0 开始，后续段从前一段结束处开始，末尾收到 duration
  chapters[0].start = 0
  for (let i = 0; i < chapters.length; i++) {
    if (i > 0) chapters[i].start = chapters[i - 1].end
    chapters[i].end = clamp(chapters[i].end)
    if (chapters[i].end <= chapters[i].start) chapters[i].end = clamp(chapters[i].start + MIN_CHAPTER_SEC)
  }
  chapters.at(-1).end = clamp(duration)
  // 从后往前再修一次，避免前面把后面挤没
  for (let i = chapters.length - 2; i >= 0; i--) {
    if (chapters[i].end > chapters[i + 1].start) chapters[i].end = chapters[i + 1].start
  }

  // 4) 合并过短章节（与相邻更短的一侧合并）
  chapters = mergeShort(chapters, MIN_CHAPTER_SEC, duration)

  // 5) 章节数上限
  const maxChapters = Math.max(2, Math.ceil(duration / 60))
  while (chapters.length > maxChapters) {
    let at = 0
    let smallest = Infinity
    for (let i = 0; i < chapters.length - 1; i++) {
      const span = chapters[i].end - chapters[i].start + (chapters[i + 1].end - chapters[i + 1].start)
      if (span < smallest) { smallest = span; at = i }
    }
    chapters = mergeAt(chapters, at)
  }

  // 6) 与 UP 主章节对照：只告警，不判失败。
  //    判定口径：某章节**跨越**了 UP 主章节边界，且它的两端都不在那个边界附近
  //    （容差 UP_ALIGN_TOLERANCE_SEC）。这正好抓「模型把本该分开的两段合成一段」
  //    这个最常见的失效模式，而不会对合理地合并短章节的行为误报。
  const warnings = []
  if (Array.isArray(upChapters) && upChapters.length > 0) {
    const upBounds = upChapters.map((c) => c.start).filter((v) => v > 0)
    for (const c of chapters) {
      for (const b of upBounds) {
        if (!(c.start < b && c.end > b)) continue
        const aligned =
          Math.abs(c.start - b) <= UP_ALIGN_TOLERANCE_SEC ||
          Math.abs(c.end - b) <= UP_ALIGN_TOLERANCE_SEC
        if (aligned) continue
        warnings.push(`章节「${c.title}」跨越了 UP 主章节边界 ${Math.round(b)}s，且两端都不与其对齐`)
      }
    }
  }

  const value = {
    ...digest,
    title: digest.title.slice(0, MAX_TITLE_CHARS),
    tldr: digest.tldr.slice(0, MAX_TLDR_CHARS),
    chapters,
    keyPoints: digest.keyPoints
      .filter((p) => isFiniteNumber(p.time) && typeof p.text === 'string')
      .map((p) => ({ time: clamp(Math.round(p.time)), text: p.text })),
    quotes: (digest.quotes ?? []).filter((q) => isFiniteNumber(q?.time) && typeof q?.text === 'string').map((q) => ({ time: clamp(Math.round(q.time)), text: q.text })),
  }
  // warnings 走返回值，不塞进 value：digest 会被落盘，
  // 混入内部字段会污染 JSON 契约（规格 §5.11 的输出契约里没有它）。
  return { ok: true, value, warnings }
}

function mergeAt(chapters, i) {
  const a = chapters[i]
  const b = chapters[i + 1]
  const merged = {
    ...a,
    end: b.end,
    title: a.title,
    summary: `${a.summary ?? ''}${b.summary ? ` ${b.summary}` : ''}`.trim(),
    points: [...(a.points ?? []), ...(b.points ?? [])],
  }
  return [...chapters.slice(0, i), merged, ...chapters.slice(i + 2)]
}

function mergeShort(chapters, minSec, duration) {
  let list = chapters
  for (;;) {
    const at = list.findIndex((c) => c.end - c.start < minSec)
    if (at < 0 || list.length <= 1) break
    // 与更短的一侧合并；只有一侧可合并时就用那一侧
    const left = at > 0 ? list[at - 1].end - list[at - 1].start : Infinity
    const right = at < list.length - 1 ? list[at + 1].end - list[at + 1].start : Infinity
    const target = left <= right ? at - 1 : at
    if (target < 0) {
      list = mergeAt(list, 0)
    } else {
      list = mergeAt(list, target)
    }
  }
  if (list.length > 0) list.at(-1).end = duration
  return list
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/validate.test.mjs`
Expected: PASS

```bash
git add src/digest/validate.js test/validate.test.mjs
git commit -m "feat(bili-digest): 章节校验与边界吸附"
```

---

## Task 18: Markdown 渲染

**Files:**
- Create: `src/render/markdown.js`
- Create: `test/render.test.mjs`

**Interfaces:**
- Consumes: `formatTime`（Task 15）
- Produces:
  - `renderMarkdown({ meta, evidence, digest, sourceUrl }): string`
  - `timeLink(bvid, seconds, label): string`

- [ ] **Step 1: 写失败测试**

`test/render.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, timeLink } from '../src/render/markdown.js'

const meta = {
  id: 'BV1GJ411x7h7',
  title: '测试视频',
  duration: 212.393,
  uploader: '某人',
  webpageUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7',
}
const evidence = {
  meta,
  chapters: [],
  transcript: { source: 'local', precision: 'window', language: 'zh', windowSeconds: 30, segments: [] },
  frames: [],
}
const digest = {
  title: '测试视频',
  tldr: '这是总结。',
  keyPoints: [{ time: 10, text: '要点一' }],
  chapters: [
    { start: 0, end: 90, title: '开场', summary: '讲了开场', points: ['a', 'b'] },
    { start: 90, end: 212, title: '正题', summary: '讲了正题', points: ['c'] },
  ],
  quotes: [{ time: 95, text: '一句原文' }],
}

test('timeLink 生成 B 站时间戳链接', () => {
  assert.equal(timeLink('BV1GJ411x7h7', 754, '12:34'), '[12:34](https://www.bilibili.com/video/BV1GJ411x7h7?t=754)')
})

test('渲染包含头部元信息', () => {
  const md = renderMarkdown({ meta, evidence, digest, notes: [] })
  assert.match(md, /^# 测试视频/m)
  assert.match(md, /时长：\*\*03:32\*\*/)
  assert.match(md, /UP 主：某人/)
  assert.match(md, /转写来源：本地识别（窗口 30s，静音点对齐）/)
})

test('渲染包含 TLDR、要点、章节表、详细章节、金句', () => {
  const md = renderMarkdown({ meta, evidence, digest, notes: [] })
  assert.match(md, /## 一句话总结/)
  assert.match(md, /这是总结。/)
  assert.match(md, /## 核心要点/)
  assert.match(md, /\[00:10\]\(https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7\?t=10\)/)
  assert.match(md, /## 章节时间轴/)
  assert.match(md, /\| \[00:00\]/)
  assert.match(md, /### 详细章节/)
  assert.match(md, /#### \[00:00\].*\[01:30\].*开场/)
  assert.match(md, /## 金句/)
  assert.match(md, /一句原文/)
})

test('notes 作为引用块出现在头部', () => {
  const md = renderMarkdown({ meta, evidence, digest, notes: ['注意 A', '注意 B'] })
  assert.match(md, /> ⚠️ 注意 A/)
  assert.match(md, /> ⚠️ 注意 B/)
})

test('有 UP 主章节时头部标注章节数', () => {
  const ev = { ...evidence, chapters: [{ start: 0, end: 90, title: 'x' }, { start: 90, end: 212, title: 'y' }] }
  const md = renderMarkdown({ meta, evidence: ev, digest, notes: [] })
  assert.match(md, /UP 主章节：2 段/)
})

test('无 UP 主章节时头部写「无」', () => {
  const md = renderMarkdown({ meta, evidence, digest, notes: [] })
  assert.match(md, /UP 主章节：无/)
})

test('空 quotes 时省略金句段落', () => {
  const md = renderMarkdown({ meta, evidence, digest: { ...digest, quotes: [] }, notes: [] })
  assert.doesNotMatch(md, /## 金句/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/render.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/render/markdown.js`：

```js
import { formatTime } from '../evidence.js'

/** 生成可点击的 B 站时间戳链接。 */
export function timeLink(bvid, seconds, label) {
  const t = Math.max(0, Math.round(Number(seconds) || 0))
  return `[${label ?? formatTime(t)}](https://www.bilibili.com/video/${bvid}?t=${t})`
}

/**
 * 转写来源标注。窗口长度来自 transcript.windowSeconds，
 * **不能**用 duration/片段数反推——片段数受静音吸附影响，反推出来的值是错的。
 */
function sourceLabel(transcript) {
  if (transcript.source === 'subtitle') return 'B站字幕（句级）'
  return `本地识别（窗口 ${Math.max(1, Math.round(transcript.windowSeconds || 30))}s，静音点对齐）`
}

/** 渲染最终 Markdown。纯函数。 */
export function renderMarkdown({ meta, evidence, digest, notes = [], sourceUrl }) {
  const bvid = meta.id
  const transcript = evidence?.transcript ?? { source: 'local', segments: [] }
  const upChapters = evidence?.chapters ?? []
  const url = sourceUrl || meta.webpageUrl || `https://www.bilibili.com/video/${bvid}`
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`

  const lines = []
  lines.push(`# ${digest.title || meta.title}`)
  lines.push('')
  lines.push(`> 来源：${url}`)
  lines.push(`> 时长：**${formatTime(meta.duration)}**`)
  if (meta.uploader) lines.push(`> UP 主：${meta.uploader}`)
  lines.push(`> 转写来源：${sourceLabel(transcript)}`)
  lines.push(`> UP 主章节：${upChapters.length > 0 ? `${upChapters.length} 段（已作为划分骨架）` : '无'}`)
  lines.push(`> 生成时间：${stamp}`)
  lines.push('')
  for (const n of notes) lines.push(`> ⚠️ ${n}`)
  if (notes.length > 0) lines.push('')
  lines.push('---')
  lines.push('')

  lines.push('## 一句话总结')
  lines.push('')
  lines.push(digest.tldr)
  lines.push('')

  if (Array.isArray(digest.keyPoints) && digest.keyPoints.length > 0) {
    lines.push('## 核心要点')
    lines.push('')
    digest.keyPoints.forEach((p2, i) => {
      lines.push(`${i + 1}. **${timeLink(bvid, p2.time)}** ${p2.text}`)
    })
    lines.push('')
  }

  lines.push('## 章节时间轴')
  lines.push('')
  lines.push('| 时间段 | 章节 | 要点 |')
  lines.push('| --- | --- | --- |')
  for (const c of digest.chapters) {
    const span = `${timeLink(bvid, c.start)} – ${timeLink(bvid, c.end)}`
    lines.push(`| ${span} | ${c.title} | ${c.summary ?? ''} |`)
  }
  lines.push('')

  lines.push('### 详细章节')
  lines.push('')
  for (const c of digest.chapters) {
    lines.push(`#### ${timeLink(bvid, c.start)} – ${timeLink(bvid, c.end)} ${c.title}`)
    lines.push('')
    if (c.summary) { lines.push(c.summary); lines.push('') }
    for (const point of c.points ?? []) lines.push(`- ${point}`)
    lines.push('')
  }

  if (Array.isArray(digest.quotes) && digest.quotes.length > 0) {
    lines.push('## 金句')
    lines.push('')
    for (const q of digest.quotes) lines.push(`> **${timeLink(bvid, q.time)}** ${q.text}`)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/render.test.mjs`
Expected: PASS

```bash
git add src/render/markdown.js test/render.test.mjs
git commit -m "feat(bili-digest): Markdown 渲染"
```

---

## Task 19: 流水线编排

**Files:**
- Create: `src/pipeline.js`
- Create: `test/pipeline.test.mjs`

**Interfaces:**
- Consumes: 全部前置任务
- Produces:
  - `runPipeline(ctx, config, job, { onPhase, noLocal, refresh, override }, signal): Promise<RunResult>`
  - `RunResult = { bvid, markdownPath, transcriptPath, digestPath, title, duration, source, precision, windowSeconds, segmentCount, chapterCount, keyPointCount, notes }`
  - `resolveOutputDir(config, workspace)`（纯函数）
  - `slugify(title)`（纯函数）

- [ ] **Step 1: 写失败测试**

`test/pipeline.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { slugify, resolveOutputDir, PHASES } from '../src/pipeline.js'

test('slugify 去掉文件系统非法字符', () => {
  assert.equal(slugify('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
})

test('slugify 截断到 40 字符', () => {
  assert.equal(slugify('x'.repeat(100)).length, 40)
})

test('slugify 处理空白与末尾点', () => {
  assert.equal(slugify('  多余   空格  '), '多余   空格')
  assert.equal(slugify('trailing.'), 'trailing')
})

test('slugify 空标题有兜底', () => {
  assert.equal(slugify(''), 'untitled')
  assert.equal(slugify('...'), 'untitled')
})

test('resolveOutputDir 优先用配置', () => {
  assert.equal(resolveOutputDir({ outputDir: 'D:/out' }, 'C:/ws'), 'D:/out/bili-digest')
})

test('resolveOutputDir 无配置时用 workspace/bili-digest', () => {
  assert.match(resolveOutputDir({ outputDir: '' }, 'C:/ws'), /ws[\\/]bili-digest$/)
})

test('PHASES 顺序固定且与规格一致', () => {
  assert.deepEqual(PHASES, ['probe', 'subtitle', 'audio', 'decode', 'window', 'transcribe', 'evidence', 'digest', 'render'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/pipeline.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/pipeline.js`：

```js
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { BiliDigestError } from './errors.js'
import { cachePaths, readJson, writeJsonAtomic } from './cache.js'
import { normalizeUrl } from './media/url.js'
import { checkTools, downloadYtDlp, resolveFfmpeg } from './media/tools.js'
import { downloadAudio, probe } from './media/ytdlp.js'
import { installFfmpeg, toWav16k } from './media/ffmpeg.js'
import { transcribeAll } from './asr/index.js'
import { assemble } from './evidence.js'
import { validateDigest } from './digest/validate.js'
import { summarize } from './digest/llm.js'
import { renderMarkdown } from './render/markdown.js'

export const PHASES = ['probe', 'subtitle', 'audio', 'decode', 'window', 'transcribe', 'evidence', 'digest', 'render']

/** 标题 → 安全文件名片段。 */
export function slugify(title) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 40)
  return cleaned === '' ? 'untitled' : cleaned
}

/** 输出目录：配置优先，否则 <workspace>/bili-digest。两者都落到 bili-digest 子目录下。 */
export function resolveOutputDir(config, workspaceDir) {
  return config.outputDir
    ? join(resolve(config.outputDir), 'bili-digest')
    : join(resolve(workspaceDir ?? process.cwd()), 'bili-digest')
}

async function ensureTool(config, emit) {
  const problems = checkTools(config)
  if (problems.ytDlp) {
    emit('probe', '正在下载 yt-dlp…')
    await downloadYtDlp(config, { onProgress: () => {} })
  }
  if (!resolveFfmpeg(config)) {
    emit('decode', '正在安装 ffmpeg…')
    await installFfmpeg(config)
  }
  const after = checkTools(config)
  if (after.ytDlp) throw new BiliDigestError('YTDLP_MISSING', 'yt-dlp 仍不可用', after.ytDlp)
  if (after.ffmpeg) throw new BiliDigestError('FFMPEG_MISSING', 'ffmpeg 仍不可用', after.ffmpeg)
}

/**
 * 进度同时进两处：上部服务（job.phase / 命令回执）与本次运行的 run.log。
 * run.log 的路径要等 probe 之后才知道（真实 id 可能和 URL 里写的不同），
 * 所以之前的行先缓存，拿到路径后一次性落盘。
 */
function makeEmitter(onPhase) {
  const pending = []
  let logFile = null
  const emit = (phase, detail) => {
    onPhase(phase, detail)
    const line = `[${new Date().toISOString().slice(11, 19)}] ${phase}${detail ? ` ${detail}` : ''}`
    if (logFile) void appendFile(logFile, `${line}\n`, 'utf8').catch(() => {})
    else pending.push(line)
  }
  const startLog = async (file) => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '', 'utf8')
    for (const line of pending) await appendFile(file, `${line}\n`, 'utf8')
    pending.length = 0
    logFile = file
  }
  return { emit, startLog }
}

/**
 * 跑完整条流水线。每阶段产物落盘，任一步失败后重跑可复用前序阶段。
 */
export async function runPipeline(ctx, config, job, options = {}, signal) {
  const { onPhase = () => {}, noLocal = false, refresh = false, override = '', hasCredential = false, workspaceDir } = options
  const { emit, startLog } = makeEmitter(onPhase)

  const { url } = normalizeUrl(job.url)
  await ensureTool(config, emit)

  // ---- probe ----
  emit('probe', '取视频元信息')
  const firstId = /BV[0-9A-Za-z]{10}/.exec(url)?.[0] ?? 'unknown'
  let paths = cachePaths(config.cacheDir, firstId)
  let info = refresh ? null : await readJson(paths.probe)
  if (!info) {
    info = await probe(config, url, { signal, onProgress: (p) => emit('probe', p.phase) })
    await writeJsonAtomic(paths.probe, info)
  }
  // probe 之后才知道真实 id（短链/av 号场景），缓存路径可能要改
  if (info.id && info.id !== firstId) {
    paths = cachePaths(config.cacheDir, info.id)
    if (!refresh && (await readJson(paths.probe))) {
      info = await readJson(paths.probe)
    } else {
      await writeJsonAtomic(paths.probe, info)
    }
  }
  await startLog(paths.runLog)
  if (config.maxDurationSec > 0 && info.duration > config.maxDurationSec) {
    throw new BiliDigestError('BILI_UNSUPPORTED_CONTENT', `视频时长 ${Math.round(info.duration)} 秒超过上限 ${config.maxDurationSec} 秒`, '调整配置 maxDurationSec，或换更短的视频。')
  }

  // ---- 转写：先看缓存，再决定要不要下载音频 ----
  emit('subtitle', '检查转写缓存')
  let transcript = refresh ? null : await readJson(paths.segments)
  if (!transcript) {
    // ---- audio ----
    emit('audio', '下载音轨')
    if (refresh || !existsSync(paths.audioM4s)) {
      await downloadAudio(config, url, paths.audioM4s, { signal, onProgress: (p) => emit('audio', `${p.phase}${p.done ? ' 完成' : ''}`) })
    }
    // ---- decode ----
    emit('decode', '转 16kHz 单声道 WAV')
    if (refresh || !existsSync(paths.audioWav)) {
      await toWav16k(config, paths.audioM4s, paths.audioWav, { signal })
    }
    // ---- window + transcribe ----
    transcript = await transcribeAll(
      ctx,
      config,
      { probe: info, wavPath: paths.audioWav, noLocal, hasCredential },
      (p) => emit(p.phase, p.total ? `${p.done}/${p.total}` : p.detail),
      signal,
    )
    await writeJsonAtomic(paths.segments, transcript)
  }

  // ---- evidence ----
  emit('evidence', '组装证据包')
  const evidence = assemble({ probe: info, transcript })

  // ---- digest ----
  emit('digest', '总结与章节划分')
  let digest = refresh ? null : await readJson(paths.digest)
  let digestWarnings = []
  if (!digest) {
    const raw = await summarize(ctx, config, evidence, { override }, signal)
    const checked = validateDigest(raw, {
      duration: Math.round(info.duration),
      segments: transcript.segments,
      upChapters: evidence.chapters,
    })
    if (!checked.ok) {
      throw new BiliDigestError('DIGEST_SCHEMA_INVALID', '模型产出的章节结构不合法', checked.problems.join('；'))
    }
    digest = checked.value
    digestWarnings = checked.warnings ?? []
    await writeJsonAtomic(paths.digest, digest)
  }
  const notes = [...(transcript.notes ?? []), ...digestWarnings]

  // ---- render ----
  emit('render', '写 Markdown')
  const outDir = resolveOutputDir(config, workspaceDir)
  await mkdir(outDir, { recursive: true })
  const slug = slugify(digest.title || info.title)
  const markdownPath = join(outDir, `${info.id}-${slug}.md`)
  const markdown = renderMarkdown({ meta: { ...info }, evidence, digest, notes })
  await writeFile(markdownPath, markdown, 'utf8')

  let transcriptPath
  if (config.keepTranscript) {
    transcriptPath = join(outDir, `${info.id}-transcript.json`)
    await writeJsonAtomic(transcriptPath, transcript)
  }
  const digestPath = join(outDir, `${info.id}-digest.json`)
  await writeJsonAtomic(digestPath, digest)

  return {
    bvid: info.id,
    markdownPath,
    transcriptPath,
    digestPath,
    title: digest.title || info.title,
    duration: info.duration,
    source: transcript.source,
    precision: transcript.precision,
    windowSeconds: transcript.windowSeconds ?? 0,
    segmentCount: transcript.segments.length,
    chapterCount: digest.chapters.length,
    keyPointCount: digest.keyPoints.length,
    notes,
  }
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS

```bash
git add src/pipeline.js test/pipeline.test.mjs
git commit -m "feat(bili-digest): 流水线编排"
```

---

## Task 20: 命令注册与回执

**Files:**
- Modify: `index.js`
- Create: `src/command.js`
- Create: `test/command.test.mjs`

**Interfaces:**
- Consumes: 全部前置任务
- Produces:
  - `parseCommandInput(rawInput): { action:'start'|'status'|'list'|'cancel', target?, options:{ lang?, window?, model?, noLocal, out?, refresh, updateTools } }`
  - `buildReceipt(result): string`、`buildPendingReceipt(job, command): string`
  - `resolveWorkspaceDir(ctx, invocation): string`
  - `apply(ctx, config)`（默认导出形状见下）

- [ ] **Step 1: 写失败测试**

`test/command.test.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCommandInput, buildReceipt, resolveWorkspaceDir } from '../src/command.js'

test('无参数时 action 为 start 且 target 为空', () => {
  const r = parseCommandInput('')
  assert.equal(r.action, 'start')
  assert.equal(r.target, '')
})

test('识别 status / list / cancel 子动作', () => {
  assert.deepEqual(parseCommandInput('status abc').action, 'status')
  assert.equal(parseCommandInput('status abc').target, 'abc')
  assert.equal(parseCommandInput('list').action, 'list')
  assert.equal(parseCommandInput('cancel abc').target, 'abc')
})

test('URL 作为 target 且解析全部选项', () => {
  const r = parseCommandInput('https://www.bilibili.com/video/BV1GJ411x7h7 --lang zh --window 45 --model p/m --no-local --out D:/o --refresh --update-tools')
  assert.equal(r.action, 'start')
  assert.equal(r.target, 'https://www.bilibili.com/video/BV1GJ411x7h7')
  assert.equal(r.options.lang, 'zh')
  assert.equal(r.options.window, 45)
  assert.equal(r.options.model, 'p/m')
  assert.equal(r.options.noLocal, true)
  assert.equal(r.options.out, 'D:/o')
  assert.equal(r.options.refresh, true)
  assert.equal(r.options.updateTools, true)
})

test('--window 非数字抛 BAD_INPUT', () => {
  assert.throws(() => parseCommandInput('BV1GJ411x7h7 --window abc'), (e) => e.code === 'BAD_INPUT')
})

test('未知选项抛 BAD_INPUT 并指出选项名', () => {
  assert.throws(() => parseCommandInput('BV1GJ411x7h7 --nope'), (e) => e.code === 'BAD_INPUT' && /--nope/.test(e.message))
})

test('buildReceipt 含标题、来源、章节数、路径与 notes', () => {
  const text = buildReceipt({
    title: '测试视频',
    duration: 213,
    source: 'local',
    precision: 'window',
    windowSeconds: 30,
    chapterCount: 4,
    keyPointCount: 6,
    markdownPath: 'C:/out/BV1-x.md',
    notes: ['未配置 BILI_SESSDATA，已跳过字幕通路，改用本地识别'],
  })
  assert.match(text, /测试视频/)
  assert.match(text, /时长 03:33/)
  assert.match(text, /转写来源：本地识别（窗口 30s，静音点对齐）/)
  assert.match(text, /章节 4 段/)
  assert.match(text, /核心要点 6 条/)
  assert.match(text, /C:\/out\/BV1-x\.md/)
  assert.match(text, /未配置 BILI_SESSDATA/)
})

test('buildReceipt 对字幕来源标注句级', () => {
  const text = buildReceipt({ title: 't', duration: 60, source: 'subtitle', precision: 'sentence', chapterCount: 1, keyPointCount: 2, markdownPath: 'C:/a.md', notes: [] })
  assert.match(text, /转写来源：B站字幕（句级）/)
})

test('buildReceipt 不产生 undefined 字面量', () => {
  const text = buildReceipt({
    title: 't', duration: 1, source: 'subtitle', precision: 'sentence',
    chapterCount: 1, keyPointCount: 0, markdownPath: 'C:/a.md', notes: [],
  })
  assert.doesNotMatch(text, /undefined/)
})

test('resolveWorkspaceDir 按优先级取 agent 工作区', () => {
  assert.equal(resolveWorkspaceDir({}, { agent: { workspace: { root: 'A' } } }), 'A')
  assert.equal(resolveWorkspaceDir({}, { agent: { cwd: 'B' } }), 'B')
  assert.equal(resolveWorkspaceDir({ get: () => ({ root: 'C' }) }, {}), 'C')
})

test('resolveWorkspaceDir 全都取不到时回落到进程 cwd', () => {
  assert.equal(resolveWorkspaceDir({}, {}), process.cwd())
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/command.test.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写最小实现**

`src/command.js`：

```js
import { BiliDigestError } from './errors.js'
import { formatTime } from './evidence.js'

const FLAG_OPTIONS = {
  '--no-local': 'noLocal',
  '--refresh': 'refresh',
  '--update-tools': 'updateTools',
}
const VALUE_OPTIONS = {
  '--lang': 'lang',
  '--window': 'window',
  '--model': 'model',
  '--out': 'out',
}

/**
 * 解析命令输入。命令自己拥有语法——注册表只把 name 之后的所有字节省下来。
 * @returns {{ action, target, options }}
 */
export function parseCommandInput(rawInput) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const options = {}
  let action = 'start'
  let target = ''

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (i === 0 && ['status', 'list', 'cancel'].includes(token)) {
      action = token
      continue
    }
    if (FLAG_OPTIONS[token]) {
      options[FLAG_OPTIONS[token]] = true
      continue
    }
    if (VALUE_OPTIONS[token]) {
      const value = tokens[++i]
      if (value === undefined) {
        throw new BiliDigestError('BAD_INPUT', `${token} 缺少取值`, `用法：${token} <值>`)
      }
      options[VALUE_OPTIONS[token]] = value
      continue
    }
    if (token.startsWith('--')) {
      throw new BiliDigestError('BAD_INPUT', `未知选项：${token}`, `可用选项：${[...Object.keys(FLAG_OPTIONS), ...Object.keys(VALUE_OPTIONS)].join(', ')}`)
    }
    if (target === '') {
      target = token
      continue
    }
    throw new BiliDigestError('BAD_INPUT', `多出了一个参数：${token}`, '一次只处理一个视频。')
  }

  if (options.window !== undefined) {
    const n = Number(options.window)
    if (!Number.isFinite(n) || n < 30 || n > 60) {
      throw new BiliDigestError('BAD_INPUT', `--window 必须是 30–60 的数字，实得：${options.window}`, '上限 60 是实测结论：更长的片会丢内容。')
    }
    options.window = n
  }

  if ((action === 'status' || action === 'cancel') && target === '') {
    throw new BiliDigestError('BAD_INPUT', `${action} 需要作业 id`, `用法：/${action} <jobId>`)
  }

  return { action, target, options }
}

const SOURCE_LABEL = {
  local: (windowSeconds) => `本地识别（窗口 ${Math.max(1, Math.round(windowSeconds || 30))}s，静音点对齐）`,
  subtitle: () => 'B站字幕（句级）',
}

/**
 * 成功回执。只放回执与路径，**不把全文塞进 UI**。
 * 所有插值都显式 String() 化，杜绝 undefined 字面量。
 */
export function buildReceipt(result) {
  const duration = Number(result?.duration ?? 0)
  const label = (SOURCE_LABEL[result?.source] ?? SOURCE_LABEL.local)(result?.windowSeconds)
  const lines = [
    `✅ 已完成：${String(result?.title ?? '未命名视频')}`,
    `时长 ${formatTime(duration)} ｜ 转写来源：${label}`,
    `章节 ${String(result?.chapterCount ?? 0)} 段 ｜ 核心要点 ${String(result?.keyPointCount ?? 0)} 条`,
    `📄 ${String(result?.markdownPath ?? '')}`,
  ]
  for (const note of result?.notes ?? []) lines.push(`⚠️ ${String(note)}`)
  return lines.join('\n')
}

/**
 * 解析本次作业的输出根目录（workspace）。
 *
 * DSH 的会话工作区挂在 agent 上，不同版本的可达路径可能不同，所以按优先级尝试，
 * 最后回落到进程 cwd。都不合适时用户可以显式配置 outputDir 覆盖。
 * 这是**防御性**回退链，不是占位——每一层都是真实可用的取值点。
 */
export function resolveWorkspaceDir(ctx, invocation) {
  return (
    invocation?.agent?.workspace?.root ??
    invocation?.agent?.cwd ??
    ctx?.get?.('workspace')?.root ??
    process.cwd()
  )
}

/** 未完成回执。 */
export function buildPendingReceipt(job, command = 'bilisum') {
  return [
    `⏳ 作业已启动：${String(job.id)}（当前阶段：${String(job.phase)}）`,
    '长视频转写可能需要数分钟。',
    `查询进度：/${String(command)} status ${String(job.id)}`,
  ].join('\n')
}
```

`index.js`：

```js
import { resolveConfig } from './src/config.js'
import { BiliDigestError, toCommandError } from './src/errors.js'
import { compact } from './src/json.js'
import { Registry } from './src/jobs.js'
import { cachePaths } from './src/cache.js'
import { buildPendingReceipt, buildReceipt, parseCommandInput, resolveWorkspaceDir } from './src/command.js'
import { runPipeline } from './src/pipeline.js'
import { downloadYtDlp } from './src/media/tools.js'

export const name = 'bili-digest'
export const inject = ['commands']

const USAGE = [
  '用法：',
  '  /bilisum <BV号|链接> [选项]   跑完整流水线',
  '  /bilisum status <jobId>       查作业状态',
  '  /bilisum list                 列作业',
  '  /bilisum cancel <jobId>       取消作业',
  '选项：--lang <code> --window <30-60> --model <provider/model> --no-local --out <dir> --refresh --update-tools',
].join('\n')

/**
 * ctx 只按结构使用，**不 import 任何 @deepseek-ai/***（规格 F11）。
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const logger = ctx?.logger
  const registry = new Registry(cfg.cacheDir, logger)

  const runJob = async (job, signal) => {
    // 命令行选项覆盖插件配置：这是用户当次显式表达，优先级高于 profile 配置
    const effective = {
      ...cfg,
      ...(job.options.lang ? { language: job.options.lang } : {}),
      ...(job.options.window ? { windowSeconds: job.options.window } : {}),
      ...(job.options.out ? { outputDir: job.options.out } : {}),
    }
    return runPipeline(ctx, effective, job, {
      onPhase: (phase, detail) => { void registry.setPhase(job.id, phase, detail) },
      noLocal: job.options.noLocal,
      refresh: job.options.refresh,
      override: job.options.model ?? '',
      workspaceDir: job.options.workspaceDir,
    }, signal)
  }

  const handler = async (invocation) => {
    try {
      let parsed
      try {
        parsed = parseCommandInput(invocation.rawInput ?? '')
      } catch (err) {
        return toCommandError(err)
      }

      if (parsed.action === 'list') {
        const jobs = registry.list().slice(0, 20)
        if (jobs.length === 0) return { kind: 'success', text: '还没有任何作业。' }
        return { kind: 'success', text: jobs.map((j) => `- ${j.id} [${j.status}/${j.phase}]${j.result?.title ? ` ${j.result.title}` : ''}`).join('\n') }
      }
      if (parsed.action === 'status') {
        const job = registry.get(parsed.target)
        if (!job) return toCommandError(new BiliDigestError('JOB_NOT_FOUND', `找不到作业 ${parsed.target}`, `用 /${cfg.command} list 查看已有作业。`))
        if (job.status === 'done') return { kind: 'success', text: buildReceipt(job.result) }
        if (job.status === 'failed') return toCommandError(new BiliDigestError(job.error?.code ?? 'JOB_FAILED', job.error?.message ?? '作业失败', job.error?.hint))
        return { kind: 'success', text: buildPendingReceipt(job, cfg.command) }
      }
      if (parsed.action === 'cancel') {
        const job = registry.cancel(parsed.target)
        if (!job) return toCommandError(new BiliDigestError('JOB_NOT_FOUND', `找不到作业 ${parsed.target}`, `用 /${cfg.command} list 查看已有作业。`))
        return { kind: 'success', text: `已请求取消 ${job.id}（当前 ${job.status}）。` }
      }

      // start
      if (parsed.target === '') return { kind: 'error', text: USAGE }

      if (parsed.options.updateTools) {
        await downloadYtDlp(cfg, {})
        return { kind: 'success', text: 'yt-dlp 已更新。' }
      }

      const job = await registry.start({
        url: parsed.target,
        options: compact({
          lang: parsed.options.lang,
          window: parsed.options.window,
          model: parsed.options.model,
          noLocal: parsed.options.noLocal,
          out: parsed.options.out,
          refresh: parsed.options.refresh,
          workspaceDir: resolveWorkspaceDir(ctx, invocation),
        }),
        run: runJob,
      })
      const settled = await registry.wait(job.id, cfg.waitSeconds, invocation.signal)
      if (!settled) return toCommandError(new BiliDigestError('JOB_NOT_FOUND', '作业创建后立即消失', '这是内部错误。'))
      if (settled.status === 'done') return { kind: 'success', text: buildReceipt(settled.result) }
      if (settled.status === 'failed') return toCommandError(new BiliDigestError(settled.error?.code ?? 'JOB_FAILED', settled.error?.message ?? '作业失败', settled.error?.hint))
      if (settled.status === 'cancelled') return { kind: 'error', text: '已取消。已完成的阶段已缓存，可重跑。' }
      return { kind: 'success', text: buildPendingReceipt(settled, cfg.command) }
    } catch (err) {
      logger?.warn?.(`bili-digest: 命令异常 ${err?.stack ?? err}`)
      return toCommandError(err)
    }
  }

  ctx.effect(function* () {
    yield async () => { await registry.dispose() }
    yield ctx.commands.register({
      name: cfg.command,
      description: '提取 B 站视频音频，AI 总结重点并划分时间段',
      input: { hint: '<BV号|链接> | status <id> | list | cancel <id>' },
      handler,
    })
  }, 'bili-digest lifecycle')

  void registry.load()
}
```

- [ ] **Step 4: 跑全量测试确认通过并提交**

Run: `node --test test/`
Expected: 全部 PASS

```bash
git add index.js src/command.js test/command.test.mjs
git commit -m "feat(bili-digest): 命令注册与回执"
```

---

## Task 21: 装进 DSH profile 并端到端验收

**Files:**
- Modify: `C:\Users\23077\.dsh\profiles\desktop\package.json`
- Create: `docs/verify-p0.md`（验收记录）

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 一份可复现的验收记录

- [ ] **Step 1: 写进 profile**

把插件目录放进 profile 依赖（`link:` 不联网）：

```json
{
  "dependencies": {
    "dsh-our-free-model": "2.1.0",
    "dsh-bili-digest": "link:C:\\Users\\23077\\Desktop\\work_place\\视频工作流\\dsh-bili-digest"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@deepseek-ai/dsh-experimental-auto-review",
        "@deepseek-ai/dsh-experimental-schedule-bundle",
        "@deepseek-ai/dsh-experimental-voice-input-bundle",
        "dsh-our-free-model",
        "dsh-bili-digest"
      ]
    }
  }
}
```

然后：

```powershell
cd C:\Users\23077\.dsh\profiles\desktop
pnpm install
```

**注意**：桌面版的 `desktop` profile 由应用独占管理，`dsh plugin --profile desktop` 会被 CLI 拒绝；必须改 `package.json` 并**重启桌面版**（规格 F23）。

- [ ] **Step 2: 跑 E2E-1（本地通路）**

重启 DSH 后，在 GUI 里执行：

```
/bilisum BV1GJ411x7h7
```

期望：
- 首次会先下载 yt-dlp（17 MB）并安装 ffmpeg；如缺 SenseVoice 模型会下 239 MB
- 45 秒内若未完成，回执给出 `jobId`
- 最终产出 `bili-digest/BV1GJ411x7h7-*.md`

- [ ] **Step 3: 核对产物**

在 workspace 下检查：

```powershell
Get-Content .\bili-digest\BV1GJ411x7h7-*.md -TotalCount 20
```

逐条核对并写进 `docs/verify-p0.md`：

| 检查项 | 期望 |
|---|---|
| Markdown 存在且非空 | ✅ |
| 头部 `转写来源` | `本地识别（窗口 30s，静音点对齐）` |
| `notes` 含 | `未配置 BILI_SESSDATA，已跳过字幕通路，改用本地识别` |
| `upChapters` 标注 | `无` |
| 章节首段 start | `00:00` |
| 章节连续 | 相邻章节首尾相接，无空隙 |
| 章节末段 end | 约等于 `03:32`（212.393 s） |
| 所有时间戳 | 落在 `[0, 212]` |
| 章节数 | ≤ `max(2, ceil(212/60)) = 4` |
| 时间戳链接可点 | 点开跳到 B 站对应秒 |

- [ ] **Step 4: 跑 E2E-3（作业制）与 E2E-5（失败路径）**

```
/bilisum BV1GJ411x7h7 --refresh     # 观察 45 秒后是否返回 jobId
/bilisum list                        # 能看到作业
/bilisum status <jobId>              # 能查到终态
/bilisum BV000                       # 期望 BAD_INPUT
/bilisum https://www.bilibili.com/bangumi/play/ep123 --no-local   # 期望 BILI_UNSUPPORTED_CONTENT 或 BILI_NEEDS_LOGIN
```

把每条的实际回执粘进 `docs/verify-p0.md`。

- [ ] **Step 5: 提交验收记录**

```bash
git add docs/verify-p0.md
git commit -m "docs: P0 端到端验收记录"
```

---

## 完成标准

P0 完成的判据（全部满足才算完）：

1. `node --test test/` 全绿。
2. `/bilisum BV1GJ411x7h7` 在真实 DSH 里产出 Markdown 文件。
3. 产物满足 Task 21 Step 3 的全部检查项。
4. `/bilisum status` 与 `/bilisum list` 可用，作业落盘可查。
5. `docs/verify-p0.md` 记录了每条 E2E 的实际回执。
6. 全部返回值经 `compact()`；仓库里 `grep -r "@deepseek-ai/" src/ index.js` 无结果。

## 后续

P1（字幕优先通路 + UP 主章节对照）另出计划：`docs/superpowers/plans/*-dsh-bili-digest-p1.md`。
