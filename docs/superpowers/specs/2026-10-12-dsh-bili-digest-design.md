# dsh-bili-digest 设计规格

- 状态：待用户复核（v2，已并入同类项目调研结论）
- 日期：2026-10-12
- 目标交付：DSH 插件（Cordis bundle，Host 单半身）
- 范围：P0（本地全链路）+ P1（B 站字幕优先通路），一次交付
- v1 归档：`git show c7a646b:docs/superpowers/specs/2026-10-12-dsh-bili-digest-design.md`

---

## 1. 目标与非目标

### 1.1 目标

在 DeepSeek Harness 里装一个插件，用户输入

```
/bilisum https://www.bilibili.com/video/BVxxxxxxxxx
```

插件自动完成：

1. 用 `yt-dlp` 拿到视频元信息、**UGC 章节**（若 UP 主已设）、**字幕**（若可用）、音频
2. 得到**带时间戳的完整文本**
   - 优先：B 站已有字幕（CC / AI 字幕），时间戳精确到句
   - 兜底：音频 → 16kHz PCM → 静音点对齐切窗 → 本地 SenseVoice 逐窗识别，时间戳为窗口级
3. 把收集到的**证据**组装成一个证据包，喂给 LLM，产出**重点总结 + 章节时间段划分**
4. 渲染 Markdown 落盘到工作区，命令回执返回聊天

**关键抽象：证据包，而不是"一段文本"。**

我们做的不是"提取字幕然后总结"，而是**收集关于这个视频的证据，再让 AI 基于证据回答"这视频讲了什么"**。转写只是**一种证据源**，而且它只覆盖"有口播"的视频。把输入定义成证据包，是为了让「画面」这类证据源可以后加而不动主流程：

```js
{
  meta:       { title, duration, uploader, description, tags, url },
  chapters:   [ { start, end, title } ],   // L0：UP 主章节，作为划分骨架
  transcript: { source, precision, segments },  // L1：字幕或本地 ASR
  frames:     []                            // L2：关键帧，本轮恒为空
}
```

本轮只填 L0 + L1；`frames` 保持空数组。将来接 `videoshot`（实测一次 HTTP 换 32 帧 + 时间戳，见 §17.1）或抽帧 OCR 时，**只是多一个证据源，`digest` 之后的所有环节一行不改**。

### 1.2 非目标

- 不做前端面板 / 侧边栏 UI（本轮决定：只要聊天命令）
- 不下载视频画面，只取音频轨
- 不做弹幕、评论、B 站自带 AI 总结的抓取
- 不跳帧 OCR（`bfftp0502/bilibili-video-summary` 有这条路径，我们不做）
- 不做云端 ASR（本轮决定）
- P2 才做：缓存 LRU 淘汰、长视频 map-reduce、扩展 B 站以外的站点

---

## 2. 已核实的环境与外部事实

本机实测的用「实测」标注，读源码验证的用「源码」标注。

| # | 事实 | 依据 |
|---|---|---|
| F1 | B 站 `view` / `playurl` / `player/v2` 匿名请求会被风控，**HTTP 412** | 实测。两种 body：JSON `{"code":-412,"message":"request was banned"}`；请求量上去后变成 HTML `<title>出错啦! - bilibili.com</title>`。**先 `JSON.parse` 会直接炸在 HTML 上** |
| F2 | **未登录拿不到字幕；且未登录无法判断视频到底有没有字幕** | 实测：扫 10 个分区 40 个热门视频，匿名 `player/v2` 字幕条目 0/40。源码：yt-dlp `_get_subtitles()` 在 `data.need_login_subtitle` 时告警 `Subtitles are only available when logged in` —— 独立佐证 |
| F3 | **`view.subtitle.list` 不是"有字幕"的证据** | 实测：某视频该列表 12 条但 `subtitle_url` 全空，那些是**字幕投稿素材**，非视频自带字幕轨 |
| F4 | 音频是 **fMP4 容器里的 AAC** | 实测：文件头 `ftyp iso5 / avc1 / dsms / msix / dash`；音轨 `mp4a.40.2`(AAC-LC,103k) 与 `mp4a.40.5`(HE-AAC,44k) |
| F5 | 本机**没有任何 ffmpeg 二进制** | 实测：`Get-Command ffmpeg` 缺失，全盘搜 `ffmpeg*.exe` 无结果（`E:\dsh\ffmpeg.dll` 是 Chromium 媒体库，非 CLI） |
| F6 | DSH 内置本地 ASR 服务 | 实测：`ctx.speechToText`，由 `dsh-experimental-voice-input-bundle` 挂载，`defaultProvider: sensevoice-local` |
| F7 | **内置 STT 只接受规范 16kHz 单声道 PCM16 WAV** | 源码：provider 内 `validateWave()` 逐字节校验头部 |
| F8 | **内置 STT 只返回 `{ text }`，无时间戳** | 源码：`transcriptSchema = z.object({ text: z.string() })`；README 明确"仅支持完整录音转写" |
| F9 | SenseVoice 模型位置与体积 | 实测+源码：`<DSH_HOME>/speech-to-text/sensevoice/models/sensevoice-onnx/`；`model.int8.onnx` 239,233,841 B，`tokens.txt` 315,894 B，`silero_vad.onnx` 1,807,522 B。HF 与 hf-mirror 均连通 |
| F10 | 核心服务都在 `dsh-base` 挂载 | 源码：`dsh-llm` / `dsh-commands` / `dsh-settings` / `dsh-credentials-local` / `dsh-jobs-local` 均在 `@deepseek-ai/dsh-base/cordis.patch.yml` |
| F11 | **第三方插件不应 `import '@deepseek-ai/*'`** | 同类项目结论：*"只 import `node:` 内置模块，不 import 任何 `@deepseek-ai/*`（第三方插件解析不到，本地副本会造成双实例）"*。服务仍可用，走 `ctx.get(name)` 鸭子类型（`dsh-our-free-model` 即此模式） |
| F12 | ffmpeg 可经 npm 获取且不需 postinstall 下载 | 实测：`@ffmpeg-installer/win32-x64@4.1.0`，unpackedSize 61.5 MB，二进制随 tarball 分发 |
| F13 | 当前 agent 默认模型 | 实测：`deepseek-v4.1-flash`（provider `opencode-go`），上下文 1,000,000 token |
| F14 | Cordis 插件签名 | 源码：`export { Config, apply, inject, name }`，`apply(ctx, config)` |
| F15 | `dshHomePath` 不插入 `storages` | 源码：`dshHomePath(...s) = join(resolveDshHome(), ...s)`；`dshCachePath(...s) = join(resolveDshHome(), 'cache', ...s)`。本机 `$DSH_HOME` = `C:\Users\23077\.dsh` |
| F16 | **`yt-dlp` 能取 B 站字幕，格式 SRT** | 源码：`_get_subtitles()` → `json2srt(subtitle_url 内容)`，语言 key 为 `lan`（如 `zh-Hans`） |
| F17 | **`yt-dlp` 能取 B 站 UGC 章节** | 源码：`_get_chapters(aid, cid)` → `data.view_points` → 标准 `chapters[]`；官方测试用例含 `'chapters': 'count:6'` |
| F18 | `yt-dlp.exe` 体积与来源 | 实测：GitHub release `yt-dlp/yt-dlp` latest（tag `2026.08.19`）资产 `yt-dlp.exe` = 17.0 MB |
| F19 | **SenseVoice 长音频必须分片，否则静默丢内容** | 同类项目实测：单遍 69 分钟音频 → **产出 0 字，退出码仍为 0，峰值内存 58 GB**。片长扫描（611 s 音频）：15s→3932 字 / **30s→3816** / 60s→3346 / 120s→2329 / 240s→1027 |
| F20 | 静音吸附窗口的实测最优值 | 同类项目实测：切点在 **±1.5 s** 内吸附到能量最低处，比固定切点多留 **3.8%** 内容 |
| F21 | DSH 宿主对返回值做**运行时**无损 JSON 校验 | 同类项目结论：一个值为 `undefined` 的键就让整次调用被判 `value is not lossless JSON` 而**拒收**；假 `register` 的单测覆盖不到 |
| F22 | 长任务会撞工具超时策略 | 同类项目结论：16 分钟音频转写要 3~6 分钟，`tool-call-timeout-policy` 会按工具装 `exec.signal` 截止时间 |
| F23 | 桌面版 `desktop` profile 由应用独占管理 | 同类项目结论：`dsh plugin --profile desktop` 会被 CLI 显式拒绝；改 profile `package.json` 有效，但需**重启桌面版** |
| F24 | HMR 需 profile 显式配 `base` / `root` | 同类项目结论：没配则整个进程缓存 Host 模块，改 `index.js` 不生效 |
| F25 | **本机开着系统代理，且它是 B 站 412 的直接原因** | Spike 实测：`ProxyEnable=1`、`ProxyServer=127.0.0.1:7890`。`api.bilibili.com` **直连 200 / 走代理 412**；`github.com` release 资产 **直连 000 / 走代理 302**；`ghproxy.net` 两边都 200。→ 必须**分目标控制代理** |
| F26 | **`yt-dlp.exe` 子进程必须显式设 `TEMP`/`TMP`/`TMPDIR`** | Spike 实测：默认 temp 下报 `[PYI-25504:ERROR] Could not create temporary directory!`；指向自定义可写目录后正常。PyInstaller onefile 需要在 temp 里解包并加载 DLL |
| F27 | **`yt-dlp` 本身不绕过风控，风控是出口 IP 层面的** | Spike 实测：`--impersonate chrome`、`--user-agent`、`--force-ipv4`、`--cookies` 单独都救不了；只有把代理改直连才对。v1 规格里"换 yt-dlp 就绕开风控"的说法**不成立**，已修正 |
| F28 | `yt-dlp.exe` 可从镜像取得并校验 | Spike 实测：GitHub release 直连不通，`ghproxy.net` 200；下载 17,840,399 B，SHA256 与官方 `SHA2-256SUMS` 一致 |
| F29 | yt-dlp probe 在本机实测可用 | Spike 实测：`--dump-single-json --skip-download` 返回 `extractor=BiliBili / title / duration=212.393 / uploader / formats=15`；音轨 `30216`(44k HE-AAC)、`30232`(103k AAC-LC)、`30280`(204k AAC-LC) |
| F30 | yt-dlp 下载的音频是 fMP4 + AAC | Spike 实测：`-f 30232` 得 2.61 MB，文件头 `ftyp iso5 … avc1 iso5 dsms msix dash` —— 与 F4 一致，是 ffmpeg 的合法输入 |
| F31 | 匿名下 yt-dlp 的 `subtitles` 为空 | Spike 实测：`subtitles=[]`、`automatic_captions=[]` —— 与 F2 完全一致，且 yt-dlp 源码在 `need_login_subtitle` 时会自己告警 |

---

## 3. 关键决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| 交付形态 | DSH 插件，Host 单半身，**注册命令**（非工具） | 用户选择；命令是用户驱动，不被工具的截止时间策略约束 |
| 取数层 | **`yt-dlp`**（音频 + 字幕 + 元信息 + UGC 章节） | 用户选择路线 A。省掉 WBI 签名、DASH 选轨、cookie 兼容、抗封禁跟版等自写成本。**但注意：它不消除风控**（F27）——风控在出口 IP 层，yt-dlp 也绕不开，仍需代理策略（F25） |
| 转写路线 | 字幕优先 → 本地识别兜底，**显式回退** | 用户选择；字幕零成本且句级精确 |
| 本地 ASR 通道 | `ctx.speechToText`（不 import 包，走 `ctx.get`） | 复用 DSH 已托管的 provider 与模型下载逻辑，不引入第 4 个二进制 |
| 音频解码 | 静态 ffmpeg（`@ffmpeg-installer/win32-x64`） | 用户选择；封在单一模块内可替换 |
| 切窗 | **目标 30 s**，静音吸附 **±1.5 s** | 用户选择静音对齐；参数取自 F19/F20 的实测最优 |
| 摘要模型 | 默认 `ctx.get('agentDefaultModel').currentSelection()`，可配置覆盖 | 用户选择 |
| 长任务 | **作业制**：命令立即返回 `jobId`，`status/list/cancel` 查询 | F22；避免命令长时间无响应 |
| `@deepseek-ai/*` | **零 import**；服务走 `ctx.get()` 鸭子类型；配置校验手写 | F11 |
| 返回值 | 统一过 `compact()` 剥离 `undefined` | F21 |
| 摘要执行方 | 插件内调 `ctx.llm`；不可用时降级为"产出文稿 + 提示 agent 自行总结" | 用户要"一条命令出结果"；同时保留无 LLM 组合下的可用性 |
| 字幕凭据 | `SESSDATA` 存 `ctx.credentials`（ref `BILI_SESSDATA`），运行时写成临时 Netscape cookie 文件给 yt-dlp，用后即删 | 账号凭据，不落明文、不常驻磁盘 |
| 缓存目录 | `dshCachePath('bili-digest')` = `$DSH_HOME/cache/bili-digest` | F15 |
| 长文本策略 | 单次 LLM 调用（1M 上下文足够）；超限报明确错误，map-reduce 留 P2 | YAGNI；1 小时视频约 6k token |
| **digest 的输入形态** | **证据包**（`{ meta, chapters, transcript, frames }`），而非一段文本 | 用户确认。让"画面"等证据源可后加而不动主流程；本轮 `frames` 恒为空 |

---

## 4. 架构

### 4.1 拓扑

```
┌─ DSH Host (Cordis) ──────────────────────────────────────────────┐
│                                                                  │
│  dsh-bili-digest                                                 │
│    inject = ['commands']                                         │
│    可选服务（ctx.get，缺失即降级）:                                │
│      speechToText / llm / credentials / agentDefaultModel         │
│                                                                  │
│    ├── 注册命令 /bilisum（start|status|list|cancel）               │
│    ├── 作业注册表（落盘，重启可查）                                 │
│    ├── 子进程 → yt-dlp.exe   取元信息/章节/字幕/音频                │
│    ├── 子进程 → ffmpeg.exe   m4s → 16k mono PCM WAV                │
│    ├── 本地推理 → ctx.speechToText（子进程由 DSH 托管）             │
│    └── LLM → ctx.llm.stream()                                    │
│                                                                  │
│  缓存: $DSH_HOME/cache/bili-digest/                               │
│  凭据: ctx.credentials (BILI_SESSDATA)                            │
│  模型: DSH 自管（speech-to-text/sensevoice）                       │
└──────────────────────────────────────────────────────────────────┘
```

**关于 `inject`**：只注入 `commands`。其余服务在调用点用 `ctx.get(name)` 取，缺失时**降级而非崩溃**：无 `speechToText` 时字幕通路仍可用；无 `llm` 时降级为只出文稿。

### 4.2 流水线

```
[1] parse      BV号/av号/URL → 规范 URL + 分P
[2] probe      yt-dlp --dump-single-json --skip-download
               → { title, duration, chapters[], subtitles{}, webpage_url }
[3] subtitle   有 SESSDATA 且 subtitles 含中文轨?
               → yt-dlp 拉字幕 → SRT 解析 → segments[{start,end,text}]
                   source='subtitle'，顺便保留 chapters[] 作为章节先验
       │ 否
       ▼
[4] audio      yt-dlp 取最佳音轨 → audio.m4s
[5] decode     ffmpeg → 16k mono PCM → 规范 WAV
[6] window     planSegments(30s, ±1.5s 静音吸附) → 片段
[7] asr        ctx.speechToText 逐片 transcribe → segments  source='local'
       │
       ▼
[8] evidence   组装证据包 { meta, chapters, transcript, frames:[] }
       ▼
[9] digest     ctx.llm.stream → 严格 JSON（摘要 + 章节 + 金句）
[10] validate  连续性/覆盖/时长/边界吸附 + UGC 章节对齐
[11] render    Markdown + 落盘 + 命令回执
```

阶段产物全部落盘，任一步失败后重跑可复用已完成的前序阶段。

---

## 5. 模块规格

```
dsh-bili-digest/
├── package.json
├── cordis.patch.yml
├── index.js                 # apply(ctx, config)：命令注册 + 生命周期
├── src/
│   ├── config.js            # resolveConfig()：手写默认值 + 校验（无 Schemastery）
│   ├── errors.js            # 错误分类
│   ├── json.js              # compact() / 无损 JSON 出口
│   ├── jobs.js              # 作业注册表（落盘、串行、可查）
│   ├── evidence.js          # 证据包组装（唯一的证据聚合点）
│   ├── pipeline.js          # 阶段编排
│   ├── cache.js             # 缓存布局与读写
│   ├── media/
│   │   ├── url.js           # URL/BV/av/分P 归一化（纯函数，零 I/O）
│   │   ├── tools.js         # yt-dlp / ffmpeg 的定位与自检
│   │   ├── ytdlp.js         # yt-dlp 子进程封装（probe / audio / subtitle）
│   │   ├── subtitle.js      # SRT 解析（纯函数）
│   │   └── ffmpeg.js        # 唯一解码点
│   ├── audio/
│   │   └── window.js        # 规范 WAV + planSegments（唯一 WAV 知识所在）
│   ├── asr/
│   │   ├── index.js         # 后端选择与显式回退
│   │   └── sensevoice.js    # ctx.speechToText 适配
│   ├── digest/
│   │   ├── prompt.js
│   │   ├── llm.js
│   │   └── validate.js
│   └── render/
│       └── markdown.js
├── THIRD_PARTY_NOTICES.md   # 署名：dsh-video-transcribe (MIT)、yt-dlp (Unlicense)
└── test/
    ├── fixtures/
    └── *.test.mjs
```

### 5.1 `src/config.js`

**职责**：手写配置默认值与校验（不依赖 Schemastery，见 F11）。

```js
export function resolveConfig(raw = {})   // → 归一化配置，越界值抛 BAD_CONFIG
export function configProblems(raw)       // → string[]，供诊断
```

### 5.2 `src/json.js`

```js
/** 递归剥离 undefined；数组保序。所有子进程/服务出口必须过这里。 */
export function compact(value)
```

**这是 F21 的硬要求**：宿主的无损 JSON 校验发生在**运行时**，单测的假 `register` 覆盖不到。因此规则是「出口统一过 `compact()`」，而不是在每个构造点记得删字段。`test/json.test.mjs` 必须包含一条对**真实磁盘作业记录**的断言。

### 5.3 `src/jobs.js`

**职责**：作业注册表。串行执行，状态落盘，重启可查。

```js
export class Registry {
  constructor(root, logger)
  start({ url, options })                  // → { id, status, phase }
  get(id)                                  // → job | undefined
  list()                                   // → job[]
  cancel(id)                               // → { id, status }
  /** 等待至多 waitSeconds；期间完成则返回终态，否则返回运行态。 */
  async wait(id, waitSeconds, signal)
  /** 中止全部在跑作业并等待其收尾；供 ctx.effect 的清理阶段调用。 */
  async dispose()
}
```

- 状态落盘 `<cacheDir>/jobs/<id>/job.json`（F23 之后仍可查）
- `phase`: `probe → subtitle → audio → decode → window → transcribe → digest → render`
- **作业串行**：SenseVoice 推理峰值内存按 GB 计（F19），不允许并发
- 作业 id 格式 `YYYYMMDD-HHmmss-XXXXXX`

### 5.4 `src/media/tools.js`

**职责**：定位、自检、必要时下载外部可执行文件，并为它们构造**正确的子进程运行环境**。**缺什么就说什么，不说清楚比没有更糟。**

```js
export function resolveYtDlp(config)   // → 绝对路径 | undefined
export function resolveFfmpeg(config)  // → 绝对路径 | undefined
export function checkTools(config)     // → { ytDlp?: problem, ffmpeg?: problem }
export async function ensureYtDlp(config, onProgress, signal)
/** 构造子进程 env：补齐 TEMP/TMP/TMPDIR 并清掉不该继承的代理变量。 */
export function childEnv(config, target): NodeJS.ProcessEnv
```

分辨率顺序：

- **yt-dlp**：`config.ytDlpPath` → `<cacheDir>/bin/yt-dlp.exe` → 自动下载
- **ffmpeg**：`config.ffmpegPath` → `<cacheDir>/bin/ffmpeg.exe` → 已安装依赖 `@ffmpeg-installer/win32-x64`

**下载镜像链（F28 测过）**：按序尝试

1. `https://ghproxy.net/https://github.com/yt-dlp/yt-dlp/releases/download/<tag>/yt-dlp.exe`
2. `https://gh-proxy.com/https://github.com/...`
3. `https://github.com/yt-dlp/yt-dlp/releases/download/<tag>/yt-dlp.exe`（本机直连不通，放最后）

下载后必须与同 tag 的 `SHA2-256SUMS` 比对 SHA-256，**校验不过就丢弃并换下一个镜像**。

**子进程环境（F26 + F25，两条都是实测踩出来的）**：

```js
// childEnv 的两条职责
1. TEMP / TMP / TMPDIR 必须显式指向一个我们自己保证可写的目录
   （默认 <cacheDir>/tmp），否则 PyInstaller 打包的 yt-dlp.exe 直接起不来：
   [PYI-xxxxx:ERROR] Could not create temporary directory!
2. 代理必须显式化，绝不能靠继承：
   - target === 'bilibili'  → 默认强制直连（config.proxy 为 'system' 时除外）
   - target === 'tool-download' → 用 config.toolProxy（默认跟随系统代理，因为
     GitHub release 资产在本机直连不通、走代理才通）
   实现上：对 yt-dlp 传 --proxy=<值>（直连时传空串），并同时设置/清除
   HTTP_PROXY / HTTPS_PROXY / NO_PROXY，双保险
```

代理策略是**分目标**的，因为实测（F25）这台机器上 B 站与 GitHub 的连通性要求正好相反。写死任一侧都会导致一侧不可用。

`--update-tools` 强制重新下载 yt-dlp（B 站接口常变，yt-dlp 需跟版）。

两个文件都缺时插件**仍然注册命令**，调用时返回结构化错误码与放置路径指引。

### 5.5 `src/media/ytdlp.js`

**职责**：yt-dlp 子进程封装。**这是取数层的唯一出口。**

同目录的 `url.js` 承载流水线第 [1] 步，是无 I/O 的纯函数模块：

```js
/** BV号 / av号 / 各种 B 站 URL → 规范 URL + 分P；非法输入抛 BAD_INPUT。 */
export function normalizeUrl(raw): { url: string, bvid: string|null, page: number }
/** http(s) + host 白名单（bilibili.com / b23.tv）校验。 */
export function isAllowed(url): boolean
```

`normalizeUrl` 不做网络请求：短链 `b23.tv` 原样透传给 yt-dlp 跟随跳转。`isAllowed` 挡掉 `file:` 一类本地读取面。

```js
/** [2] 元信息 + 章节 + 字幕清单。一次调用。 */
export async function probe(cfg, url, { cookieFile, signal }): Promise<ProbeInfo>

/** [3] 下载指定语言字幕，返回 SRT 文本。 */
export async function fetchSubtitle(cfg, url, { lang, cookieFile, signal }): Promise<string>

/** [4] 下载最佳音轨到 destPath。 */
export async function downloadAudio(cfg, url, destPath, { cookieFile, signal, onProgress }): Promise<void>

/** 版本信息，用于诊断与 --update-tools。 */
export async function version(cfg, signal): Promise<string>
```

命令行（`<p>` = 由 `childEnv(config,'bilibili')` 决定的代理，默认空 = 直连）：

```
probe:      yt-dlp --dump-single-json --skip-download --no-warnings --no-playlist
                   --proxy=<p> [--cookies <file>] <url>
subtitle:   yt-dlp --skip-download --write-subs --sub-langs <lang> --sub-format srt
                   --no-warnings --proxy=<p> -o <dir>/sub [--cookies <file>] <url>
audio:      yt-dlp -f <选择> --no-playlist --no-warnings --proxy=<p>
                   -o <dest> [--cookies <file>] <url>
```

音轨选择由 `config.audioQuality` 决定：`balanced`（默认）→ `30232`；`smallest` → `30216`；`best` → `30280`。指定 format_id 不可用时回落 `bestaudio/best`。

每个子进程都必须带 `childEnv(config,'bilibili')`（F25/F26）。**不给 `--proxy` 就等于让它继承系统代理，在装有 Clash 类工具的机器上会直接 412。**

`ProbeInfo` 归约后只保留：

```js
{ id, title, duration, uploader, webpageUrl, chapters: [{ start, end, title }],
  subtitles: { [lan]: true }, isPlaylist, playlistCount, entries? }
```

- `chapters` 来自 `info.chapters`（F17）→ `{ start: start_time, end: end_time, title }`
- `subtitles` 只取 key 集合（不取 URL，URL 会过期）
- 分P：`--no-playlist` 下 `-o` 与 URL 的 `?p=N` 决定处理哪一 P；回执标注总 P 数
- **子进程参数一律走数组、不经 shell**（URL 里的引号不会变成命令注入）
- URL 只放行 `http(s)` 且 host 属 `bilibili.com` / `b23.tv`

### 5.6 `src/media/subtitle.js`

**职责**：SRT 解析（纯函数）。

```js
/**
 * @param srt SRT 文本
 * @returns { start: number, end: number, text: string }[]  （start/end 为秒）
 */
export function parseSrt(srt)
```

- 处理 CRLF、多行文本、时间码 `HH:MM:SS,mmm`
- 过滤空行与纯符号行
- 相邻同时间戳行合并；单段超 200 字按标点再切（保持时间区间）
- 按 `start` 升序；重叠区间取先出现的

**契约测试**用真实录制的 SRT fixture；解析器不联网。

### 5.7 `src/media/ffmpeg.js`（唯一解码点）

**职责**：m4s → 16kHz 单声道 PCM16 WAV。**这是解码方案 A/B/C 的替换边界，其它模块不得直接依赖 ffmpeg。**

```js
export async function toWav16k(ffmpegPath, inputPath, outputPath, { signal }): Promise<void>
```

```
ffmpeg -hide_banner -nostdin -loglevel error -y -i <input.m4s> \
       -vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav <output.wav>
```

- 用 `spawn`；`signal` abort 时 Windows 用 `taskkill /T /F` 兜底
- 非零退出 → `AUDIO_DECODE_FAILED`，消息含 stderr 尾部 20 行
- **产出文件不是规范 WAV**（ffmpeg 会插 `LIST`/`fact` chunk），由 `window.js` 解析并重写

### 5.8 `src/audio/window.js`（唯一 WAV 知识所在）

**职责**：规范 WAV 解析 / 构造 / 静音点对齐切窗。

```js
export function parsePcmWav(buffer): { sampleRate, channels, bits, samples: Int16Array }
export function buildPcmWav(samples, sampleRate): Uint8Array
export function planSegments({ sampleRate, samples, targetSec, minSec, snapSec, silenceRms })
export function sliceSeconds(samples, sampleRate, startSec, endSec): Int16Array
```

**算法与参数改编自 [`wqzhellohhwy/dsh-video-transcribe`](https://github.com/wqzhellohhwy/dsh-video-transcribe)（MIT）的 `segment.js`**，其参数经实测调优（F19/F20）。署名见 `THIRD_PARTY_NOTICES.md`。我们**不**复用它把片段拼成纯文本的 `joinSegments` —— 那正是丢掉时间戳的地方，而时间戳是本插件的核心价值。

**`buildPcmWav` 必须精确满足 DSH 的 `validateWave()`（F7）：**

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

**`planSegments` 参数（实测最优）：**

| 参数 | 默认 | 依据 |
|---|---|---|
| `targetSec` | **30** | F19 片长扫描：30 s 产出密度最高；60 s 起明显衰退 |
| `snapSec` | **1.5** | F20：±1.5 s 吸附比固定切点多留 3.8% 内容 |
| `minSec` | 5 | 尾巴不足则并入前一片 |
| `silenceRms` | 0.012 | 归一化 RMS 阈值 |

边界约束：区间连续、不重叠、覆盖 `[0, duration)`，每段样本数为偶数，且**`targetSec` 上限在配置层收窄到 60**（F19：120 s 已进入衰退区）。

### 5.9 `src/asr/sensevoice.js`

**职责**：把音频片段交给 `ctx.speechToText` 转写。名字里的 "sensevoice" 指默认 provider，实际走服务适配。

```js
export async function ensureReady(ctx, providerId, onProgress, signal): Promise<string>
export async function transcribeClips(ctx, { clips, language }, onProgress, signal): Promise<Segment[]>
```

- **不 import 任何 `@deepseek-ai/*`**，只按结构调用：`ctx.get('speechToText')`
- provider 选择：`config.sttProvider` 非空则用；否则 `snapshot().selection.providerId`
- 就绪检查：`snapshot().providers[i].preparation.phase`；非 `ready` 时调 `prepare(id)`，用 `follow(caller)` 订阅进度写进 `run.log`（首次下 239 MB，必须让用户看得见）
- 语言：`config.language`（`auto`/`zh`/`en`/`yue`/`ja`/`ko`）；provider 不支持所选语言时降级 `auto` 并记录
- 逐片调用：
  ```js
  const audio = buildPcmWav(clip.samples, 16000)
  const spec = speech.resolve({ audio, language })
  const { text } = await speech.transcribe(spec, signal)
  ```
- **串行**（provider worker 单进程串行）
- 空文本片段保留在时间轴里（连续性需要），喂 LLM 时跳过
- 已确认的备选方案：若逐片 HTTP 往返开销过大，改为直接驱动 `sherpa-onnx-offline.exe` 并**一次调用传入多片**（F19 记录：一次调用可吃多个 wav，139 片只用了 2 次调用）。该备选**不在本轮范围**，仅在性能实测不达标时启用

### 5.10 `src/asr/index.js`

**职责**：后端选择与显式回退。

```js
/**
 * @returns {{ source: 'subtitle'|'local', language, segments, chapters, notes: string[] }}
 */
export async function transcribeAll(input, deps, onProgress, signal)
```

| 情况 | 行为 |
|---|---|
| 配了 SESSDATA 且 `probe.subtitles` 含中文轨，字幕拉取成功 | 用字幕，`source='subtitle'`，`notes: []` |
| 配了 SESSDATA 但无可用字幕轨 | 回落本地，`notes: ['该视频没有可用字幕轨，已改用本地识别']` |
| **未配 SESSDATA** | **不探测、不猜测**，直接回落本地，`notes: ['未配置 BILI_SESSDATA，已跳过字幕通路，改用本地识别']` |
| 配了 SESSDATA 但字幕拉取失败 | 回落本地，`notes: ['字幕拉取失败（<原因>），已改用本地识别']` |
| `--no-local` 且字幕不可用 | 抛 `BILI_NEEDS_LOGIN` |
| 本地不可用（无 `speechToText`）且字幕不可用 | 抛 `STT_UNAVAILABLE` |

注：`未配 SESSDATA` 时 `notes` 的措辞**不得**声称"该视频有字幕"——匿名状态下无从判断（F2/F3）。

### 5.11 `src/digest/prompt.js`

**职责**：系统提示词与输出契约。纯字符串构造。

正文证据块由 `evidence.toPromptBlock()` 产出（格式见 §5.17），本模块只负责系统提示词与 JSON 契约，**不直接读 probe / transcript**——这样新增证据源时这里无需改动。

系统提示词要求：

- 只输出一个 JSON 对象，不要 markdown 代码块，不要解释文字
- **章节边界只能取给定的时间点**，不允许编造时间
- 章节必须首尾相接、覆盖全片
- **若给了 UP 主章节，以其为骨架**：可合并过短的、可细分过长的，但不得与其大幅冲突
- `keyPoints` 每条必须能在转写里找到依据
- 不确定时宁可少划分章节，不要切碎

**输出契约**（写死在提示词里，由 `validate.js` 逐字段校验；不是独立 schema 文件）：

```json
{
  "title": "string",
  "tldr": "string",
  "keyPoints": [{ "time": 754, "text": "string" }],
  "chapters": [{ "start": 0, "end": 192, "title": "string", "summary": "string", "points": ["string"] }],
  "quotes": [{ "time": 754, "text": "string" }]
}
```

### 5.12 `src/digest/llm.js`

**职责**：调用 `ctx.llm` 并拿到 JSON。

```js
/** @param evidence 证据包（§5.17）；本模块不关心其中各证据源怎么来的 */
export async function summarize(ctx, evidence, { override }, signal): Promise<DigestJson>
```

- 模型解析：`override`（`--model`）→ `config.summaryModel` → `ctx.get('agentDefaultModel').currentSelection()`
- `ctx.get('llm')` 不存在 → 抛 `LLM_UNAVAILABLE`，调用方降级为"只出文稿"
- 流式调用：
  ```js
  for await (const chunk of llm.stream({ provider, model, messages, temperature: 0.2, maxTokens: 8192 })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  ```
  **不 import `BlockAssembler`**（F11）；只消费 `text-delta`，其余分片忽略
- 终止分片 `{ kind: 'error' }` → 按 `failure.code` 映射：`CONTEXT_WINDOW_EXCEEDED` → `LLM_CONTEXT_EXCEEDED`、`RATE_LIMIT` → `LLM_RATE_LIMIT`、其余 → `LLM_FAILED`
- `{ kind: 'aborted' }` → `CANCELLED`
- JSON 解析：先剥 ``` 围栏再 `JSON.parse`；失败**重试一次**（提示词追加"上次输出不是合法 JSON，请只输出 JSON"）
- 两次都失败 → `DIGEST_SCHEMA_INVALID`

### 5.13 `src/digest/validate.js`

**职责**：结构与语义校验，是"防 AI 编时间戳"的闸门。

```js
export function validateDigest(digest, { duration, segments, upChapters }):
  { ok: true, value: DigestJson } | { ok: false, problems: string[] }
```

1. 必填字段与类型齐全
2. 所有 `time` / `start` / `end` ∈ `[0, duration]`
3. `chapters` 非空；`chapters[0].start === 0`（容差 2 s）
4. `chapters[i].end === chapters[i+1].start`（容差 2 s）
5. `chapters.at(-1).end` 与 `duration` 差值 ≤ 2 s
6. 每章时长 ≥ 30 s；不足则与相邻章合并
7. 章节数上限 `max(2, ceil(duration / 60))`；超限则合并最短的相邻对
8. `title` ≤ 30 字符；`tldr` ≤ 400 字符
9. **边界吸附**：把每个 `start`/`end` 吸附到最近的 `segments` 边界（容差 5 s）；吸附后重跑规则 3–6
10. **与 UP 主章节对照**（仅当 `upChapters` 非空）：若某章节**跨越**了 UP 主章节边界，且它的两端都不在该边界 **30 s** 以内，记入 `warnings`（不判失败）。这个口径正好抓「模型把本该分开的两段合成一段」，又不会对"合理合并短章节"误报

返回值：`{ ok: true, value, warnings }` 或 `{ ok: false, problems }`。`warnings` 走返回值而**不塞进 `value`** —— `value` 会被落盘，混入内部字段会污染 §5.11 的输出契约。

通过后返回**修正过的**值；失败返回 `problems` 供重试提示词使用。重试一次仍失败 → `DIGEST_SCHEMA_INVALID`。

### 5.14 `src/render/markdown.js`

```js
export function renderMarkdown({ meta, transcriptMeta, digest, sourceUrl, upChapters }): string
```

时间戳链接：`[mm:ss](https://www.bilibili.com/video/<bvid>?t=<秒>)`

### 5.15 `src/cache.js`

```
<cacheDir>/
├── bin/                    # yt-dlp.exe / ffmpeg.exe（可选，config 为空时）
├── jobs/<jobId>/job.json
├── <bvid>/
│   ├── probe.json          # probe 归约结果 + fetchedAt
│   ├── audio.m4s
│   ├── audio.wav
│   ├── segments.json       # { source, language, notes, segments[], chapters[] }
│   ├── digest.json
│   └── run.log
```

- `probe.json` TTL 10 分钟；`--refresh` 强制忽略
- `segments.json` / `digest.json` 存在即复用，除非 `--refresh`
- 写入走「临时文件 + rename」
- **cookie 临时文件不落这里**：写到 `os.tmpdir()`，`finally` 删除

### 5.16 `src/errors.js`

`BiliDigestError extends Error`，字段 `{ code, hint, cause }`；`hint` 是给用户看的中文补救建议。

### 5.17 `src/evidence.js` 与 `src/pipeline.js`

#### `src/evidence.js` —— 证据包组装（唯一的证据聚合点）

```js
/**
 * 把各来源的观察结果组装成一个证据包。纯函数，零 I/O。
 * @returns Evidence
 */
export function assemble({ probe, transcript }): Evidence

/** 证据包 → 喂给 LLM 的文本块。纯函数。 */
export function toPromptBlock(evidence): string
```

```js
/** @typedef {object} Evidence
 *  @property {object}   meta        // title, duration, uploader, description, tags, url
 *  @property {Chapter[]} chapters   // L0：UP 主章节，可为空数组
 *  @property {object}   transcript  // { source, precision, language, windowSeconds, segments }
 *  @property {Frame[]}  frames      // L2：本轮恒为空数组
 */
```

**证据源清单**（本轮只实现前两项；其余列在册是为了让"加一个证据源"始终是同一个动作）：

| 层 | 证据源 | 本轮 | 成本 |
|---|---|---|---|
| L0 | 元信息（title/duration/uploader/description/tags） | ✅ `probe` 已含 | 0 额外请求 |
| L0 | UP 主章节 `chapters` | ✅ `probe` 已含 | 0 额外请求 |
| L1 | 转写（字幕或本地 ASR） | ✅ | 见 §5.9/§5.10 |
| L2 | 关键帧（`videoshot` 雪碧图 + 时间戳） | ❌ 空数组 | 1 次 HTTP |
| L2 | B 站自带 AI 总结（`conclusion`） | ❌ | 1 次 HTTP |
| L2 | 弹幕密度 / 热门评论 | ❌ | 1–2 次 HTTP |

`toPromptBlock` 产出的文本形如：

```
视频标题：<title>
视频时长：<duration 秒>
UP 主：<uploader>
转写来源：B站字幕 | 本地识别（窗口 30s）
转写精度：句级 | 窗口级
UP主章节：
  [00:00-03:12] 章节标题A
  [03:12-07:45] 章节标题B

带时间戳的转写：
[00:00-00:29] 第一段文字……
[00:30-00:59] 第二段文字……
```

`frames` 非空时，在其后追加 `关键帧：` 段落（本轮不会出现）。

#### `src/pipeline.js` —— 阶段编排

```js
/**
 * 跑完一次作业的所有阶段，逐阶段写缓存与进度。
 * @param onPhase (phase, detail) => void  写 run.log 与 job.phase
 */
export async function run(ctx, cfg, job, deps, signal): Promise<RunResult>
```

阶段与产物：

| phase | 产物 | 可复用条件 |
|---|---|---|
| `probe` | `probe.json` | 存在且未过期（TTL 10 min） |
| `subtitle` | `segments.json` | 存在 |
| `audio` | `audio.m4s` | 存在且非空 |
| `decode` | `audio.wav` | 存在且非空 |
| `window` | 片段计划（内存） | — |
| `transcribe` | `segments.json` | 存在 |
| `evidence` | （内存） | — |
| `digest` | `digest.json` | 存在 |
| `render` | `<bvid>-<slug>.md` | 总是重写 |

**编排规则**：`--refresh` 忽略所有可复用条件；`/bilisub` 只跑到 `transcribe` 就返回（落盘 `segments.json`）；任一步抛 `BiliDigestError` 即终止，已完成的阶段产物保留供重跑复用。`signal` abort 时在阶段边界退出，并把 `job.status` 置为 `cancelled`。

### 5.18 `index.js`

```js
export const name = 'bili-digest'
export const inject = ['commands']

/** ctx 只按结构使用，不 import 任何 @deepseek-ai/*（F11）。 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const logger = ctx.logger
  const registry = new Registry(cfg.cacheDir, logger)
  const handler = (invocation) => runCommand(ctx, cfg, registry, invocation)

  ctx.effect(function* () {
    // 清理：中止在跑作业并等待收尾
    yield async () => { await registry.dispose() }
    yield ctx.commands.register({
      name: cfg.command,                 // 默认 'bilisum'
      description: '提取 B 站视频字幕/音频，AI 总结重点并划分时间段',
      input: { hint: '<BV号|链接> | status <id> | list | cancel <id> [选项]' },
      handler,
    })
  }, 'bili-digest lifecycle')
}
```

`ctx.effect(function* () { … })` 的形态与内置 `dsh-command-compact` 一致：先 `yield` 清理函数，再 `yield` 注册的可释放句柄。

命令注册（**不 import `CommandDefinitionId`**，该字段可选，省略即以插件名命名空间化）：

```js
ctx.commands.register({
  name: cfg.command,                 // 默认 'bilisum'
  description: '提取 B 站视频字幕/音频，AI 总结重点并划分时间段',
  input: { hint: '<BV号|链接> | status <id> | list | cancel <id> [选项]' },
  handler,
})
```

命令处理器契约：

- 返回 `{ kind: 'success', text }` 或 `{ kind: 'error', text }`
- 从 `invocation.rawInput` 解析（命令自己拥有语法）
- `invocation.signal` 贯穿；abort 时中止作业
- 任何异常在处理器内捕获并转成 `{ kind:'error', text: hint }`，**不逃逸到 Harness**
- **返回值过 `compact()`**（F21）
- 所有插值进 `text` 的值必须已 `String()` 化，杜绝 `undefined`

---

## 6. 配置

无 Schemastery（F11），`resolveConfig()` 手写默认值 + 越界校验。

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` | `bilisum` | 命令名 |
| `outputDir` | `''` | 空 = `<workspace>/bili-digest` |
| `cacheDir` | `''` | 空 = `dshCachePath('bili-digest')` |
| `language` | `auto` | `auto`/`zh`/`en`/`yue`/`ja`/`ko` |
| `preferredSubtitleLang` | `zh-Hans` | 候选顺序 `zh-Hans`→`zh-CN`→`zh-Hant`→首个 |
| `windowSeconds` | `30` | 30–60。**上限 60**（F19：120 s 已衰退） |
| `snapSeconds` | `1.5` | 0 关闭吸附；0–5 |
| `minSegmentSeconds` | `5` | 尾片合并阈值 |
| `ytDlpPath` | `''` | 空 = 自动定位/下载 |
| `ffmpegPath` | `''` | 空 = 自动定位 |
| `audioQuality` | `balanced` | `balanced`(30232) / `smallest`(30216) / `best`(30280) |
| `proxy` | `''` | **访问 B 站时的代理**。`''` = 强制直连（默认，F25 实测必需）；`'system'` = 跟随系统代理；其它 = 代理 URL |
| `toolDownloadProxy` | `'system'` | **下载 yt-dlp 时的代理**。`'system'` = 跟随系统（F25 实测 GitHub release 直连不通）；`''` = 直连；其它 = 代理 URL |
| `sttProvider` | `''` | 空 = `speechToText` 当前选择 |
| `summaryModel` | `{ provider: '', model: '' }` | 空 = 继承 agent 默认 |
| `waitSeconds` | `45` | `start` 当场等待秒数；0–120 |
| `maxDurationSec` | `14400` | 超过直接拒绝 |
| `maxKeyPoints` | `8` | 3–20 |
| `keepTranscript` | `true` | 是否落盘 `transcript.json` |

`cordis.patch.yml`：

```yaml
- insert:
    - id: bili-digest
      name: 'dsh-bili-digest'
      config:
        cacheDir: !!js dshCachePath('bili-digest')
```

---

## 7. 命令面

单一命令，子动作由 `rawInput` 解析：

```
/bilisum <BV号|链接> [选项]        # start（默认）
/bilisum status <jobId>           # 查状态；完成则返回结果
/bilisum list                     # 列作业
/bilisum cancel <jobId>           # 取消
```

| 选项 | 含义 |
|---|---|
| `--lang <code>` | 语言提示，覆盖配置 |
| `--window <秒>` | 切窗目标长度（30–60） |
| `--model <provider/model>` | 覆盖摘要模型 |
| `--no-local` | 禁用本地识别兜底 |
| `--out <dir>` | 覆盖输出目录 |
| `--refresh` | 忽略缓存重新抓取 |
| `--update-tools` | 强制更新 yt-dlp |

`start` 行为（对齐 F22）：

- 当场等待至多 `waitSeconds`（默认 45 s）
- 等到了 → 返回终态（结果或错误）
- 没等到 → 返回 `jobId` 与当前 `phase`，用户随后 `/bilisum status <id>`

分P：URL 带 `?p=N` 取第 N P；不带取第 1 P，回执标注「共 M P，已处理第 1 P」。

---

## 8. 输出规格

### 8.1 落盘

```
<outputDir>/bili-digest/<bvid>-<slug>.md
<outputDir>/bili-digest/<bvid>-transcript.json     # keepTranscript
<outputDir>/bili-digest/<bvid>-digest.json
```

`slug`：标题去掉文件系统非法字符、截断 40 字符。

### 8.2 Markdown 模板

```markdown
# <标题>

> 来源：<URL>
> 时长：**mm:ss**
> UP 主：<uploader>
> 转写来源：B站字幕（句级） | 本地识别（窗口 30s，静音点对齐）
> UP 主章节：6 段（已作为划分骨架） | 无
> 生成时间：YYYY-MM-DD HH:mm

<notes 逐条作为引用块>

---

## 一句话总结

<tldr>

## 核心要点

1. **[mm:ss](链接)** 要点文字

## 章节时间轴

| 时间段 | 章节 | 要点 |
| --- | --- | --- |
| [00:00](链接) – [03:12](链接) | 章节标题 | 一句话概括 |

### 详细章节

#### [00:00](链接) – [03:12](链接) 章节标题

<summary>

- 要点 1

## 金句

> **[mm:ss](链接)** 原文引用
```

### 8.3 命令回执

```
✅ 已完成：<标题>
时长 3:33 ｜ 转写来源：本地识别（窗口 30s，静音点对齐）
章节 4 段 ｜ 核心要点 6 条
📄 <绝对路径>.md
⚠️ 未配置 BILI_SESSDATA，已跳过字幕通路，改用本地识别
```

未完成的回执：

```
⏳ 作业已启动：20261012-204133-a1b2c3（当前阶段：transcribe）
16 分钟音频约需 3~6 分钟。查询：/bilisum status 20261012-204133-a1b2c3
```

---

## 9. 错误分类

| code | 触发条件 | 提示方向 |
|---|---|---|
| `BAD_INPUT` | 输入无法解析成视频标识 | 给出正确示例 |
| `BAD_CONFIG` | 配置越界 | 指出字段与合法区间 |
| `UNSUPPORTED_URL` | 非 B 站 / 非 http(s) | 说明仅支持 B 站 |
| `YTDLP_MISSING` | 三个解析路径都失败 | 给出放置路径与 `--update-tools` |
| `YTDLP_FAILED` | yt-dlp 非零退出 | 附 stderr 尾部与结构化原因 |
| `YTDLP_BLOCKED` | stderr 含 `HTTP Error 412` | 指出很可能是代理出口被 B 站拦截，建议把 `proxy` 设为 `''`（F25/F27） |
| `YTDLP_DOWNLOAD_FAILED` | 三个镜像全失败或校验不过 | 列出试过的镜像与各自失败原因 |
| `TOOL_TEMP_UNAVAILABLE` | 子进程报 `Could not create temporary directory` | 指出 `TEMP` 不可写，建议改 `cacheDir`（F26） |
| `BILI_UNSUPPORTED_CONTENT` | 番剧/课程/直播回放 | 说明 v1 不支持 |
| `BILI_NEEDS_LOGIN` | `--no-local` 且字幕不可用 | 说明如何配置 `BILI_SESSDATA` |
| `SUBTITLE_FETCH_FAILED` | 字幕下载失败 | 附原因；已回落本地 |
| `FFMPEG_MISSING` | 定位失败 | 建议重装依赖或配置 `ffmpegPath` |
| `AUDIO_DECODE_FAILED` | ffmpeg 非零退出 | 附 stderr 尾部 |
| `WAV_MALFORMED` | 解析出的 WAV 不合法 | 附期望格式 |
| `STT_UNAVAILABLE` | `ctx.get('speechToText')` 为空 | 说明需启用 voice-input bundle |
| `STT_MODEL_MISSING` | 模型未下载且下载失败 | 说明 239 MB 下载与镜像设置 |
| `STT_FAILED` | provider 推理失败 | 附 provider 错误码 |
| `STT_EMPTY` | 全部窗口产出为空 | **告警而非失败**：走 `notes` 提示「可能是纯音乐或无人声视频；这不代表成功」，作业仍继续（用户至少能拿到"这段没有口播"的结论） |
| `LLM_UNAVAILABLE` | `ctx.get('llm')` 为空 | 降级为只出文稿 |
| `LLM_CONTEXT_EXCEEDED` | 转写超上下文 | 建议换更大上下文模型 |
| `LLM_RATE_LIMIT` | provider 限流 | 稍后重试 |
| `LLM_FAILED` | 其它模型失败 | 附 failure code |
| `DIGEST_SCHEMA_INVALID` | 两次重试后 JSON 仍不合法 | 附校验问题列表 |
| `JOB_NOT_FOUND` | `status`/`cancel` 的 id 不存在 | 提示用 `list` |
| `CANCELLED` | 用户中止 | 已完成阶段已缓存，可重跑 |

全部以 `{ kind:'error', text }` 结算，不抛到 Harness。

---

## 10. 安全与隐私

- `SESSDATA` 只存 `ctx.credentials`（ref `BILI_SESSDATA`，运行时是普通字符串）；配置文件、缓存、日志、命令输出、错误消息中**永不出现其值**
- 给 yt-dlp 的 cookie 写成 **`os.tmpdir()` 下的临时 Netscape 文件**，`finally` 删除；不常驻缓存目录
- 子进程参数一律走数组、不经 shell
- URL 只放行 `http(s)` + host 白名单，挡掉 `file:` 一类本地读取面
- 音频与转写文本只落本地，不上传第三方（本轮无云端 ASR）
- 喂给 LLM 的仅转写文本与视频元信息，不含 cookie、不含用户标识
- `run.log` 写 URL 时剥掉查询参数（音轨 URL 带签名与 `deadline`）
- yt-dlp 下载校验 `SHA2-256SUMS`

---

## 11. 性能与资源预算

| 项 | 预算 |
|---|---|
| 1 小时视频音频 | m4s 约 45 MB；WAV（16k mono PCM16）约 115 MB |
| 切窗数 | 30 s 目标窗 → 约 120 片 |
| 本地推理 | 串行 CPU。同类项目实测：**16 分钟音频 178 s（0.18×）**；69 分钟视频 137 s 出 25,500 字、峰值 6.9 GB |
| LLM 输入 | 约 6k token（1 小时）；上下文 1M，单次足够 |
| 峰值磁盘 | 音频 + WAV + 缓存 < 500 MB（1 小时） |
| 峰值内存 | 完整 PCM 常驻（1 小时 = 115 MB）+ 单片 WAV（≤ 1 MB） |
| 外部请求 | GitHub（首次取 yt-dlp，17 MB，需镜像或代理）+ yt-dlp 自身对 B 站的请求（**必须直连**，见 F25）。风控风险仍在，只是实现责任移交 yt-dlp |

---

## 12. 测试与验收

### 12.1 单元测试（`node --test`，离线）

| 文件 | 覆盖 |
|---|---|
| `url.test.mjs` | BV/av/URL/分P/短链归一化；非法输入；host 白名单 |
| `srt.test.mjs` | CRLF、多行、时间码、乱序/重叠、长行切分 |
| `window.test.mjs` | 规范 WAV 头**逐字节**校验；非规范 chunk 顺序解析；`planSegments` 的 30 s/±1.5 s 行为；最小片长；奇数字节修正 |
| `validate.test.mjs` | 10 条规则的通过与拒绝；边界吸附；章节合并；UP 主章节对照告警 |
| `render.test.mjs` | Markdown 渲染；时间戳链接；notes 呈现 |
| `json.test.mjs` | `compact()` 递归剥离；**对真实磁盘作业记录的无损 JSON 断言**（F21 的守门用例） |
| `evidence.test.mjs` | 证据包组装：probe/transcript 缺项时的降级；`chapters` 为空与非空两条分支；`toPromptBlock` 文本块格式；`frames` 为空时不产生"关键帧"段落 |
| `config.test.mjs` | 默认值、越界拒绝 |
| `errors.test.mjs` | 分类映射与 hint 文案 |

### 12.2 契约测试（录制 fixture，离线）

`test/fixtures/` 保存真实 `yt-dlp --dump-single-json` 输出、SRT 文本、作业记录，注入子进程桩，验证：

- `ProbeInfo` 归约正确（含 `chapters` 与 `subtitles` 两种有无组合）
- 分P / 多 P 的取舍
- yt-dlp 非零退出的错误映射
- 字幕：有字幕（已登录会话录制）与无字幕两条分支

fixture 落库前**必须脱敏**：剥掉所有 URL 查询参数、`Cookie`/`Set-Cookie`、任何 `SESSDATA` 痕迹。

### 12.3 端到端验收（真联网）

**E2E-1 本地通路（不配 SESSDATA）**

```
/bilisum BV1GJ411x7h7
```

- 该视频 213 s。必须：产出 `.md`；`转写来源 = 本地识别`；`notes` 含「未配置 BILI_SESSDATA，已跳过字幕通路」；`chapters[0].start === 0`、`last.end ≈ 213`、相邻无缝；所有时间戳 ∈ [0, 213]
- 必须：`run.log` 可见工具自检、yt-dlp probe、切窗数、逐片识别进度
- 人工核对：Markdown 可读、章节与内容相符、时间戳链接可跳转

**E2E-2 字幕通路（需用户提供 SESSDATA）**

- 配置 `BILI_SESSDATA`，对一个确有字幕的视频执行 `/bilisum`
- 必须：`转写来源 = B站字幕`；段落数与 SRT 条目一致；时间戳与 SRT 完全一致
- 对照：清空 `BILI_SESSDATA` 重跑同一视频，必须出现「已跳过字幕通路」并回落本地

**E2E-3 作业制与长任务**

- 对一个 ≥15 分钟视频执行 `/bilisum`
- 必须：45 s 内返回 `jobId` 与 `phase`；`status` 可查；job.json 在 DSH 重启后仍可查

**E2E-4 UP 主章节**

- 找一个有 UGC 章节的视频，断言 `probe.chapters` 非空、Markdown 头部标出章节数、`validate` 运行了对照检查

**E2E-5 失败路径**

- `BV000` → `BAD_INPUT`；`--no-local` + 无 SESSDATA → `BILI_NEEDS_LOGIN`；番剧链接 → `BILI_UNSUPPORTED_CONTENT`；把 `ytDlpPath` 指向不存在的文件 → `YTDLP_MISSING`

### 12.4 验收证据

- `node --test` 完整输出
- E2E-1 产出的 Markdown 文件
- E2E-2 两条对照的命令回执
- E2E-3 的 job.json 与重启后查询结果
- 章节连续性校验的断言输出

---

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **系统代理出口被 B 站拦截** | 一切都 412，且极难自查（curl 直连通、yt-dlp 不通） | `proxy` 默认 `''` 强制直连；所有 yt-dlp 调用显式传 `--proxy=`；`YTDLP_BLOCKED` 给出可操作提示（F25/F27） |
| **GitHub release 直连不通** | 自动下载 yt-dlp 失败 | 镜像链 `ghproxy.net` → `gh-proxy.com` → 直连；逐个校验 SHA-256（F28） |
| **子进程 temp 不可写** | yt-dlp.exe 起不来，报 PyInstaller 错 | `childEnv()` 强制设 `TEMP`/`TMP`/`TMPDIR` 到 `<cacheDir>/tmp`（F26） |
| 继承系统代理导致「本机能用、插件不能用」 | 最常见的"环境问题"型 bug | 代理策略分目标写死在配置层，`childEnv()` 是唯一构造子进程 env 的地方 |
| yt-dlp 跟不上 B 站接口变更 | 全链路失效 | `--update-tools` 一键更新；`YTDLP_FAILED` 带 stderr 尾部便于定位；yt-dlp 版本写入诊断 |
| 首次需下载 yt-dlp（17 MB） | 首次体验 | 进度落 `run.log`；校验 `SHA2-256SUMS`；失败给出手动放置路径 |
| 宿主拒绝返回值（非无损 JSON） | 整次命令失败且难查 | 出口统一 `compact()`；`json.test.mjs` 对真实作业记录断言（F21） |
| 长任务撞超时 / 用户以为卡住 | 体验差 | 作业制 + `waitSeconds` + `phase` + 落盘 job.json（F22/F23） |
| 匿名无法判断是否有字幕 | 提示文案可能误导 | 不猜、不探测；只陈述"已跳过字幕通路"（F2/F3） |
| SenseVoice 长音频静默丢内容 | 产出残缺文稿被当成完整 | **强制分片**（F19）；片长上限 60；`STT_EMPTY` 与低产出密度告警 |
| 逐片 `speechToText` 往返开销大 | 长视频慢 | 先实测；不达标则切到「直连 sherpa-onnx + 一次传多片」（F19 记录 139 片只用 2 次调用），边界已隔离在 `asr/` |
| ffmpeg 输出非规范 WAV | STT 直接拒绝 | `window.js` 解析 chunk 后重写规范头（已固定） |
| ffmpeg 4.1.0 较旧 | 极冷门编码不支持 | 仅用于 AAC→PCM；`ffmpegPath` 可指向新版 |
| LLM 编造时间戳 | 章节时间轴错误 | 提示词硬约束 + 边界吸附到真实分段 + 连续性校验 + UP 主章节对照 |
| 凭据临时文件残留 | 账号风险 | 写 `os.tmpdir()`，`finally` 删除，不落缓存目录 |
| 分P 只处理第 1 P | 预期落差 | 回执标注「共 M P，已处理第 1 P」 |
| HMR 未配导致改动不生效 | 误以为代码无效 | README 记录 F24 的 `base`/`root` 配置 |

---

## 14. 实施顺序

### P0 — 本地全链路（不依赖登录态）

1. 包骨架：`package.json` / `cordis.patch.yml` / `index.js` / `config.js` / `errors.js` / `json.js`
2. `jobs.js` + 测试（落盘、串行、重启可查）
3. `media/tools.js`（yt-dlp 定位/镜像链下载/SHA-256 校验/`childEnv` 临时目录与代理）+ 测试
4. `media/ytdlp.js` probe + fixture 契约测试
5. 依赖安装：`@ffmpeg-installer/win32-x64`
6. `media/ffmpeg.js` + `audio/window.js`（规范 WAV + `planSegments`）+ 测试
7. `media/ytdlp.js` audio 下载
8. `asr/sensevoice.js` + `asr/index.js`
9. `evidence.js` + 测试
10. `digest/prompt.js` + `digest/llm.js` + `digest/validate.js` + 测试
11. `render/markdown.js` + 测试
12. `pipeline.js` + 命令注册
13. 安装到 profile（`package.json` 加 `link:` 依赖 + `dsh.profile.bundles`）→ **重启桌面版**（F23）
14. E2E-1 / E2E-3 / E2E-5 验收

### P1 — 字幕优先通路 + UP 主章节

15. `media/ytdlp.js` subtitle + `media/subtitle.js` + fixture 测试
16. `asr/index.js` 接入字幕后端与显式回退
17. 凭据接入（`ctx.get('credentials')`，临时 cookie 文件）
18. `probe.chapters` 经 `evidence.js` 接入提示词与 `validate` 对照
19. E2E-2 / E2E-4 验收

---

## 15. 已定默认值（无遗留待定项）

| 问题 | v1 默认 |
|---|---|
| 分P视频 | 处理 `?p=` 指定的 P；无参数时处理第 1 P，回执标注总 P 数 |
| 番剧/课程/直播回放 | 不支持，报 `BILI_UNSUPPORTED_CONTENT` |
| 短链 `b23.tv` | 交给 yt-dlp 解析；失败报 `YTDLP_FAILED` |
| 无字幕且无 SESSDATA | **显式**回退本地识别，在 `notes` 与 Markdown 头部明示（不得静默） |
| 字幕语言 | `zh-Hans` → `zh-CN` → `zh-Hant` → 首个可用；可配置 |
| 切窗 | 目标 30 s，吸附 ±1.5 s，上限 60 s |
| 章节数上限 | `max(2, ceil(duration/60))` |
| UP 主章节 | 有则作为提示词骨架并参与 validate 对照；无则忽略 |
| 超长转写 | 单次调用；`LLM_CONTEXT_EXCEEDED` 时明确报错，map-reduce 留 P2 |
| 代理 | 访问 B 站：**强制直连**（`proxy: ''`）；下载 yt-dlp：**跟随系统代理**（`toolDownloadProxy: 'system'`）。分目标，因为本机两者要求相反（F25） |
| 子进程临时目录 | 一律由 `childEnv()` 设为 `<cacheDir>/tmp`（F26） |
| 音轨选择 | 显式 format_id：`balanced`→30232 / `smallest`→30216 / `best`→30280（F29） |
| 证据包 `frames` | 本轮恒为 `[]`；L2 证据源（关键帧 / B站AI总结 / 弹幕热区）只登记在册，不实现 |
| 视觉模型 | 本轮不涉及。`ctx.llm` 的模型若为纯文本（如 `deepseek-v4.1-flash`），`frames` 非空时需显式配置带 image 输入的模型 |
| 缓存淘汰 | v1 不自动淘汰；LRU 留 P2 |
| 非 B 站站点 | v1 拒绝。yt-dlp 使其几乎免费，但留 P2 并需单独验收 |

---

## 16. 同类项目调研结论

调研日期 2026-10-12。结论：**「B 站字幕优先 + 本地 ASR 兜底 + AI 重点总结 + 时间段划分」这个组合，在 DSH 生态内是空白**；生态外有功能高度重合的产品，但形态不同。

### 16.1 DSH 生态

| 项目 | 星 | 形态 | 做了什么 | 与本插件的关系 |
|---|---|---|---|---|
| [wqzhellohhwy/dsh-video-transcribe](https://github.com/wqzhellohhwy/dsh-video-transcribe) | ★0 | 工具 `video_transcribe` | yt-dlp → ffmpeg → 30 s 分片(±1.5 s) → sherpa-onnx + SenseVoice → 文稿；作业制、复用本机模型、零 `@deepseek-ai/*` | **我们借鉴其 `segment.js` 算法与实测参数（MIT），但不用它的 `joinSegments`**（那会丢时间戳）；不做摘要 |
| [Theodore10086/dsh-tool-transcribe](https://github.com/Theodore10086/dsh-tool-transcribe) | ★0 | 工具 `transcribe` | 本地文件 → faster-whisper → **带时间戳 Markdown** | 只吃本地文件、不做字幕、不做摘要 |
| [ITELMN/video-transcript-skill](https://github.com/ITELMN/video-transcript-skill) | ★1 | Agent Skill | B站/YouTube/抖音字幕文案提取 | 只出文字 |
| [dsh-web-search-pro](https://github.com/anweat/dsh-web-search-pro) | ★77 | 插件 | 把 Bilibili 当搜索引擎之一 | 无关 |
| [dsh-lazyfish](https://github.com/dsh-external/dsh-lazyfish) | — | 插件 | Bilibili 播放器面板 | 无关 |
| [OpenBiliClaw](https://github.com/whiteguo233/OpenBiliClaw) | ★3414 | Agent + DSH 插件 | 多平台内容发现 | 发现，不是总结 |

已扫的 DSH 插件目录：[awesome-dsh-plugins ★51](https://github.com/kejixiaoliang/awesome-dsh-plugins)、[0xsline/awesome-deepseek-harness ★1167](https://github.com/0xsline/awesome-deepseek-harness)、[Zhiyuan-Fan ★574](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins)。**均无 B 站视频总结/章节划分插件。**

### 16.2 生态外

| 项目 | 形态 | 说明 |
|---|---|---|
| [coztde/bili-ai-summarizer](https://github.com/coztde/bili-ai-summarizer) | Edge 扩展 | **功能重合度最高**：字幕优先 → ASR 兜底 → LLM → 章节+时间戳跳转+金句+导图+导出 MD/SRT/Obsidian。用户自备 API Key。ASR 单次上限 25 MB，**不自动切段** |
| [bfftp0502/bilibili-video-summary](https://github.com/bfftp0502/bilibili-video-summary) | Codex Skill | 字幕直取 + 跳帧 OCR；`data/cookies.txt` 存登录态 |
| [moonmoonCL/bilibili-transcript](https://github.com/moonmoonCL/bilibili-transcript) | npm | yt-dlp 为主、CDP 为备取 B站 AI 字幕；印证 yt-dlp 路线 |
| [Lani27/bilibili-downloader-gui](https://github.com/Lani27/bilibili-downloader-gui) | GUI | yt-dlp + 原生字幕选择 |
| [BibiGPT](https://bibigpt.co/blog/posts/deepseek-v4-1m-context-long-video-bibigpt-workflow-2026) | 商业 | 该品类商业标杆 |
| [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) | 文档 | B 站 API 社区权威文档（v1 自写 API 时的依据，v2 已不需要） |

### 16.3 从调研中采纳的修正

| 来源 | 修正 |
|---|---|
| dsh-video-transcribe F19 | 切窗默认 60 s → **30 s**；上限 120 s → **60 s**；强制分片 |
| dsh-video-transcribe F20 | 静音吸附 ±15 s → **±1.5 s** |
| dsh-video-transcribe F21 | 新增：出口统一 `compact()`，无损 JSON |
| dsh-video-transcribe F22 | 新增：作业制，命令 `waitSeconds` |
| dsh-video-transcribe F11 | 零 `@deepseek-ai/*` import；服务走 `ctx.get()` |
| dsh-video-transcribe F23/F24 | 安装与 HMR 的实操约束写入 §14 与风险表 |
| moonmoonCL/bilibili-transcript | 确认 yt-dlp 取 B站字幕可行 → 取数层换 yt-dlp |
| yt-dlp 源码 F16/F17 | 确认字幕（SRT）与 UGC 章节（`view_points`）两条能力 |
| dsh-tool-transcribe | 印证"带时间戳输出"是本类工具的稀缺能力，也是我们的核心价值 |

---

## 17. Spike 实测记录（2026-10-12）

Spike 目的：验证路线 A（yt-dlp 取数）在本机是否真的可行。结论：**可行，但有两个必须先解决的环境陷阱。**

### 17.1 验证通过

| 项 | 结果 |
|---|---|
| yt-dlp.exe 下载 | GitHub 直连不通；`ghproxy.net` 200，得 17,840,399 B |
| SHA-256 校验 | 与官方 `SHA2-256SUMS` **一致** |
| `--version` | `2026.08.19`（需显式 `TEMP`） |
| `probe` | `extractor=BiliBili`、`title`、`duration=212.393`、`uploader`、`formats=15` 全部正确 |
| 音轨清单 | `30216` m4a mp4a.40.5 44k / `30232` m4a mp4a.40.2 103k / `30280` m4a mp4a.40.2 204k |
| 音频下载 | `-f 30232` 得 2.61 MB / 约 2 s |
| 音频容器 | 文件头 `ftyp iso5 … avc1 iso5 dsms msix dash` → **fMP4 + AAC**，ffmpeg 的合法输入 |
| 匿名字幕 | `subtitles=[]`、`automatic_captions=[]` —— 与 F2 一致 |
| **`videoshot` 接口（L2 证据源的可行性）** | 匿名可访问，`code=0`：一次 HTTP 返回 `img_x_len=10 / img_y_len=10 / img_x_size=160 / img_y_size=90`、雪碧图 URL，以及 `index=[0,0,5,11,…]` 共 32 个**秒级时间戳**。→ 「不用下载视频就能拿到全片关键帧」成立，故 L2 关键帧证据源成本极低 |

### 17.2 两个环境陷阱（都已实测复现 + 找到修复）

**陷阱 1：系统代理**

```
ProxyEnable = 1, ProxyServer = 127.0.0.1:7890      ← 本机开着 Clash 类代理
```

`yt-dlp`（Python urllib）**继承**系统代理；`curl.exe` **不继承**。于是出现最容易误判的现象——**同一个 URL，curl 200、yt-dlp 412**。

排查过程与排除项（都试过、都不是原因）：

| 变量 | 结论 |
|---|---|
| User-Agent | 手动换成 Chrome UA，仍 412 |
| Referer | 已带，仍 412 |
| Cookie（`buvid3`/`b_nut`） | 带真实 cookie 文件，仍 412 |
| HTTP 版本 | curl 用 `--http1.1` 仍 200 |
| TLS 指纹 | `--impersonate chrome`（curl_cffi）仍 412 |
| IPv4/IPv6 | `--force-ipv4` 仍 412 |
| **代理** | ✅ **`--proxy=`（空）→ 成功；`NO_PROXY=*` → 成功** |

`--print-traffic` 抓到的决定性证据：

```
send: b'CONNECT www.bilibili.com:443 HTTP/1.0'       ← 走代理隧道
Cookie: b_nut=...; buvid3=...; X-BILI-SEC-TOKEN=3,eyJ...
reply: 'HTTP/1.1 412 Precondition Failed'
```

那个 `X-BILI-SEC-TOKEN` 的 JWT 载荷里写着 `"ip":"103.151.172.70"` —— **不是本机 IP**，是代理出口。B 站按出口 IP 判定并返回 412。

**陷阱 2：临时目录**

```
& yt-dlp.exe --version
→ [PYI-25504:ERROR] Could not create temporary directory!
```

`yt-dlp.exe` 是 PyInstaller onefile，需要在 temp 里解包并加载 DLL。默认 `TEMP` 下失败（该目录从 PowerShell 手动建目录却成功，说明不是朴素的可写性问题，而是子进程解包/加载受限）。显式把 `TEMP`/`TMP`/`TMPDIR` 指向工作区下的自定义目录后正常：

```
2026.08.19
```

### 17.3 未验证（本轮受限于风控与凭据）

| 项 | 原因 | 何时验证 |
|---|---|---|
| **字幕通路** | 需要用户的 `SESSDATA`；匿名 `subtitles=[]` 符合预期但未取到真实字幕 | P1 实施时（E2E-2） |
| **UP 主章节** | 试的视频没有章节；B 站搜索接口也返回 412，无法批量找带章节的视频。源码层已确认 `_get_chapters` → `view_points` | P1 实施时（E2E-4） |
| 端到端（下载→解码→分片→识别） | 未装 ffmpeg、未下 SenseVoice 模型 | P0 实施时（E2E-1） |

### 17.4 Spike 对规格的修正

| 修正 | 依据 |
|---|---|
| 新增 `proxy` / `toolDownloadProxy` 两个配置项，默认分目标 | F25 |
| `childEnv()` 成为子进程 env 的唯一构造点，强制 `TEMP` 与代理 | F25/F26 |
| yt-dlp 下载走镜像链 + SHA-256 校验 | F28 |
| 新增 `YTDLP_BLOCKED` / `YTDLP_DOWNLOAD_FAILED` / `TOOL_TEMP_UNAVAILABLE` 三个错误码 | 17.2 |
| **删除** v2 中"换用 yt-dlp 就能绕开 B 站风控"的表述 | F27 —— 风控在出口 IP 层，yt-dlp 也绕不开 |
| 音轨选择由 `bestaudio` 改为**显式 format_id**（30232/30216/30280） | F29 |
