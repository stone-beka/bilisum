# 归档：B 站视频 → 重点总结 + 时间段划分（DSH 插件）

**归档日期**：2026-10-13
**状态**：**已终止**（P0 计划 21 个任务完成 10 个，未合并到 master）
**保留原因**：代码、规格、决策记录与踩坑数据完整可续，但**不要再从 Task 11 续写而不先读 `docs/superpowers/specs/2026-10-13-prior-art-comparison.md`** —— 见下面 §4「为什么停」。

---

## 1. 这个仓库里有什么

```
b速读/
├─ dsh-bili-digest/          插件本体（Task 1–10 的产物，198 测试全绿）
│  ├─ src/                   10 个模块，1437 行
│  ├─ test/                  11 个测试文件，2194 行
│  ├─ cordis.patch.yml       插件挂载声明
│  └─ package.json           ESM，依赖 @ffmpeg-installer/win32-x64
├─ docs/superpowers/
│  ├─ specs/2026-10-12-dsh-bili-digest-design.md      833 行，设计规格
│  ├─ specs/2026-10-13-prior-art-comparison.md        ← 先读这个
│  └─ plans/2026-10-12-dsh-bili-digest-p0.md          4067 行，21 个任务的完整实施计划
└─ .superpowers/sdd/2026-10-12-dsh-bili-digest-p0/
   ├─ progress.md            148 行实施账本（每个任务的裁决与踩坑）
   ├─ task-N-brief.md        各任务简报
   ├─ task-N-report.md       各任务实施报告
   └─ review-*.diff          各轮评审的 diff 包
```

### 分支与提交

| | |
|---|---|
| 分支 | `feat/bili-digest-p0`（**未合并**） |
| 相对 master | 领先 31 个提交 |
| master | 5 个提交（只有文档） |
| 归档标签 | `archive/p0-partial-2026-10-13` |
| 最后提交 | `b11e373 test(bili-digest): 补默认采样率断言，杀死 H10 变异` |

**revert / 放弃**：`git checkout master` 即可回到"只有文档"的状态，插件代码全部留在 `feat/bili-digest-p0` 上，不会污染 master。

---

## 2. 完成了什么

| Task | 模块 | 状态 |
|---|---|---|
| 1 | `json.js` 无损 JSON 出口（`compact`） | ✅ 评审通过 |
| 2 | `errors.js` + `config.js` 错误分类与配置校验 | ✅ 评审通过 |
| 3 | `cache.js` 缓存路径与原子读写 | ✅ 评审通过 |
| 4 | `jobs.js` 作业注册表（串行、落盘、可取消） | ✅ 评审通过 |
| 5 | `media/url.js` URL 归一化 + 域名白名单 | ✅ 评审通过 |
| 6 | `media/tools.js` 工具定位 + `childEnv`（分目标代理、TEMP） | ✅ 评审通过 |
| 7 | `media/tools.js` yt-dlp 镜像链下载 + 钉死 SHA-256 | ✅ 评审通过 |
| 8 | `media/ytdlp.js` probe / version 封装 | ✅ 评审通过 |
| 9 | `media/ffmpeg.js` 唯一解码点（裸 PCM） | ✅ 评审通过 |
| 10 | `audio/window.js` 规范 WAV 解析与构造 | ✅ 实现完成（未单独评审） |
| 11–21 | 分窗/下载/ASR 适配/证据包/LLM/章节校验/渲染/编排/命令注册/端到端 | ❌ **未开始** |

**测试：198 / 198 全绿。**

### 未完成的具体缺口

- **Task 11**：静音点对齐切窗（计划里借 `dsh-video-transcribe` 的 `segment.js` 算法并署名）
- **Task 13**：`ctx.speechToText` 适配——**这条路从未在本机验证过**（缺少 sherpa/onnx/tokens 痕迹）
- **Task 19/20**：管线编排与命令注册——**插件目前还不能装进 DSH 用**
- **Task 21**：装进 profile 并端到端验收（需重启 DSH 桌面应用）

> 换句话说：**现在这个插件跑不起来**。它能通过 198 个单元测试，但没有入口（`index.js` 是 Task 20 的产物）。

---

## 3. 值得保留的结论（与代码无关的部分）

这些是执行过程中实测出来的、**任何轮子都不会告诉你**的事实：

| 事实 | 为什么重要 |
|---|---|
| **系统代理 `127.0.0.1:7890` 对 `api.bilibili.com` 返回 412，直连才 200**；而 GitHub release 资产相反（直连 000、走代理 200） | 两个目标需要**相反**的代理策略，所以策略必须是参数而不是常量 |
| **BV 号的 body 是大小写敏感的 base58**：`bv1gj411x7h7` 会解析成**另一个真实存在的视频**（静默指错），`BV1GJ411X7H7` 直接让 yt-dlp 报 `KeyError('bvid')` | 任何"顺手统一大小写"的规整都会把用户悄悄指向别人的视频。只可规整 `BV` 前缀 |
| **ffmpeg 自己的 WAV 不是规范的**：插 `LIST`/`INFO`/`fact` chunk，`data` 在 offset **78** 而非 44 | 而 `ctx.speechToText` 对 WAV 做**逐字节**校验，所以规范头必须自己拼 |
| **匿名状态 B 站字幕命中 0/40**（10 个分区），且 yt-dlp 源码写着 `Subtitles are only available when logged in` | 匿名运行时**不能**对用户说"这个视频有字幕" |
| `yt-dlp.exe` 是 PyInstaller 单文件包，默认 `TEMP` 下会 `Could not create temporary directory!` | 必须显式把 `TEMP`/`TMP`/`TMPDIR` 指到可控目录 |
| `@ffmpeg-installer/win32-x64` 的二进制**在 npm tarball 里**（无 postinstall 下载），61.5 MB | 安装可靠，但要装在**插件目录**而非 profile（`createRequire` 按真实路径解析） |
| pnpm 在 Windows 用**绝对路径 junction** 链 `node_modules` | **整目录移动后链接会悬空**，表现为"依赖明明在却 require 不到"；重跑 `pnpm install` 即修复 |

### 规格里几个数字的归属（别搞混）

- **F19 / F20**（SenseVoice 长音频退化表、30 s 片长、±1.5 s 吸附 +3.8%）→ **来自 `dsh-video-transcribe` 的 README，不是我们在本机跑的**。规格已如实标注"同类项目实测"。
- 上表里的事实 → **我们自己实测**，证据在原本的 `.scratch/spike/`（该目录留在 `C:\Users\23077\Desktop\work_place\视频工作流\.scratch\`，未随本次迁移搬走）。

---

## 4. 为什么停

不是技术失败——10 个任务 198 个测试全绿，每轮评审都抓出了真缺陷。停的原因是**性价比**：

**对照 `docs/superpowers/specs/2026-10-13-prior-art-comparison.md` 后可以确认：Task 1–10 的大部分工作，是把 `dsh-video-transcribe` 一个 44.5 KB 文件里已有的能力，重新拆成模块并配了 198 个测试。** 那是一次重写，不是一次复用。

我们真正的增量只有一块：**它刻意不做、`bili-ai-summarizer` 做得不够的"把转写文本切成带时间戳的章节 + 提炼重点"**。而这恰好是原计划里排在 Task 15–18 的部分——也就是说，**最容易复用的部分先写了，最独特的部分一个都没写。**

计划阶段就该把"直接 fork `dsh-video-transcribe`，只改 `segment.js` + 加一个 digest 模块"作为显式选项摆出来对比，而不是默认从骨架开始。这是这次执行的真正教训。

---

## 5. 如果要继续

**最短路径（推荐先评估）**：fork `wqzhellohhwy/dsh-video-transcribe`。它已经把 DSH 形态、作业模型、30 s 分片、SenseVoice 调用全部跑通并且**分片时时间戳就在手上**——它只是在 `joinSegments` 里丢掉了。增量 = 保留时间戳 + 接一个 digest 模块做章节划分。

**沿本分支续写**：从 Task 11 继续，计划 4067 行里有每个任务的完整代码。但先读账本 `progress.md` 和对比文档，并注意 Task 13（本地识别）这条路**从未在本机验证**，风险最高。

**恢复现场**：
```powershell
cd C:\Users\23077\Desktop\b速读
git checkout feat/bili-digest-p0
cd dsh-bili-digest; node --test        # 应见 198 pass
```

---

## 6. 归档标签

```powershell
git tag -a archive/p0-partial-2026-10-13 -m "P0 部分完成归档：Task 1-10（198/198 测试），Task 11-21 未开始。"
```

分支保持原样，不合并、不删除。
