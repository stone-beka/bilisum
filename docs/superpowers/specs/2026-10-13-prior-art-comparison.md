# 先行项目对比：dsh-video-transcribe vs bili-ai-summarizer

**日期**：2026-10-13
**目的**：B 站视频 → 文本 → 重点总结 + 时间段划分。判断这两个开源项目各自能提供什么、缺什么、该怎么用。
**数据来源**：GitHub API + 两边 README 全文（2026-10-13 拉取），非转述。

---

## 0. 一句话结论

| 项目 | 它是什么 | 对我们的价值 |
|---|---|---|
| **dsh-video-transcribe** | **同形态、同零件**的 DSH 插件，但**只做到"出文稿"** | 它的**踩坑记录**（长音频必须分片、作业必须串行）比它的代码更值钱 |
| **bili-ai-summarizer** | **功能最接近的成品**，已经做了我们最看重的"章节 + 时间戳跳转" | **产品形态的参考答案**；但它靠浏览器登录态拿字幕、ASR 走云端且不分段 |

**关键判断：这两个项目拼起来，正好就是我们要做的东西。**

- 前者给「本地、免费、能处理长视频的转写能力」
- 后者给「章节划分 + 时间戳跳转 + 总结」的产品形态

我们计划的增量只有一块：**前者刻意不做、后者做得不够的"把转写文本切成带时间戳的章节 + 提炼重点"**，并把它包进"证据包"（字幕/转写/画面三层证据统一）里。

---

## 1. 基本盘

| | dsh-video-transcribe | bili-ai-summarizer |
|---|---|---|
| 形态 | **DSH 插件**，注册工具 `video_transcribe` | **Edge MV3 浏览器扩展** |
| 语言 / 体积 | JavaScript，**9 个文件**，38 KB | TypeScript，**119 个文件**，1.5 MB |
| 许可 | MIT | MIT（转码核心等第三方另有许可，见其 `THIRD_PARTY_NOTICES.md` + 两份 ADR） |
| 创建 / 最后推送 | 2026-10-11 / **同一天** | 2026-09-15 / **同一天** |
| ★ / fork | 0 / 0 | 5 / 0 |
| 工程痕迹 | 无 tests 目录，一个 `selftest.mjs` + `e2e.mjs` | 有 `tests/`、`SECURITY.md`、`docs/PRD.md`、ADR、Release 流程 |
| 版本状态 | 一次性发布 | v0.1.5，自称"早期预览阶段"，未上架 |

> 两边都是"单日推送"——即做完一次性推上去，之后没有持续迭代。**没有活跃维护者接手的迹象**，所以指望上游合并我们的需求不现实。

### dsh-video-transcribe 的全部文件

```
index.js        44.5 KB   ← 单文件包含插件全部逻辑
selftest.mjs    23.1 KB
segment.js      11.6 KB   ← 我们计划里「借用」的就是这个
e2e.mjs          7.3 KB
README.md       12.2 KB
cordis.patch.yml  233 B
package.json     941 B
LICENSE
.gitignore
```

**它没有 `src/`，没有 `test/`**。对比我们：10 个模块 + 9 个测试文件 + 198 个测试。这一点在 §4 会展开。

---

## 2. 管线对比

### dsh-video-transcribe

```
yt-dlp            取音轨（并写 info.json，标题/时长从那里来）
  → ffmpeg        转 16 kHz 单声道 PCM wav
    → 分片（约 30 秒一片，切点吸附到静音处）
      → sherpa-onnx + SenseVoice   本地推理
        → 文稿（**纯文本，无时间戳**）
```

直接调 `sherpa-onnx-offline.exe` 子进程，复用本机 `~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/` 下的模型与 `tokens.txt`。

**它的产出终点是文稿**，README 明说：「本工具只负责出文字……模型拿到文字后自己做摘要/翻译/结构化即可」。

### bili-ai-summarizer

```
B站页面 → 读字幕（优先中文 AI 字幕 / 普通中文字幕）
         ↓ 无字幕且用户主动选择
         ASR（云端：Groq / 兼容接口，需自备 Key）
         ↓
       LLM 总结（DeepSeek / 百炼 / 硅基流动 / 智谱 GLM / 自定义 OpenAI 兼容）
         ↓
   快速总结 或 完整笔记（含章节、思维导图、质量提示）
         ↓
   导出：SRT / Markdown / Obsidian
```

**它是完整产品**，但转写和总结都在云端，需要用户自己的 API Key，可能产生费用。

---

## 3. 能力对照（对着我们的需求）

| 我们需要的 | dsh-video-transcribe | bili-ai-summarizer |
|---|---|---|
| B 站视频 → 文本 | ✅ | ✅ |
| **字幕优先** | ❌ README 完全未提字幕通路 | ✅ **明确字幕优先**，无字幕才 ASR |
| 本地 ASR（免费、不出本机） | ✅ SenseVoice 本机推理 | ❌ 云端 ASR，需 Key、计费、音频上传 |
| **长音频处理** | ✅ 30 s 分片 + ±1.5 s 静音吸附 | ⚠️ **25 MB 上传上限，且明确"不会自动切段"** |
| **时间段划分（章节）** | ❌ `joinSegments` **丢弃时间戳** | ✅ **章节 + 点击时间戳回看** |
| 重点总结 | ❌ 交给模型自己做 | ✅ 两种模式；术语 ≤10、金句 ≤5（带时间戳） |
| 逐句时间戳 | ❌ | ❌（只有章节级） |
| 成本 | 全免费本地 | 需自备 Key，可能计费 |
| 隐私 | **媒体不出本机** | 音频/字幕发送给所选服务商，不经项目方中转 |
| 缓存/作业 | 作业落盘，DSH 重启可查，串行 | 本地缓存 50 个视频 / 8 MB 预算 |

### 两边各自的硬伤

**dsh-video-transcribe**
- 不产章节、不产总结——**它把最难的产品化部分留给了调用方**，而"章节划分"恰恰需要时间戳，它又主动丢掉了
- 单文件 44.5 KB，无测试目录
- ★0、无迭代

**bili-ai-summarizer**
- **靠浏览器登录态**：它能"优先读字幕"是因为跑在用户已登录 B 站的浏览器里。我们实测匿名状态下 B 站 `player/v2` 在 10 个分区共 40 个视频里字幕命中 **0/40**，且 yt-dlp 源码自己写着 `Subtitles are only available when logged in`。**换成 DSH 插件后，这条优势直接消失**——除非用户配置 `BILI_SESSDATA`
- **ASR 不分段**：25 MB 上限意味着约 25 分钟的 128 kbps 音频就超了，长视频转写能力实质受限
- 依赖云端，不满足"本地/免费"
- 我们已实测：SenseVoice 整段吃长音频会**静默返回空文本且退出码为 0**，所以"不分段"这条路线在本地跑不通

---

## 4. 对我们已写代码的裁决（诚实版）

执行到 Task 10 时，我们写了 10 个模块、198 个测试、30 个提交。对照来看：

| 我们写的 | 前者是否已有等价能力 | 判断 |
|---|---|---|
| `media/url.js` URL 归一化 | 部分（它直接喂 yt-dlp） | 我们更严（白名单是安全控制） |
| `media/tools.js` 工具定位 + `childEnv` | 有（它也有代理/TEMP 处理） | **重复**，但我们对代理策略的分目标处理更细 |
| `media/ytdlp.js` probe 封装 | 有 | **重复** |
| `media/ffmpeg.js` 解码 | 有 | **重复** |
| `audio/window.js` 规范 WAV | 有（它必须自己做，因为 SenseVoice 同样逐字节校验） | **重复** |
| `jobs.js` 作业注册表 | 有（串行、落盘、phase、cancel） | **重复**，接近逐项对应 |
| `json.js` / `errors.js` / `config.js` / `cache.js` | 有等价物（散在 index.js 里） | **重复** |
| **证据包 / 章节校验 / 字幕通路** | ❌ 前者没有 | **我们的真实增量** |

**结论要说得直白**：Task 1–10 的大部分工作是**把前者一个大文件里已有的能力，重新拆成模块并配了 198 个测试**。这不是零价值（可维护性、测试覆盖、契约明确都真实），但从"多快拿到能用的东西"的角度看，**这是一次重写，不是一次复用**。用户问"为什么那么慢"——这是主要原因之一，我应该在计划阶段就把"复用它的 index.js"作为显式选项摆出来，而不是默认从骨架开始写。

### 值得保留的差异

1. **契约明确 + 198 个测试**：前者无测试目录，改动无回归保护
2. **分目标代理策略**：实测系统代理对 B 站返回 412、对 GitHub release 反而必需，前者未区分
3. **钉死哈希的信任锚**：从源码钉 yt-dlp 的 SHA-256，而不是从同一条镜像链取 SUMS（后者只证完整性）
4. **BV 大小写**：实测 `bv1gj411x7h7` 会解析成**另一个真实视频**，任何"顺手统一大小写"都会静默指错

---

## 5. 那些"实测数字"的归属（重要）

我们规格里的 F19 / F20 长这样：

> **F19**：同类项目实测：单遍 69 分钟音频 → 产出 0 字，退出码仍为 0，峰值内存 58 GB。片长扫描（611 s）：15s→3932 字 / 30s→3816 / 60s→3346 / 120s→2329 / 240s→1027
> **F20**：同类项目实测：切点在 ±1.5 s 内吸附到能量最低处，比固定切点多留 3.8% 内容

**这些数字来自 `dsh-video-transcribe` 的 README，不是我们自己跑的。** 规格已如实标注"同类项目实测"，这一点做得对。我们的 `.scratch/spike/` 里**没有** sherpa-onnx、没有 `.onnx`、没有 `tokens.txt`，可以佐证我们从未在本地跑过 SenseVoice。

我们**自己**实测过的是另一批：

| 事实 | 证据 |
|---|---|
| yt-dlp probe 结构（`extractor=BiliBili`、`formats=15`、音轨 30216/30232/30280） | `.scratch/spike/probe-ok.json` |
| 系统代理对 B 站 412、直连 200 | curl vs yt-dlp 对照 |
| GitHub release 资产直连不可达、镜像可达 | `ghproxy.net` 200 / 直连 000 |
| yt-dlp.exe 的官方 SHA-256 | `.scratch/spike/SHA2-256SUMS` + 本地哈希核对 |
| **ffmpeg 自己的 WAV 不是规范的**（`LIST`/`info`，`data` 在 offset **78** 而非 44） | `.scratch/spike/task9-wav-probe.mjs` |
| ffmpeg 解码字节数恒定 32000 B/s | `.scratch/spike/task9-smoke.mjs` |
| 匿名状态 B 站字幕命中 0/40 | 10 个分区扫描 |
| **BV body 大小写敏感**（小写会指到另一个视频） | 三变体对照 + yt-dlp 实测 |

**这个区分很重要**：F19/F20 是别人在**别人的机器**上测的，直接决定我们选 30 s 片长和 ±1.5 s 吸附窗口。如果要真正承担这两个数字，应该在本机复现一次。这也是 Task 13（本地识别适配）被列为高风险任务的原因。

---

## 6. 建议

### 如果目标是"最快拿到能用的东西"

1. **装 `bili-ai-summarizer`**（Edge 开发者模式加载 `dist.zip`），配一个 LLM Key。它已经做完章节 + 时间戳 + 总结 + Obsidian 导出。**代价**：云端计费、长视频 ASR 受 25 MB 限制、要登录 B 站。
2. 或者 **fork `dsh-video-transcribe`**，它已经把 DSH 形态、作业模型、30 s 分片跑通了。要加的就是"给每个分片带上起止时间 → 交给 LLM 切章节"——**它已经分好片了，时间戳在手上，只是最后丢掉了**。这可能是最短路径。

### 如果要继续我们这条线

按现有分支继续 Task 11 起。但要明确：**我们的增量只有"章节 + 重点 + 证据包"这一块**，前面 10 个任务本质是重写。如果重来，正确做法是 fork `dsh-video-transcribe`，只改 `segment.js`（别丢时间戳）+ 加一个 digest 模块。

### 无论哪条路，都该拿走的教训

- 长音频必须分片，且分片是**功能正确性问题**，不是性能优化（整段会静默返回空文本，退出码还是 0）
- `±1.5 s` 吸附到能量最低处
- 作业制 + 串行（SenseVoice 峰值内存按 GB 计）
- ffmpeg 的 WAV 头不规范，规范头得自己拼
- 名字要钉死（BV 大小写），哈希要钉死（信任锚）

---

## 附：拉取命令

```powershell
curl.exe -s -H "Accept: application/vnd.github+json" https://api.github.com/repos/wqzhellohhwy/dsh-video-transcribe
curl.exe -s -H "Accept: application/vnd.github+json" https://api.github.com/repos/coztde/bili-ai-summarizer
```

（`web_fetch` 对 github.com 会失败，用 `curl.exe` 走 API 可用。）
