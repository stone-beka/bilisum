# Plan：在 DSH 里贴一个 B 站链接 → 出重点总结 + 时间段划分

**日期**：2026-10-13
**前提**：已终止 21 任务的插件计划（见 `ARCHIVE.md`）。本计划重新设计，目标是把「能用」做出来，而不是把「架构」做完整。

---

## 0. 先直接回答你的两个问题

### Q1：云端 API，有这个服务吗？

**有，而且是整整一类。** 中国的多模态模型基本都吃了 `video_url`：

| 服务 | 模型 | 传入方式 | 限制 |
|---|---|---|---|
| [腾讯云 TokenHub](https://cloud.tencent.com/document/product/1823/136957) | 混元 HY-Vision-Video 等 | `video_url` 类型块，URL 或 Base64 | 请求体 ≤ 100 MB；HY-Vision-Video 不支持 Base64 |
| [智谱 GLM-4.5V](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.5v) | glm-4.5v | `video_url` | 不支持同时理解文件+视频+图像 |
| [小米 MiMo](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/multimodal-understanding/video-understanding) | mimo-v2-omni 等 | `video_url`，可用 `fps`/`media_resolution` 控制 | URL 方式单文件 ≤ 300 MB |
| [硅基流动](https://docs.siliconflow.cn/cn/userguide/capabilities/multimodal-vision) | Qwen3-Omni（音视频同时）、Qwen3-VL | `video_url` | — |
| [Gemini](https://ai.google.dev/gemini-api/docs/video-understanding?hl=zh-cn) | Gemini 系列 | **YouTube URL 直传**（免费预览）/ Files API ≤ 20 GB / 内嵌 ≤ 100 MB | **只认 YouTube，不认任意公网直链** |

调用格式是 OpenAI 兼容的：
```json
{"type":"video_url","video_url":{"url":"https://..."}}
```

### Q2：不能直接找个 AI 的 API 给它吗？

**不能直接给 B 站链接**，而且有三个坑：

**坑 1：B 站媒体 URL 不是"公网可直接访问"。**
这类 API 明确要求「视频 URL 必须为公网可直接访问的地址」。B 站的音视频地址是**签名 + Referer 防盗链**的——`bili-ai-summarizer` 的 SECURITY.md 里写得很清楚：它必须给自己的 CDN 请求**手动设置 `https://www.bilibili.com/` 作为 Referer** 才能通过防盗链。云 API 拿不到这个 Referer，也就取不到文件。
（Gemini 更绝：它只接受 YouTube URL 或 Files API 上传，**明确不接受任意公网视频直链**。）

**坑 2：DeepSeek 完全不支持视频输入。**
你 profile 里有 `deepseek-v4-flash-vision-exp`，那是**图像**视觉，不是视频。

**坑 3（最阴）：有的模型会静默丢掉视频，照样返回 200。**
[API易的实测文档](https://docs.apiyi.com/api-capabilities/video-understanding)点名：**GPT 和 GLM 不支持视频输入，会静默丢掉视频照样返回 200，GPT 还可能编出一段看似合理的答案。** 也就是说你会看到一个自信满满的总结，而它根本没看过视频。

**坑 4（方向问题）：视频理解给的是"画面"，我们要的是"说的话"。**
「重点总结 + 时间段划分」的载体是**转写文本**。视频理解擅长 PPT/场景/物体；对讲座、口播、访谈这类，转写文本**更准、更便宜、还能给出逐句时间戳**。有字幕的情况下更是白送。

> **结论**：视频理解 API 是真实存在的，但对这个需求是**错的工具**，而且它到不了 B 站。正确做法是把视频先变成**文本**，再交给文本模型——而"我自己就是那个文本模型"。

---

## 1. 核心认识：这件事大概率不需要插件

原计划写了一个 21 任务的插件（10 个模块、198 个测试）。但你要的体验是「**在 DSH 里说视频，你帮我总结**」——那意味着：

**我 = 那个插件。** 我手上已经有的：

| 能力 | 状态 |
|---|---|
| `yt-dlp.exe`（取字幕/音轨） | ✅ 17 MB，在 `视频工作流\.scratch\spike\yt-dlp.exe` |
| `ffmpeg.exe`（转 16k 单声道） | ✅ 61.5 MB，在 `b速读\dsh-bili-digest\node_modules\@ffmpeg-installer\win32-x64\` |
| shell 执行 | ✅ 我有 `pwsh` |
| **理解并总结文本** | ✅ **我就是 LLM** |

**唯一缺的一环：没有字幕时，怎么把音频变成文字。** 而这正好是原计划里最重的那部分（Task 12–14）。

### 这一环刚刚查清了

| 事实 | 证据 |
|---|---|
| DSH 的 ASR 引擎 `sherpa-onnx` **已经在本机** | `E:\dsh\resources\app.asar.unpacked\dsh\node_modules\sherpa-onnx-win-x64\`：`sherpa-onnx.node`（原生模块）+ `onnxruntime.dll` + 两个 API DLL |
| **但 SenseVoice 模型没下载** | 全盘（`~/.dsh`、`E:\dsh`、桌面）搜 `model.int8.onnx` / `silero_vad.onnx` / `sensevoice-onnx` → **零命中** |
| 模型的**确切地址 + 大小 + SHA-256** 已知 | 从 DSH 自己的 `stt-sensevoice/runtime/assets.json` 取到 |

模型清单（可直接下载并校验）：

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `model.int8.onnx` | 239,233,841 B | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| `tokens.txt` | 315,894 B | `f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc` |
| `silero_vad.onnx` | 1,807,522 B | `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28` |

来源：`https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`（固定 commit `2365bae`）
默认落盘位置：`<dataRoot>/models/sensevoice-onnx/` 与 `<dataRoot>/models/silero/`

---

## 2. 三条路线

### 路线 A —— 字幕优先（**最快、免费、最准**）

```
你贴链接
  → 我跑 yt-dlp --write-subs 拿 B 站 AI 字幕（带时间戳）
  → 我直接读文本，输出重点 + 时间段
```

- **成本**：0；**耗时**：秒级
- **前提**：需要 `BILI_SESSDATA`（B 站登录 Cookie）
  **为什么必须登录**：原计划实测过，**匿名状态在 10 个分区共 40 个视频里字幕命中 0/40**；yt-dlp 源码自己写着 `Subtitles are only available when logged in`
- **覆盖**：有字幕的视频（B 站 AI 字幕覆盖率高，但非全部）

### 路线 B —— 本地 ASR（**免费、离线、覆盖全部**）

```
你贴链接
  → yt-dlp 下音轨（-f 30232）
  → ffmpeg 转 16 kHz 单声道 裸 PCM（32 KB/s）
  → 30 秒分窗 + ±1.5 秒静音对齐
  → sherpa-onnx + SenseVoice 逐窗识别（带起止时间）
  → 我读带时间戳的文本，输出重点 + 时间段
```

- **成本**：0（一次性下载 240 MB 模型）；**耗时**：16 分钟视频约 3–6 分钟
- **为什么必须分窗**：实测（同源项目数据，规格 F19）**整段喂进去会静默返回空文本、退出码仍是 0**，69 分钟音频峰值内存 **58 GB**。分窗后内容 ×22、内存 ÷6.5
- **不走 DSH 的 `ctx.speechToText`**：那是给**插件**用的 Cordis 服务，我作为 agent 调不到。所以直接用本机那个 `sherpa-onnx` Node 原生模块写脚本

### 路线 C —— 云 API（备用）

- 云 ASR（Whisper 类）或视频理解模型
- **需要 key、要花钱、有大小限制**（一般 25 MB，约 25 分钟音频）
- 视频理解还需先把音频传到公网可达处
- 只在 A、B 都不通时用

**推荐组合：A 优先，失败落 B。** C 留作应急。

---

## 3. 建议的实施步骤（比原计划小一个数量级）

| 步 | 做什么 | 产出 | 预估 |
|---|---|---|---|
| 0 | 你提供 `BILI_SESSDATA`；确认是否允许下载 240 MB | 决策 | — |
| 1 | 探测脚本：给链接 → 标题/时长/字幕清单/音轨清单 | `probe.mjs` 或直接一次性命令 | 小 |
| 2 | 字幕通路：`yt-dlp --write-subs` → 带时间戳文本 | 字幕路径跑通 | 小 |
| 3 | ASR 通路：下载模型 + 校验 SHA-256 + sherpa 脚本 + 分窗 | 本地识别跑通 | 中 |
| 4 | 总结提示词：输入带时间戳文本 → 输出「重点 + 时间段」 | 我直接做 | 小 |
| 5 | 串起来：一条命令/一个 Skill，贴链接就出结果 | 可用 | 小 |
| 6 | （可选）打成 DSH Skill，以后一句话触发 | 体验 | 中 |

**Task 2 与 Task 3 可以并行**——字幕通路和 ASR 通路互不依赖。

### 从原插件里保留的东西（已验证，直接抄结论即可）

- ffmpeg 的 WAV **不是规范的**（插 `LIST`/`INFO`/`fact`，`data` 在 offset **78** 而非 44）→ 规范头要自己拼（不过如果直接喂裸 PCM 给 sherpa，可能根本不需要 WAV 头，待验证）
- **BV 号 body 大小写敏感**：`bv1gj411x7h7` 会解析成**另一个真实视频** → 只可规整 `BV` 前缀
- **系统代理 `127.0.0.1:7890` 对 B 站返回 412**，必须直连（`--proxy=` 或 `NO_PROXY=*`）
- `yt-dlp.exe` 是 PyInstaller 单文件包，需要把 `TEMP`/`TMP`/`TMPDIR` 指到可写目录
- B 站风控会返回 **HTTP 412 + HTML 错误页**，解析前要先看状态码和 content-type

---

## 4. 需要你定的三件事

1. **`BILI_SESSDATA` 给不给？** 给了就能走路线 A（秒级、免费、最准）。不给只能走 B（3–6 分钟/视频，但免费且覆盖全部）。
2. **允许下载 240 MB 的 SenseVoice 模型吗？** 这是路线 B 的前提，一次性。
3. **输出格式**想要什么？比如：
   - 只要聊天里一段「重点 + 时间段」
   - 还是同时落一个 Markdown 文件到工作区
   - 时间段粒度想多细（自动，还是你指定大致数量）

---

## 5. 与原计划的关系

原计划的分支 `feat/bili-digest-p0` 与标签 `archive/p0-partial-2026-10-13` 保持不动。里面有价值的是**实测结论**（§3 那五条）和**规格文档**，不是那 10 个模块——那 10 个模块是给"一个能被别人安装的插件"准备的，而你要的是"在聊天里能用"。

**本计划跑通后，如果还想做成正式插件**，那 10 个模块（作业注册表、原子写、配置校验、代理策略）可以再捡回来当外壳——但那时外壳是**已知能用之后**的包装，而不是先写外壳再找内核。
