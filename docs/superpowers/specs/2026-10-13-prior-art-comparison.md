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

## 7. 开源许可与可信度对比

### 7.1 许可：两者差别很大，而且不是"都 MIT"这么简单

| | dsh-video-transcribe | bili-ai-summarizer |
|---|---|---|
| 仓库声明 | MIT | MIT（仅**原创代码**） |
| 运行时依赖 | **零**（package.json 里没有 `dependencies`，纯 Node 内置） | `@ffmpeg/core` 0.12.10、`@ffmpeg/ffmpeg` 0.12.15、react、react-dom |
| **随包分发的第三方二进制** | **无** | **有：`ffmpeg-core.wasm`** |
| **实际分发许可** | **干净的 MIT** | **GPL-2.0-or-later 传染**（见下） |
| 许可核验材料 | 不需要（无第三方二进制） | `THIRD_PARTY_NOTICES.md`、`docs/RELEASE_LICENSE_STATUS.md`、`public/licenses/`、`scripts/check-release-license.mjs` |

**关键点**：`bili-ai-summarizer` 的 npm 声明是 MIT，但它实际打包分发的 `@ffmpeg/core` 是 **GPL-2.0-or-later**（已从 npm registry 核实，非转述）。它自己也明确写了这句话：

> 不能因为 wrapper 是 MIT 就认定整个二进制是 MIT，也不在本次直接认定原创插件必须改 GPL。

所以：
- **想抄它的代码思路** → 没问题（原创代码 MIT）
- **想分发它的构建产物、或把它的转码部分嵌进你的项目** → **GPL 义务跟着走**（要么整体 GPL，要么提供对应源码）
- **想用 `dsh-video-transcribe`** → 纯 MIT，零第三方二进制，没有这个负担

### 7.2 可信度：一边是"一天一次性推送"，一边是 22 个提交 + 真 Release

| | dsh-video-transcribe | bili-ai-summarizer |
|---|---|---|
| 提交数 | **1**（`dd29edc`，全部代码一个提交） | **22**，跨 2026-09-12 → 09-15 |
| 提交信息 | 一条 `feat: 视频链接离线转写插件(长音频强制分片)` | `修复字段不统一`、`导出笔记修复`、`长视频音频压缩`、`收尾`、`清理`… 有真实迭代痕迹 |
| Release | **无** | **v0.1.5**，资产：`dist.zip` + `ffmpeg-core-0.12.10-source-materials.tar.gz` |
| 测试 | `selftest.mjs`（23 KB）+ `e2e.mjs`，无 `test/` 目录 | `tests/` + `npm test`（`node --test`） |
| 安全文档 | 无 | **`SECURITY.md`**，详列密钥存储、网络数据流、权限边界 |
| 架构决策记录 | 无 | 2 份 ADR（MV3 构建栈、API Key 存储与权限） |
| 许可核验 | 不适用 | **`npm run package` 前置跑 `check-release-license.mjs`，不过不许打包** |
| ★ | 0 | 5 |

**`bili-ai-summarizer` 的可信度是这次对比里最出乎意料的部分。** 它的 `SECURITY.md` 和 `RELEASE_LICENSE_STATUS.md` 的详尽程度超过多数商业扩展：

- **诚实标注自身的不足**：明确写"`chrome.storage.local` 不是操作系统级密钥管理器"，恶意扩展/调试器/被入侵账户都可能读到，建议"用短期、低额度 Key"
- **完整网络数据流清单**：什么发给 B 站（BVID/分P/cid + 登录 Cookie，仅发 B 站自有接口）、什么发给 LLM（标题/时长/**带时间戳的字幕全文**/Prompt）、什么发给 ASR（≤25 MB 音频，**仅用户显式点击才发生**）
- **明确拒绝自动计费**：字幕为空或点普通总结按钮时**绝不**触发 ASR 请求
- **双重上限校验**：25 MB 同时检查响应声明大小和实际下载大小；超限**不自动压缩、不切段**，需用户再次明确点击
- **无远程代码**：ffmpeg.wasm 通过 `offscreen` 隐藏页 + Worker 本地转码，音频以可转移二进制缓冲传递、不写入扩展存储，隐藏页拿不到 API Key/Cookie/签名 URL，任务结束即关
- **签名 URL 不落盘**：ASR 音频 URL 不进持久化配置、字幕缓存、导出文件
- **不夸大 GPL 合规**：明写"不把逐字节可复现构建本身当成 GPL 的必然要求"、"本文件也不是向公众作出的三年源码提供书面承诺"，并逐条列出**尚未解决**的事项

而且它**说到做到**：Release 里真的挂了 `ffmpeg-core-0.12.10-source-materials.tar.gz`（约 107 MB、20 个固定提交的源码归档）。

**但它的可信度有一个真实缺口**：`RELEASE_LICENSE_STATUS.md` 自己承认 **"尚未获得 npm tarball 到 CI 构建产物的 provenance 证明，也没有自行重新编译"** —— 也就是说，它核验的是"版本、参数、源码相符"，不是"这个二进制确实由这份源码编译而来"。它诚实地说出了这一点。

**`dsh-video-transcribe` 的可信度则建立在"表面更小"上**：
- 零依赖 → 没有 npm 供应链风险
- 不下载、不分发任何二进制（yt-dlp/ffmpeg/sherpa 全由**用户自己放**到 `<DSH_HOME>/video-transcribe/bin/`）→ 没有下载投毒面，也没有第三方二进制许可负担
- **代价**：单提交、无 Release、无安全文档、无测试目录，你无法从仓库历史判断它的代码经过多少打磨；出问题只能自己读那 44.5 KB 单文件

**一句话**：**许可干净度 `dsh-video-transcribe` 赢；工程可信度 `bili-ai-summarizer` 赢，而且赢得很大。**

---

## 8. 工作流与操作说明

### 8.1 bili-ai-summarizer（Edge 扩展）—— 现在就能用

**安装**
1. 打开仓库 **Releases** → **v0.1.5** → 下载 **`dist.zip`**
   （**别下** `Source code (zip/tar.gz)`，那是源码不是安装包；`ffmpeg-core-…-source-materials.tar.gz` 是 GPL 源码材料，普通用户不需要）
2. 解压到**固定文件夹**（之后不要移动/删除）
3. Edge 地址栏 → `edge://extensions` → 开启 **开发者模式**
4. **加载解压缩的扩展** → 选**直接含 `manifest.json` 的那个文件夹**（不是 ZIP，也不是它的上级目录）
5. 打开/刷新 B 站视频页 → 从扩展菜单点插件 → 打开侧栏

**首次配置**
1. 侧栏右上齿轮 → **AI 总结模型** → 选服务商（DeepSeek / 阿里云百炼 / 硅基流动 / 智谱 GLM / 自定义 OpenAI 兼容）→ 填**自己的 API Key**
2. **保存并设为当前模型** → **测试连接**（这一步会发一个很小的真实请求，会计费）
3. ASR 是可选的：只有要转写**没有字幕**的视频才配

**日常使用流程**
```
打开 B 站视频（确认侧栏显示的视频与分P正确）
  → 点「获取视频字幕」
       ↳ 部分视频要先在播放器手动开启「中文 AI」或普通中文字幕，看到字幕后重新获取
       ↳ 要登录 B 站；刚更新过插件要刷新页面
  → 选「快速总结」或「完整笔记」→ 生成
  → 没有字幕时：点「使用 ASR 转写并总结」（转写完会自动继续总结）
  → 读结果 / 点时间戳回看 / 下载 SRT / 导出 Markdown / 保存到 Obsidian
```

**两种模式怎么选**

| 内容 | 快速总结 | 完整笔记 |
|---|---|---|
| 一句话结论、详细摘要、标签 | ✓ | ✓ |
| 术语与解释（≤10） | ✓ | ✓ |
| 金句 + 时间戳（≤5） | ✓ | ✓ |
| **章节 / 要点 / 关键词** | — | **✓** |
| 思维导图 / 质量提示 | — | ✓ |

**要章节就用「完整笔记」** —— 这正是我们要的功能。

**已知限制（照它的文档）**
- 一次只处理**当前分 P**，不自动总结整套，不识别只出现在画面/PPT/弹幕/评论里的信息
- 以中文总结为主，**不提供自动翻译**
- ASR 单次上传 **25 MB 上限**，**不会自动切段**；超限可手动选"省流量压缩后转写"（原始文件最多 250 MB，仍超限则停止）
- 缓存默认最多 50 个视频 / 8 MB 预算，**会被淘汰**，重要内容要导出
- 需要 Node 22+ 才能从源码构建；普通用户用 `dist.zip` 即可

**费用提醒**：插件免费，但**模型和 ASR 调用花你自己的额度**。ASR 只有你主动点击才会发生。

### 8.2 dsh-video-transcribe（DSH 插件）—— 要手工装

**装前准备**：DSH 桌面应用已能用，且你知道 `$DSH_HOME`（本机是 `C:\Users\23077\.dsh`）。

**第 1 步：放三个二进制 + 复用已有模型**

| 依赖 | 放到 | 说明 |
|---|---|---|
| `yt-dlp.exe` | `<DSH_HOME>\video-transcribe\bin\` | 取音轨 |
| `ffmpeg.exe` | 同上 | 转码 |
| `sherpa-onnx-offline.exe` | 同上 | 推理引擎（sherpa-onnx v1.13.8 官方预编译静态版） |
| `model.int8.onnx` + `tokens.txt` | `<DSH_HOME>\speech-to-text\sensevoice\models\sensevoice-onnx\` | **本机已有，不用下载** |

**注意**：它**不会自动下载**这些。缺了插件**仍会注册**，但调用时会明确告诉你缺什么、去哪放 —— 这是它的设计取舍（换来的是没有下载投毒面）。

**第 2 步：挂进 profile**

先把插件放到某处（clone 或解压），然后在 `C:\Users\23077\.dsh\profiles\desktop\package.json` 里加依赖 —— **照你现有 `@local/dsh-web-search-exa` 那条 `file:` 的写法**，再把它加进 `dsh.profile.bundles`。

它的 `cordis.patch.yml` 只有一行 `insert`，profile 侧按需覆盖 `config`：
```yaml
- id: video-transcribe
  name: dsh-video-transcribe
  config:
    language: zh
    threads: 8
    maxDurationSec: 7200
    chunkSeconds: 30
```

**第 3 步：重启 DSH 桌面应用**
（桌面 profile 不能用 `dsh plugin --profile desktop` 热装，只能改文件 + 重启。）

**第 4 步：调用工具 `video_transcribe`**

| 参数 | 适用 action | 说明 |
|---|---|---|
| `action` | 全部（**必填**） | `start` / `status` / `list` / `cancel` |
| `url` | `start` | 视频/音频链接，**仅接受 http(s)** |
| `jobId` | `status` / `cancel` | 从 `start` 或 `list` 拿到 |
| `language` | `start` | `auto`（缺省）/ `zh` / `en` / `ja` / `ko` / `yue` |
| `label` | `start` | 只影响 `list` 展示 |
| `waitSeconds` | `start` | 最多当场等几秒，缺省 45、上限 120；`0` = 立即返回 |

```
video_transcribe({ action: "start", url: "https://www.bilibili.com/video/BV...", language: "zh" })
  ↳ 等到了 → 直接返回全文
  ↳ 没等到 → 返回 jobId
video_transcribe({ action: "status", jobId: "20261008-002519-349225" })
```

**为什么是作业而不是一次调用**：16 分钟音频在 8 线程 CPU 上要跑 3–6 分钟，而 DSH 工具调用有超时策略。作业状态落盘在 `<DSH_HOME>\video-transcribe\jobs\<id>\job.json`，**DSH 重启后仍可查**；阶段为 `download → convert → segment → transcribe`；**作业串行**（SenseVoice 峰值内存按 GB 计，不允许并发）。

**它的产出终点是纯文本**，没有章节、没有总结 —— 摘要要你在拿到文稿之后自己做。

### 8.3 我们自己的插件 —— 装不了

198 个测试全绿，但 **`index.js` 不存在**（它是 Task 20 的产物），DSH 加载不了。要让它能跑，最少还得补：Task 11 分窗、Task 13 ASR 适配、Task 15 证据包、Task 19 编排、Task 20 命令注册 —— 再加 Task 21 装进 profile 并重启验收。

### 8.4 怎么选

| 你的目标 | 选 |
|---|---|
| **今天就想总结 B 站视频** | **`bili-ai-summarizer`** —— 下载、加载、填 Key，半小时内能出章节笔记。代价：云端计费、要登录、长视频 ASR 受 25 MB 限制 |
| 要**本地/免费/能扛长视频**的转写 | **fork `dsh-video-transcribe`** —— 它已经跑通 DSH 形态 + 30 s 分片，且分片时时间戳还在手上，只是最后丢掉了。增量最小 |
| 要**许可干净**、能随意嵌入 | **`dsh-video-transcribe`**（纯 MIT、零依赖、零第三方二进制） |
| 要**工程与安全实践**参考 | **`bili-ai-summarizer`** 的 `SECURITY.md` + `RELEASE_LICENSE_STATUS.md` + 两份 ADR 值得整个读一遍 |

---

## 附：拉取命令

```powershell
curl.exe -s -H "Accept: application/vnd.github+json" https://api.github.com/repos/wqzhellohhwy/dsh-video-transcribe
curl.exe -s -H "Accept: application/vnd.github+json" https://api.github.com/repos/coztde/bili-ai-summarizer
```

（`web_fetch` 对 github.com 会失败，用 `curl.exe` 走 API 可用。）
