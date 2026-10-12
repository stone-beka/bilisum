# dsh-bili-digest 设计规格

- 状态：待用户复核
- 日期：2026-10-12
- 目标交付：DSH 插件（Cordis bundle，Host 单半身）
- 范围：P0（本地全链路）+ P1（B 站字幕优先通路），一次交付

---

## 1. 目标与非目标

### 1.1 目标

在 DeepSeek Harness 里装一个插件，用户输入一条命令

```
/bilisum https://www.bilibili.com/video/BVxxxxxxxxx
```

插件自动完成：

1. 解析出视频元信息（标题、时长、cid、分P）
2. 拿到**带时间戳的完整文本**
   - 优先：B 站已有字幕（CC 或 AI 字幕），时间戳精确到句
   - 兜底：下载音频 → 转 16kHz PCM → 本地 SenseVoice 分窗识别，时间戳为窗口级
3. 把带时间戳的文本喂给 LLM，产出**重点总结 + 章节时间段划分**
4. 渲染成 Markdown，落盘到工作区，并把回执返回聊天

### 1.2 非目标

- 不做前端面板 / 侧边栏 UI（本轮决定：只要聊天命令）
- 不下载视频画面，只取音频轨
- 不做弹幕、评论、AI 总结（B 站自带）的抓取
- 不支持番剧 / 课程 / 直播回放（PGC 走另一套接口，v1 明确报 `BILI_UNSUPPORTED_CONTENT`）
- 不做云端 ASR（本轮决定）
- P2 才做：缓存 LRU 淘汰、长视频 map-reduce

---

## 2. 已核实的环境事实

以下每一条都在本机实测过，是设计的事实基础。

| # | 事实 | 证据 |
|---|---|---|
| F1 | B 站 `view` / `playurl` / `player/v2` **必须先预热拿到 `buvid3` cookie** | 无 cookie 时 `{"code":-412,"message":"request was banned"}`；先 `GET https://www.bilibili.com/` 拿到 `buvid3`+`b_nut` 后同一请求返回 `code:0` |
| F2 | **未登录拿不到字幕，且未登录无法判断视频到底有没有字幕** | 扫了 10 个分区共 40 个热门视频，匿名 `player/v2` 返回字幕条目 **0/40**；`view.subtitle.list` 里的条目是**字幕投稿素材**（`is_lock` / 作者信息齐全但 `subtitle_url` 为空），并非视频自带字幕轨，**不能作为"有字幕"的证据** |
| F3 | DASH 音频可带 `Referer` 分片下载 | `playurl?fnval=4048&fourk=1` 返回 3 条音轨，`Range: bytes=0-2047` 返回 HTTP 206 |
| F4 | 音频是 **fMP4 容器里的 AAC** | 文件头 `ftyp iso5 / avc1 / iso5 / dsms / msix / dash`；音轨 `mp4a.40.2`(AAC-LC) 与 `mp4a.40.5`(HE-AAC) |
| F5 | 本机**没有任何 ffmpeg 二进制** | `Get-Command ffmpeg` 缺失；全盘搜 `ffmpeg*.exe` 无结果（`E:\dsh\ffmpeg.dll` 是 Chromium 媒体库，非 CLI） |
| F6 | DSH 内置本地 ASR 服务 | `ctx.speechToText`，由 `dsh-experimental-voice-input-bundle` 挂载，`defaultProvider: sensevoice-local` |
| F7 | **内置 STT 只接受规范 16kHz 单声道 PCM16 WAV** | provider 内 `validateWave()` 逐字节校验头部，非规范形式直接抛错 |
| F8 | **内置 STT 只返回 `{ text }`，无时间戳** | `transcriptSchema = z.object({ text: z.string() })`；provider README 明确"仅支持完整录音转写" |
| F9 | SenseVoice 模型需下载，位置由 DSH 管理 | int8 `model.int8.onnx` 239,233,841 字节；`tokens.txt` 315,894 字节；`silero_vad.onnx` 1,807,522 字节。`dataRoot` = `dshHomePath('speech-to-text','sensevoice')` = `$DSH_HOME/speech-to-text/sensevoice`（本机尚未创建，首次使用时下载）。来源 HuggingFace + hf-mirror，两者均可连通 |
| F10 | 依赖的核心服务都在 `dsh-base` 里挂载 | `dsh-llm`、`dsh-commands`、`dsh-settings`、`dsh-credentials-local`、`dsh-jobs-local` 均在 `@deepseek-ai/dsh-base/cordis.patch.yml` 中 |
| F11 | 第三方插件可 `import '@deepseek-ai/*'` | 参考已安装的 `dsh-our-free-model`（`adapter/kernel.js` 动态 import `@deepseek-ai/dsh-llm`） |
| F12 | ffmpeg 可通过 npm 获取且不需 postinstall 下载 | `@ffmpeg-installer/win32-x64@4.1.0`，unpackedSize 61.5 MB，二进制随 tarball 分发 |
| F13 | 当前 agent 默认模型 | `deepseek-v4.1-flash`（provider `opencode-go`），上下文窗口 1,000,000 token |
| F14 | **B 站风控会随请求量升级，且两种形态都要处理** | 少量请求时：HTTP 412 + JSON body `{"code":-412,"message":"request was banned"}`；一批请求后：**HTTP 412 + HTML 页面** `<title>出错啦! - bilibili.com</title>`。先 `JSON.parse` 会直接炸在 HTML 上 |
| F15 | Cordis 插件的 `apply` 签名 | 内置插件 `dsh-experimental-speech-to-text-sensevoice` 导出 `{ Config, apply, inject, name }`，`apply(ctx, config)` 内读 `config.providerId` |
| F16 | `ctx.agentDefaultModel.currentSelection()` | 返回 `{ provider, model, reasoningEffort? }`，正是"继承 agent 默认模型"所需的读取口 |

---

## 3. 关键决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| 交付形态 | DSH 插件，Host 单半身 | 用户选择；不写前端，活动部件最少 |
| 转写路线 | 字幕优先 → 本地识别兜底，**可插拔后端 + 显式回退** | 用户选择；字幕零成本且句级精确 |
| 音频解码 | 静态 ffmpeg（`@ffmpeg-installer/win32-x64`） | 用户选择；最稳、最好排障，且封在单一模块内可替换 |
| 摘要模型 | 默认继承 agent 默认模型（`ctx.agentDefaultModel.currentSelection()`），可配置覆盖 | 用户选择 |
| 切窗策略 | 静音点对齐（PCM 能量分析），默认目标窗 60s | 用户选择；避免从句子中间剪开 |
| 输出 | 聊天命令 + Markdown 落盘 | 用户选择 |
| 字幕凭据 | `SESSDATA` 存 `ctx.credentials`（ref `BILI_SESSDATA`），不落明文 | 账号凭据，绝不进配置文件 |
| 非敏感 cookie | `buvid3` / `b_nut` 存缓存目录下的 `cookies.json`（可随时重新预热，不值得单独持久化） | 会过期，需可刷新 |
| 长文本策略 | 单次 LLM 调用（1M 上下文足够）；超出上下文窗口时报明确错误，不做 map-reduce | YAGNI；1 小时视频约 6k token |

---

## 4. 架构

### 4.1 进程与依赖拓扑

```
┌─ DSH Host (Cordis) ────────────────────────────────────────────┐
│                                                                │
│  dsh-bili-digest                                               │
│    │ inject: ['commands']                                      │
│    │ 可选取用: ctx.llm / ctx.speechToText / ctx.credentials     │
│    │           ctx.agentDefaultModel / ctx.settings             │
│    │                                                           │
│    ├── 注册命令 /bilisum, /bilisub                              │
│    ├── 编排流水线（src/pipeline.js）                            │
│    ├── HTTP → api.bilibili.com（global fetch）                  │
│    ├── 子进程 → ffmpeg.exe（audio/ffmpeg.js）                   │
│    ├── 本地推理 → ctx.speechToText（子进程由 DSH 托管）           │
│    └── LLM → ctx.llm.stream()                                  │
│                                                                │
│  缓存: dshCachePath('bili-digest')                              │
│  凭据: ctx.credentials (BILI_SESSDATA)                          │
│  模型: DSH 自管（speech-to-text/sensevoice）                     │
└────────────────────────────────────────────────────────────────┘
```

**关于 `inject`**：只注入 `commands`（没有它插件毫无意义）。其余服务在 `apply()` 内用 `ctx.get(name)` 惰性取用，缺失时**降级而非崩溃**：没有 `speechToText` 时字幕通路仍可用；没有 `llm` 时报告明确错误。

### 4.2 流水线阶段

```
[1] parse      → { bvid, aid?, p }
[2] meta       → { aid, cid, title, duration, owner, parts[] }
[3] subtitle   → 字幕命中?  → segments[{start,end,text}]  source='subtitle'
       │ 未命中 / 无凭据
       ▼
[4] audio      → 选音轨 → 下载 m4s（续传）
[5] decode     → ffmpeg → 16k mono PCM → 规范 WAV
[6] window     → 静音点对齐切窗 → 每窗规范 WAV bytes
[7] asr        → ctx.speechToText 逐窗 transcribe → segments  source='local'
       │
       ▼
[8] digest     → ctx.llm.stream → 严格 JSON
[9] validate   → 章节连续性/覆盖/时长/边界吸附
[10] render    → Markdown + 落盘 + 命令回执
```

阶段产物全部落盘，任一步失败后重跑可复用已完成的前序阶段。

---

## 5. 模块规格

目录结构：

```
dsh-bili-digest/
├── package.json
├── cordis.patch.yml
├── index.js                 # apply(ctx)：注册命令、装配依赖、生命周期
├── src/
│   ├── config.js            # Schemastery Config
│   ├── errors.js            # 错误分类
│   ├── pipeline.js          # 阶段编排（/bilisum 与 /bilisub 共用）
│   ├── cache.js             # 缓存布局、读/写/失效
│   ├── bili/
│   │   ├── parse.js
│   │   ├── cookies.js
│   │   ├── api.js
│   │   └── subtitle.js
│   ├── audio/
│   │   ├── fetch.js
│   │   ├── ffmpeg.js
│   │   └── window.js
│   ├── asr/
│   │   ├── index.js
│   │   └── sensevoice.js
│   ├── digest/
│   │   ├── prompt.js
│   │   ├── llm.js
│   │   └── validate.js
│   └── render/
│       └── markdown.js
└── test/
    ├── fixtures/
    └── *.test.mjs
```

### 5.1 `src/bili/parse.js`

**职责**：把用户输入规整成视频标识。纯函数，零 I/O。

```js
/**
 * @param {string} raw
 * @returns {{ bvid: string|null, aid: number|null, page: number }}
 * @throws {BiliDigestError} BILI_BAD_INPUT
 */
export function parseInput(raw)
```

- 接受：完整 URL（含 `?p=3`）、裸 `BV1xxxxxxxxx`、裸 `av123456`、短链 `b23.tv/xxxx`（短链需要一次 HTTP 跳转，由 `api.js` 负责，`parse.js` 只识别形态）
- `BV` 号校验：长度 12，`BV1` 开头，Base58 字符集
- 空输入 → 抛 `BILI_BAD_INPUT`

**测试**：URL 变体、分P 提取、大小写、非法输入、av/BV 互转。

### 5.2 `src/bili/cookies.js`

**职责**：cookie 预热与缓存。

```js
export class CookieJar {
  constructor({ storageDir, credentials, logger })
  /** 返回可直接用于请求的 Cookie 头字符串；必要时先预热。 */
  async header(signal)
  /** 丢弃缓存并重新预热（收到 -412 时调用）。 */
  async refresh(signal)
}
```

- 预热：`GET https://www.bilibili.com/`，从 `set-cookie` 提取 `buvid3`、`b_nut`、`buvid4`（存在则存）
- 与 `SESSDATA` 合并：`SESSDATA` 每次从 `ctx.credentials.resolve(credentialRef('BILI_SESSDATA'))` 现读（凭据可能热更新），不缓存值
- 缓存文件只存非敏感字段；**任何日志、错误消息、命令输出中都不出现 `SESSDATA` 值**
- 过期判定：请求返回 `code === -412` 或 HTTP 412 时 `refresh()` 一次并重试一次；仍失败 → `BILI_RISK_CONTROL`

### 5.3 `src/bili/api.js`

**职责**：B 站 HTTP 接口封装。所有请求统一带头：

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36
Referer:    https://www.bilibili.com/
Accept:     application/json, text/plain, */*
Cookie:     <CookieJar.header()>
```

```js
/** 解析短链；非短链直接返回。 */
export async function expandShortLink(raw, deps, signal): Promise<string>

/** GET /x/web-interface/view?bvid= | ?aid= */
export async function fetchView({ bvid, aid }, deps, signal): Promise<ViewInfo>

/** GET /x/player/playurl?avid=&cid=&fnval=4048&fourk=1 */
export async function fetchDash({ aid, cid }, deps, signal): Promise<DashInfo>

/** GET /x/player/v2?aid=&cid= */
export async function fetchPlayerV2({ aid, cid }, deps, signal): Promise<PlayerV2>
```

`ViewInfo` 归约后只保留：`{ aid, bvid, cid, title, duration, owner, pages: [{ cid, page, part, duration }] }`

**请求节流（必须）**：全局串行队列，任意两次出站请求间隔 ≥ `config.minRequestIntervalMs`（默认 1000 ms，含 cookie 预热）。风控是按请求量触发的，并发的"优化"会让整条链路被封。

**响应解析（必须先看 HTTP 层，再碰 JSON）**：

1. 读 `response.status` 与 `content-type`
2. `status === 412` → 不管 body 是 JSON 还是 HTML，一律 `BILI_RISK_CONTROL`
3. `content-type` 不是 JSON → `BILI_API_ERROR`（附 body 前 200 字符，用于识别"出错啦"页面）
4. 仅当以上都通过才 `JSON.parse`

**退避策略**：命中 412 时按 `[5s, 15s, 45s]` 退避后重试（每次重试前 `CookieJar.refresh()`），三次仍失败 → `BILI_RISK_CONTROL`，提示用户稍后重试。**不得**做无退避的紧密重试。

不变量：
- 每次响应校验 `code === 0`，否则映射为分类错误
- `dash.audio` 为空 → `BILI_NO_AUDIO_STREAM`
- PGC 内容（`view` 返回 `code: -404` 或 `redirect_url` 含 `/bangumi/`）→ `BILI_UNSUPPORTED_CONTENT`

### 5.4 `src/bili/subtitle.js`

**职责**：字幕获取与归一化。

```js
/**
 * @returns {Promise<
 *   { kind: 'hit', language: string, segments: Array<{start:number,end:number,text:string}> }
 *   | { kind: 'no-credential' }
 *   | { kind: 'no-track' }
 * >}
 *         一律不抛错，交给调用方决定回退
 */
export async function trySubtitles({ aid, cid, preferredLang }, deps, signal)
```

逻辑：

1. 无 `SESSDATA` → **不发起任何请求**，直接返回 `null`（原因见 F2：匿名时无法判断视频是否有字幕，`view.subtitle.list` 不可作为证据，探测只会白白消耗风控额度）
2. `fetchPlayerV2` → `data.subtitle.subtitles[]` 是**权威的可读字幕轨列表**
3. 列表为空 → 返回 `null`（该视频真的没有可用字幕轨）
4. 语言选择：`preferredLang` 精确匹配 → `zh-Hans` → `zh-CN` → `zh-Hant` → 第一条
5. `subtitle_url` 是协议相对（`//aisubtitle.hdslb.com/...`）→ 补 `https:`
6. 拉取字幕 JSON → `body[]` → 归一化为 `{ start: from, end: to, text: content }`
7. 清洗：`content` 去首尾空白；过滤空行与纯符号行
8. 相邻同时间戳行合并；单段文本超过 200 字时按标点再切（保持时间区间）
9. 结果按 `start` 升序，重叠区间取先出现的

**测试**：用录制 fixture 覆盖多语言选择、空 `subtitle_url`、协议相对 URL、乱序/重叠区间。

### 5.5 `src/audio/fetch.js`

**职责**：下载 DASH 音轨，支持续传。

```js
export async function downloadAudio(stream, destPath, deps, signal): Promise<string>
```

- 音轨选择由 `config.audioQuality` 决定：
  - `'balanced'`（默认）：优先 `id === 30232`（AAC-LC 103 kbps）
  - `'smallest'`：`bandwidth` 最小（通常是 30216 HE-AAC 44 kbps）
  - `'best'`：`bandwidth` 最大
  - 指定档位不存在时降级到 `bandwidth` 最小的一条
- 请求带 `Range: bytes=<已下载字节>-`；服务端返回 200 表示不支持续传 → 清空重下
- 下载中定期把 `已下载/总大小` 写进 `run.log`
- 流式写盘（`fs.createWriteStream`），不整块驻留内存
- 收到 403 → 音轨 URL 过期 → 重新 `fetchDash` 并重试一次

### 5.6 `src/audio/ffmpeg.js`（唯一解码点）

**职责**：m4s → 16kHz 单声道 PCM16 WAV。**这是方案 A/B/C 的替换边界，其它模块不得直接依赖 ffmpeg。**

```js
export async function ensureFfmpeg(config, deps): Promise<string>   // 返回可执行文件绝对路径
export async function toWav16k(inputPath, outputPath, deps, signal): Promise<void>
```

`ensureFfmpeg` 解析顺序：

1. `config.ffmpegPath` 非空 → 直接用，校验可执行
2. `<cacheDir>/bin/ffmpeg.exe` 存在 → 用
3. 否则从已安装依赖 `@ffmpeg-installer/win32-x64` 的 `path` 导出取路径

`toWav16k` 调用：

```
ffmpeg -hide_banner -nostdin -loglevel error -y \
  -i <input.m4s> \
  -vn -ac 1 -ar 16000 -c:a pcm_s16le \
  -f wav <output.wav>
```

- 用 `spawn` 而非 `exec`；`signal` abort 时 `child.kill('SIGKILL')`（Windows 用 `taskkill /T /F` 兜底）
- 非零退出码 → `AUDIO_DECODE_FAILED`，错误消息包含 ffmpeg stderr 的最后 20 行
- 产出文件**不是规范 WAV**（ffmpeg 会插入 `LIST`/`fact` chunk），由 `window.js` 负责解析与规范化

### 5.7 `src/audio/window.js`（唯一 WAV 知识所在）

**职责**：规范 WAV 解析 / 构造 / 静音点对齐切窗。

```js
/** 解析 WAV，容忍任意 chunk 顺序；返回 16 位样本视图与采样率。 */
export function readWav(buffer): { sampleRate: number, channels: number, bits: number, samples: Int16Array }

/** 构造规范 44 字节头 WAV。这是喂给 ctx.speechToText 的唯一合法形式。 */
export function buildCanonicalWav(samples: Int16Array): Uint8Array

/** 静音点对齐切窗。所有区间一律用**样本下标**表达，秒数由 sampleRate 换算。 */
export function planWindows(samples, sampleRate, opts):
  Array<{ startSample: number, endSample: number, startSec: number, endSec: number }>
```

**`buildCanonicalWav` 必须精确满足 DSH 的 `validateWave()`：**

| 偏移 | 内容 |
|---|---|
| 0 | `'RIFF'` |
| 4 | uint32LE = `len - 8` |
| 8 | `'WAVE'` |
| 12 | `'fmt '` |
| 16 | uint32LE = 16 |
| 20 | uint16LE = 1（PCM） |
| 22 | uint16LE = 1（单声道） |
| 24 | uint32LE = 16000 |
| 28 | uint32LE = 32000 |
| 32 | uint16LE = 2 |
| 34 | uint16LE = 16 |
| 36 | `'data'` |
| 40 | uint32LE = `len - 44` |
| 44 | PCM16LE 样本 |

附加约束：`len >= 46`、`(len - 44) % 2 === 0`。多余的半个字节必须丢弃。

**`planWindows` 算法**：

1. 输入保证为 16kHz 单声道
2. 按 100 ms 帧（1600 样本）计算 RMS
3. 静音阈值 `opts.silenceRms`（默认 0.012，归一化到 [-1,1]）
4. 从目标边界 `t = target` 出发，在 `[target - search, target + search]`（`search` 默认 15 s）内找 RMS 最小的帧；若该帧 RMS 低于阈值则采用，否则仍取最小 RMS 帧（保证窗口数可预测）
5. 强制最小窗长 `minWindowSeconds`（默认 30 s）：吸附结果突破下限时退回目标边界
6. 最后一窗结束于音频末尾；末尾不足 `minWindowSeconds` 时并入前一窗
7. 返回区间列表，相邻、无重叠、覆盖 `[0, duration)`，并保证每段样本数为偶数

**测试**：合成 PCM（前静音 + 正弦 + 后静音）验证吸附点落在静音区；验证规范头逐字节符合；验证异常 chunk 顺序的解析；验证奇数样本长度被修正。

### 5.8 `src/asr/sensevoice.js`

**职责**：调 DSH 的 `ctx.speechToText` 完成本地识别。名字里的 "sensevoice" 指默认 provider，实际走服务，不绑定具体模型。

```js
import { buildCanonicalWav } from '../audio/window.js'

/** 确认 provider 就绪；未就绪则触发 prepare 并轮询进度。 */
export async function ensureReady(ctx, providerId, onProgress, signal): Promise<string>

/**
 * @param windows planWindows 的输出（样本下标 + 秒数）
 * @param samples 完整 PCM（Int16Array，16 kHz 单声道）
 * @returns segments[{start,end,text}]，start/end 为秒
 */
export async function transcribeWindows(ctx, { windows, samples, language }, onProgress, signal): Promise<Array<Segment>>
```

- provider 选择：`config.sttProvider` 非空则用；否则用 `ctx.speechToText.snapshot().selection.providerId`
- 就绪检查：`snapshot().providers[i].preparation.phase`；非 `ready` 时调 `ctx.speechToText.prepare(id)`，用 `follow(caller)` 订阅进度，把 `phase` 与字节数写进 `run.log`（首次会下 239 MB 模型，必须让用户看得见）
- 语言：`config.language`（`auto`/`zh`/`en`/`yue`/`ja`/`ko`）。provider 不支持所选语言会抛错 → 降级为 `auto` 并记录
- 逐窗调用：
  ```js
  const bytes = buildCanonicalWav(samples.subarray(w.startSample, w.endSample))
  const spec = ctx.speechToText.resolve({ audio: bytes, language })
  const { text } = await ctx.speechToText.transcribe(spec, signal)
  ```
  （`buildCanonicalWav` 内部按偶数长度截断，`subarray` 不复制，避免整段 PCM 二次驻留）
- **串行**执行（provider 的 worker 是单进程串行）
- 空文本窗口保留在结果里（时间轴连续性需要），但在喂给 LLM 时跳过
- `STT_MODEL_MISSING` 与 `STT_UNAVAILABLE` 分开报，提示语不同

### 5.9 `src/asr/index.js`

**职责**：后端选择与显式回退。

```js
/**
 * @returns {{ source: 'subtitle'|'local', language: string, segments: Segment[], notes: string[] }}
 */
export async function transcribeAll(input, deps, onProgress, signal)
```

回退规则：

| 情况 | 行为 |
|---|---|
| `kind: 'hit'` | 用字幕，`source='subtitle'`，`notes: []` |
| `kind: 'no-track'` | 回落本地，`notes: ['该视频没有可用字幕轨，已改用本地识别']` |
| `kind: 'no-credential'` | **不探测、不猜测**，直接回落本地，`notes: ['未配置 BILI_SESSDATA，已跳过字幕通路，改用本地识别']` |
| `--no-local` 且字幕不可用（任意 kind） | 抛 `BILI_NEEDS_LOGIN`，提示如何配置 `BILI_SESSDATA` |
| 本地不可用（无 `speechToText`）且字幕不可用 | 抛 `STT_UNAVAILABLE`，消息里给出补救建议 |

注：`kind: 'no-credential'` 时 `notes` 的措辞**不得**声称"该视频有字幕"——匿名状态下我们无从判断（F2），编造这个信息会误导用户。

回退**必须显式**：`notes` 最终写进 Markdown 头部与命令回执，绝不静默。

### 5.10 `src/digest/prompt.js`

**职责**：提示词与输出契约。纯字符串构造，无 I/O。

输入给模型的内容：

```
视频标题：<title>
视频时长：<duration 秒>
转写来源：B站字幕 | 本地识别（窗口 N 秒）
转写精度：句级 | 窗口级

带时间戳的转写：
[00:00-00:47] 第一段文字……
[00:47-01:32] 第二段文字……
...
```

系统提示词要求：

- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字
- **章节边界只能取给定的时间点**，不允许编造时间
- 章节必须首尾相接、覆盖全片
- `keyPoints` 每条必须能在转写里找到依据
- 不确定时宁可少划分章节，不要切碎

**输出契约**（写死在提示词里，并由 `validate.js` 逐字段校验；不是独立 schema 文件）：

```json
{
  "title": "string",
  "tldr": "string",
  "keyPoints": [{ "time": 754, "text": "string" }],
  "chapters": [{
    "start": 0,
    "end": 192,
    "title": "string",
    "summary": "string",
    "points": ["string"]
  }],
  "quotes": [{ "time": 754, "text": "string" }]
}
```

### 5.11 `src/digest/llm.js`

**职责**：调用 LLM 并拿到 JSON。

```js
export async function summarize(ctx, { transcriptBlock, duration, notes, override }, signal): Promise<DigestJson>
```

- 模型解析：`override`（来自 `--model`）→ `config.summaryModel` → `ctx.agentDefaultModel.currentSelection()`
- 调用：
  ```js
  for await (const chunk of ctx.llm.stream({ provider, model, messages, temperature: 0.2, maxTokens: 8192 })) { … }
  ```
- 用 `@deepseek-ai/dsh-llm` 导出的 `BlockAssembler` 组装文本分片（不手工拼接）
- 终止分片 `{ kind:'error' }` → 按 `failure.code` 映射错误（`CONTEXT_WINDOW_EXCEEDED` → `LLM_CONTEXT_EXCEEDED`，`RATE_LIMIT` → `LLM_RATE_LIMIT`，其余 → `LLM_FAILED`）
- `{ kind:'aborted' }` → 抛 `CANCELLED`
- JSON 解析：先剥掉可能的 ``` 围栏，再 `JSON.parse`；失败时**重试一次**，第二次的提示词追加"上次输出不是合法 JSON，请只输出 JSON"
- 两次都失败 → `DIGEST_SCHEMA_INVALID`

### 5.12 `src/digest/validate.js`

**职责**：结构与语义校验，是"防 AI 编时间戳"的闸门。

```js
export function validateDigest(digest, { duration, segments }): { ok: true, value: DigestJson } | { ok: false, problems: string[] }
```

校验规则：

1. 必填字段与类型齐全
2. 所有 `time` / `start` / `end` 落在 `[0, duration]`
3. `chapters` 非空；`chapters[0].start === 0`（容差 2 s）
4. `chapters[i].end === chapters[i+1].start`（容差 2 s，超出则该处视为断裂）
5. `chapters.at(-1).end` 与 `duration` 差值 ≤ 2 s
6. 每章时长 ≥ 30 s；不足则与相邻章合并
7. 章节数上限 `max(2, ceil(duration / 60))`；超限则合并时长最短的相邻对
8. `title` 长度 ≤ 30 字符；`tldr` 长度 ≤ 400 字符
9. **边界吸附**：把每个 `start`/`end` 吸附到最近的 `segments` 边界（容差 5 s）；吸附后重新跑规则 3–6

校验通过后返回**修正过的**值（吸附与合并的结果），失败返回 `problems` 供重试提示词使用。重试一次仍失败 → `DIGEST_SCHEMA_INVALID`。

### 5.13 `src/render/markdown.js`

**职责**：渲染最终 Markdown。纯函数。

```js
export function renderMarkdown({ meta, transcriptMeta, digest, sourceUrl }): string
```

时间戳链接格式：`[mm:ss](https://www.bilibili.com/video/<bvid>?t=<秒>)`

### 5.14 `src/cache.js`

**职责**：缓存布局与读写。所有路径都从 `config.cacheDir` 派生。

```
<cacheDir>/
├── cookies.json              # buvid3 / b_nut / buvid4
├── bin/ffmpeg.exe            # 可选，config.ffmpegPath 为空时
└── <bvid>/
    ├── meta.json             # view 归约结果 + fetchedAt
    ├── audio.m4s
    ├── audio.wav
    ├── segments.json         # { source, language, notes, segments[] }
    ├── digest.json
    └── run.log
```

- `meta.json` TTL：10 分钟（`fetchedAt` 判定）；`--refresh` 强制忽略
- `segments.json` / `digest.json` 只要存在就复用，除非 `--refresh`
- 所有写入走「临时文件 + rename」，避免半截文件被复用

### 5.15 `src/errors.js`

`BiliDigestError extends Error`，字段 `{ code, hint, cause }`。`hint` 是给用户看的中文补救建议。

### 5.16 `index.js`

```js
const name = 'bili-digest'
const inject = ['commands']

function apply(ctx, config) {
  ctx.effect(function* () {
    // 清理：中止在跑的任务
    yield async () => { /* abort active runs, await settle */ }
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('dsh-bili-digest'),
      name: config.command,            // 默认 'bilisum'
      description: '提取 B 站视频音频/字幕，AI 总结重点并划分时间段',
      input: { hint: '<BV号|链接> [--lang zh] [--window 60] [--model p/m] [--no-local] [--out dir] [--refresh]' },
      handler,
    })
    yield ctx.commands.register({ /* 同上，name: config.subCommand，只跑到转写 */ })
  }, 'bili-digest lifecycle')
}

export { apply, inject, name, Config }
```

（`apply(ctx, config)` 的签名与内置插件一致：`dsh-experimental-speech-to-text-sensevoice` 导出 `{ Config, apply, inject, name }` 并在 `apply` 内读 `config.providerId`。）

命令处理器契约（`dsh-commands`）：

- 返回 `{ kind: 'success', text }` 或 `{ kind: 'error', text }`
- 从 `invocation.rawInput` 解析参数（命令自己拥有语法）
- 用 `invocation.signal` 贯穿全部阶段
- 任何异常都在处理器内被捕获并转成 `{ kind:'error', text: hint }`，**不让异常逃逸到 Harness**
- 成功回执只包含：标题、时长、转写来源与精度、章节数、落盘路径、`notes`；**不把全文塞进 UI**

---

## 6. 配置 schema（Schemastery）

```js
export const Config = z.object({
  command:        z.string().default('bilisum'),
  subCommand:     z.string().default('bilisub'),
  outputDir:      z.string().default(''),        // 空 = 当前会话工作区/bili-digest
  cacheDir:       z.string().default(''),        // 空 = dshCachePath('bili-digest')，即 $DSH_HOME/cache/bili-digest
  language:       z.string().default('auto'),    // auto|zh|en|yue|ja|ko
  preferredSubtitleLang: z.string().default('zh-Hans'),
  windowSeconds:  z.number().min(30).max(120).default(60),
  silenceSearchSeconds: z.number().min(0).max(30).default(15),
  audioQuality:   z.union([z.const('balanced'), z.const('smallest'), z.const('best')]).default('balanced'),
  minRequestIntervalMs: z.number().min(300).max(10000).default(1000),
  ffmpegPath:     z.string().default(''),        // 空 = 自动解析
  sttProvider:    z.string().default(''),        // 空 = speechToText 当前选择
  summaryModel:   z.object({
                    provider: z.string().default(''),
                    model:    z.string().default(''),
                  }).default({ provider: '', model: '' }),
  maxKeyPoints:   z.number().min(3).max(20).default(8),
  keepTranscript: z.boolean().default(true),
})
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: bili-digest
      name: 'dsh-bili-digest'
      config:
        cacheDir: !!js dshCachePath('bili-digest')
```

路径语义（来自 `@deepseek-ai/dsh-home-paths`，已核实实现）：

- `dshHomePath(...segments)` = `join(resolveDshHome(), ...segments)`，**不插入 `storages`**
- `dshCachePath(...segments)` = `join(resolveDshHome(), 'cache', ...segments)`
- `resolveDshHome()` 优先级：显式配置 > `$DSH_HOME` > `~/.dsh`；本机 `$DSH_HOME` = `C:\Users\23077\.dsh`

---

## 7. 命令面

### 7.1 `/bilisum <BV号|链接> [选项]`

完整流水线，产出 Markdown 并落盘。

| 选项 | 含义 |
|---|---|
| `--lang <code>` | 语言提示，覆盖配置 |
| `--window <秒>` | 本地切窗目标长度（30–120） |
| `--model <provider/model>` | 覆盖摘要模型 |
| `--no-local` | 禁用本地识别兜底 |
| `--out <dir>` | 覆盖输出目录 |
| `--refresh` | 忽略缓存重新抓取 |

### 7.2 `/bilisub <BV号|链接> [选项]`

只跑到转写，落盘 `segments.json`，回执里给出段落数与前 10 段的预览。用于把慢阶段（模型下载 + CPU 推理）与摘要阶段分离，也方便排查转写质量。选项同 `/bilisum`。

### 7.3 用法与错误

- 无参 → `{ kind:'error', text: '用法：/bilisum <BV号|链接> [选项]' }`
- 未知选项 → 明确报出该选项名与完整用法
- 分P：URL 带 `?p=N` 取第 N P；不带则取第 1 P，并在回执里注明"该视频共 M P，已处理第 1 P"

---

## 8. 输出规格

### 8.1 落盘

```
<outputDir>/bili-digest/<bvid>-<slug>.md
<outputDir>/bili-digest/<bvid>-transcript.json     # keepTranscript 为 true 时
<outputDir>/bili-digest/<bvid>-digest.json
```

`slug`：标题去掉文件系统非法字符、截断到 40 字符。

### 8.2 Markdown 模板

```markdown
# <标题>

> 来源：<URL>
> 时长：**mm:ss**
> UP 主：<owner>
> 转写来源：B站字幕（句级） | 本地识别（窗口 60s，静音点对齐）
> 生成时间：YYYY-MM-DD HH:mm

<notes 逐条作为引用块>

---

## 一句话总结

<tldr>

## 核心要点

1. **[mm:ss](链接)** 要点文字
2. …

## 章节时间轴

| 时间段 | 章节 | 要点 |
| --- | --- | --- |
| [00:00](链接) – [03:12](链接) | 章节标题 | 一句话概括 |
| … | | |

### 详细章节

#### [00:00](链接) – [03:12](链接) 章节标题

<summary>

- 要点 1
- 要点 2

## 金句

> **[mm:ss](链接)** 原文引用
```

### 8.3 命令回执

```
✅ 已完成：<标题>
时长 3:33 ｜ 转写来源：本地识别（窗口 60s，静音点对齐）
章节 4 段 ｜ 核心要点 6 条
📄 <绝对路径>.md
⚠️ 未配置 BILI_SESSDATA，已跳过字幕通路，改用本地识别
```

---

## 9. 错误分类

| code | 触发条件 | 用户可见提示方向 |
|---|---|---|
| `BILI_BAD_INPUT` | 输入无法解析成视频标识 | 给出正确输入示例 |
| `BILI_UNSUPPORTED_CONTENT` | 番剧/课程/直播回放 | 明确说明 v1 不支持该内容类型 |
| `BILI_SHORTLINK_FAILED` | b23.tv 跳转失败 | 请直接粘贴完整链接 |
| `BILI_RISK_CONTROL` | 预热后仍 412 | 稍后重试；检查网络出口 |
| `BILI_API_ERROR` | 接口返回 `code !== 0` | 带 code 与 message |
| `BILI_NEEDS_LOGIN` | `--no-local` 且字幕不可用 | 说明如何配置 `BILI_SESSDATA` |
| `BILI_NO_AUDIO_STREAM` | `dash.audio` 为空 | 该视频可能为付费/会员内容 |
| `AUDIO_DOWNLOAD_FAILED` | 音频下载失败（含 403 重试后） | 检查网络；可重跑续传 |
| `AUDIO_DECODE_FAILED` | ffmpeg 非零退出 | 附 stderr 尾部；建议检查 `ffmpegPath` |
| `FFMPEG_NOT_FOUND` | 三个解析路径都失败 | 建议重装插件依赖或手动配置 `ffmpegPath` |
| `STT_UNAVAILABLE` | `ctx.speechToText` 不存在 | 说明需启用 voice-input bundle |
| `STT_MODEL_MISSING` | 模型未下载且下载失败 | 说明需 239 MB 下载与镜像设置 |
| `STT_FAILED` | provider 推理失败 | 附 provider 错误码 |
| `LLM_UNAVAILABLE` | `ctx.llm` 不存在 | 说明组合缺失 |
| `LLM_CONTEXT_EXCEEDED` | 转写超出模型上下文 | 建议换更大上下文模型或缩短视频 |
| `LLM_RATE_LIMIT` | provider 限流 | 建议稍后重试 |
| `LLM_FAILED` | 其它模型请求失败 | 附 failure code |
| `DIGEST_SCHEMA_INVALID` | 两次重试后 JSON 仍不合法 | 附校验问题列表 |
| `CANCELLED` | 用户中止 | 已完成的阶段已缓存，可重跑 |

全部错误都以 `{ kind:'error', text }` 结算，不抛到 Harness。

---

## 10. 安全与隐私

- `SESSDATA` 只存 `ctx.credentials`，ref 为 `BILI_SESSDATA`；配置文件、缓存文件、日志、命令输出、错误消息中**永不出现其值**。`describe()` 只用于告知"是否已配置"
- 音频与转写文本只落本地缓存目录，不上传任何第三方（本轮无云端 ASR）
- 喂给 LLM 的内容仅包含转写文本与视频元信息，不含 cookie、不含用户标识
- `run.log` 写请求 URL 时剥掉查询参数（B 站音轨 URL 带签名与 `deadline`）

---

## 11. 性能与资源预算

| 项 | 预算 |
|---|---|
| 1 小时视频，balanced 音轨 | m4s 约 45 MB；WAV（16k mono PCM16）约 115 MB |
| 切窗数 | 60s 目标窗 → 约 60 段 |
| 本地推理 | 串行，CPU；SenseVoiceSmall int8。首次额外 239 MB 模型下载 |
| LLM 输入 | 约 6k token（1 小时）；模型上下文 1M，单次调用足够 |
| 峰值磁盘 | 音频 + WAV + 缓存 < 500 MB（1 小时视频） |
| 峰值内存 | 完整 PCM 常驻（1 小时 = 115 MB）+ 单窗 WAV（≤ 4 MB） |
| B 站出站请求数（一次完整运行） | cookie 预热 1 + `view` 1 + `playurl` 1 + 音频下载 1（续传会多几次 Range 请求）+ 字幕 2（`player/v2` + 字幕 JSON，仅配了 SESSDATA 时）。命中缓存时仅 0–1。这是风控友好度的关键指标，任何新增请求都要计入 |

---

## 12. 测试与验收

### 12.1 单元测试（`node --test`，离线）

| 文件 | 覆盖 |
|---|---|
| `parse.test.mjs` | URL/BV/av/分P/短链识别；非法输入 |
| `window.test.mjs` | 规范 WAV 头逐字节校验；非规范 chunk 顺序解析；静音点吸附；最小窗长；奇数字节修正 |
| `subtitle.test.mjs` | 语言选择；空 URL；协议相对 URL；乱序/重叠区间；长行切分 |
| `validate.test.mjs` | 9 条规则的通过与拒绝用例；边界吸附；章节合并 |
| `render.test.mjs` | Markdown 渲染；时间戳链接格式；notes 呈现 |
| `errors.test.mjs` | 分类映射与 hint 文案 |

### 12.2 契约测试（录制 fixture，离线）

`test/fixtures/` 保存真实抓取的 `view` / `playurl` / `player/v2` / 字幕 JSON 响应，注入 `deps.fetch` 桩，验证：

- 归约结果字段正确
- `code !== 0` 的分类映射
- HTTP 412 的两种 body（JSON 与 HTML 页面）走同一条 `BILI_RISK_CONTROL` 分支
- 字幕：有 `subtitle_url`（已登录会话录制）与列表为空（匿名录制）两条分支

fixture 落库前必须脱敏：剥掉所有 URL 的查询参数、`Cookie`/`Set-Cookie` 头、任何 `SESSDATA` 痕迹。

### 12.3 端到端验收（真联网）

**E2E-1 本地通路（不配 SESSDATA）**

```
/bilisum BV1GJ411x7h7
```

- 该视频：3 分 33 秒（213 s）
- 必须：产出 `.md`；`转写来源 = 本地识别`；`notes` 含「未配置 BILI_SESSDATA，已跳过字幕通路」；章节 `chapters[0].start === 0`、`last.end ≈ 213`、相邻无缝；所有时间戳 ∈ [0, 213]
- 必须：`run.log` 中可看到 cookie 预热、音轨选择、切窗数、逐窗识别进度
- 人工核对：Markdown 可读、章节标题与内容相符、时间戳链接可跳转

**E2E-2 字幕通路（需用户提供 SESSDATA）**

- 配置 `BILI_SESSDATA`
- 对一个确有字幕的视频执行 `/bilisum`
- 必须：`转写来源 = B站字幕`；段落数与字幕行数一致；时间戳与字幕 `from/to` 完全一致
- 对照实验：清空 `BILI_SESSDATA` 重跑同一视频，必须出现「未配置 BILI_SESSDATA，已跳过字幕通路」并回落本地，且`转写来源`变为本地识别

**E2E-3 失败路径**

- 输入 `BV000` → `BILI_BAD_INPUT`
- `--no-local` + 无 SESSDATA → `BILI_NEEDS_LOGIN`
- 番剧链接 → `BILI_UNSUPPORTED_CONTENT`

### 12.4 验收证据

- `node --test` 完整输出
- E2E-1 产出的 Markdown 文件
- E2E-2 两条对照的命令回执截图/文本
- 章节连续性校验的断言输出

---

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| B 站风控升级导致 412 | 全链路不可用 | 全局串行 + 最小请求间隔 1 s；412 按 `[5s,15s,45s]` 退避并刷新 cookie；三次失败报 `BILI_RISK_CONTROL` 并提示稍后重试。**绝不紧密重试**。缓存 TTL 降低重复请求量 |
| 412 时 body 是 HTML，`JSON.parse` 抛异常 | 错误分类失真、难以诊断 | 响应解析先看 HTTP status 与 `content-type`，非 JSON 一律不进 `JSON.parse`（见 §5.3） |
| 匿名无法判断视频是否有字幕 | 提示文案可能误导用户 | 不猜、不探测；`no-credential` 时只陈述"已跳过字幕通路"（见 §5.9） |
| 音轨 URL 带 `deadline`，长下载中途过期 | 大文件下载中断 | Range 续传 + 403 时重新解析一次；缓存已下载部分 |
| `@ffmpeg-installer/win32-x64` 是 ffmpeg 4.1.0（较旧） | 极冷门编码不支持 | 仅用于 AAC→PCM，能力充分；`ffmpegPath` 可指向任意新版 ffmpeg |
| ffmpeg 输出非规范 WAV | STT 直接拒绝 | `window.js` 解析 chunk 后自行重写规范头（已在规格中固定） |
| SenseVoice 首次 239 MB 下载慢/失败 | 首次体验差 | 复用 DSH 自带下载器与 HF/镜像回退；进度透出到 `run.log`；下载失败可续 |
| 长视频 CPU 推理耗时（可能 10–30 分钟） | 命令长时间无响应 | `/bilisub` 分离慢阶段；逐窗进度写 `run.log`；阶段产物缓存可续跑 |
| LLM 编造时间戳 | 章节时间轴错误 | 提示词硬约束 + `validate.js` 吸附到真实段落边界 + 连续性校验 |
| 分P/合集视频只处理第 1 P | 用户预期落差 | 回执明确标注"共 M P，已处理第 1 P" |

---

## 14. 实施顺序

### P0 — 本地全链路（不依赖任何登录态）

1. 包骨架：`package.json` / `cordis.patch.yml` / `index.js` / `config.js` / `errors.js`
2. `bili/parse.js` + 测试
3. `bili/cookies.js` + `bili/api.js`（预热、view、playurl）+ fixture 契约测试
4. 依赖安装：`@ffmpeg-installer/win32-x64`
5. `audio/fetch.js` + `audio/ffmpeg.js`
6. `audio/window.js`（规范 WAV + 静音点切窗）+ 测试
7. `asr/sensevoice.js` + `asr/index.js`
8. `digest/prompt.js` + `digest/llm.js` + `digest/validate.js` + 测试
9. `render/markdown.js` + 测试
10. `pipeline.js` + `index.js` 命令注册
11. E2E-1 验收

### P1 — 字幕优先通路

12. `bili/subtitle.js` + fixture 测试
13. `asr/index.js` 接入字幕后端与显式回退
14. 凭据接入 `ctx.credentials`（ref `BILI_SESSDATA`）
15. E2E-2 与 E2E-3 验收

---

## 15. 已定默认值（无遗留待定项）

| 问题 | v1 默认 |
|---|---|
| 分P视频 | 处理 `?p=` 指定的 P；无参数时处理第 1 P，并在回执标注总 P 数 |
| 番剧/课程/直播回放 | 不支持，报 `BILI_UNSUPPORTED_CONTENT` |
| 短链 `b23.tv` | 支持，单次跳转解析；失败报 `BILI_SHORTLINK_FAILED` |
| 无字幕且无 SESSDATA | **显式**回退到本地识别，并在 `notes` 与 Markdown 头部明示（不得静默） |
| 字幕语言 | `zh-Hans` → `zh-CN` → `zh-Hant` → 第一条；可配置 |
| 章节数上限 | `max(2, ceil(duration/60))` |
| 超长转写 | 单次调用；`CONTEXT_WINDOW_EXCEEDED` 时报明确错误，map-reduce 留给 P2 |
| 缓存淘汰 | v1 不自动淘汰；`cacheDir` 由用户自行清理（LRU 留给 P2） |
