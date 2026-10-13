# bilisum —— 在 DSH 里贴一个 B 站链接，出重点总结 + 时间段

不用装插件。`yt-dlp` 取内容、`ffmpeg` 转码、本机 `SenseVoice` 识别，最后**由我（对话里的模型）读文本做总结**。

## 目录

```
bilisum/
├─ bilisum.mjs            主程序（Node，避免 PowerShell 的编码坑）
├─ scripts/
│  ├─ yt-dlp.exe          17 MB
│  ├─ ffmpeg.exe          61.5 MB
│  └─ fetch-models.ps1    下载并校验模型
├─ models/
│  ├─ sensevoice-onnx/
│  │  ├─ model.int8.onnx  228 MB  sha256 c71f0ce0…
│  │  └─ tokens.txt       309 KB  sha256 f449eb28…
│  └─ silero/silero_vad.onnx  1.7 MB  sha256 a35ebf52…
├─ cache/                 下载与解码的中间产物（可随时删）
├─ out/                   产出的 Markdown
└─ node_modules/          sherpa-onnx-node 1.13.8（含 win-x64 原生模块）
```

## 用法

```powershell
cd C:\Users\23077\Desktop\b速读\bilisum

node bilisum.mjs probe "BV1GJ411x7h7"          # 只看信息：标题/时长/字幕/音轨
node bilisum.mjs subs  "<url>" --cookie <文件>  # 走字幕（需登录 cookie）
node bilisum.mjs asr   "<url>"                  # 走本地识别（不需 cookie）
node bilisum.mjs get   "<url>" --cookie <文件>  # 字幕优先，没有就落 ASR，并写出 Markdown
```

输入可以是 `BV号`、`av号`、完整链接、或 `b23.tv` 短链。

## 怎么给我 B 站 Cookie

字幕路线需要 `BILI_SESSDATA`。**匿名状态实测字幕命中 0/40**，所以必须登录态。

1. 浏览器打开并登录 B 站
2. F12 → Application/存储 → Cookies → `https://www.bilibili.com`
3. 找到 `SESSDATA`，复制它的值
4. 把它存成一个 Netscape 格式的 cookie 文件，例如 `bilisum/cache/cookies.txt`：

```
# Netscape HTTP Cookie File
.bilibili.com	TRUE	/	FALSE	0	SESSDATA	<把值粘这里>
```

> **安全提醒**：`SESSDATA` 等价于你的 B 站登录态。它会以明文存在这个文件里（已被 `.gitignore` 隔离，不会进 git）。用完想失效就去 B 站退出登录。

## 为什么这么设计（每条都是实测结论）

| 决定 | 原因 |
|---|---|
| B 站**必须直连** | 系统代理 `127.0.0.1:7890` 会让 `api.bilibili.com` 返回 **HTTP 412**；而 HuggingFace / GitHub release **必须走代理**（直连超时）。两个目标策略相反 |
| 清代理要连 `NO_PROXY` 一起设 | Python 的 `getproxies()` 会读 Windows 注册表，只清 `HTTP_PROXY` 不够 |
| `TEMP`/`TMP`/`TMPDIR` 必须重定向 | `yt-dlp.exe` 是 PyInstaller 单文件包，默认 TEMP 下会 `Could not create temporary directory!` |
| BV 号**只规整前缀** | body 是大小写敏感 base58：`bv1gj411x7h7` 会解析成**另一个真实视频**（静默指错），`BV1GJ411X7H7` 直接报错 |
| 走**裸 PCM** 不走 WAV | ffmpeg 的 WAV 头不规范（插 `LIST`/`INFO`/`fact`，`data` 在 offset **78** 而非 44） |
| 长音频**必须分窗** | SenseVoice 整段吃会**静默返回空文本、退出码仍是 0**；69 分钟音频峰值内存 **58 GB** |
| 窗长 30 s、切点 ±1.5 s 吸到能量最低处 | 同源项目实测：15–30 s 已到顶（约 6.4 字/秒）；±1.5 s 吸附比固定切点多留 **3.8%** 内容 |
| 用 Node 不用 PowerShell | 脚本含中文时，PowerShell 无 BOM 会按 GBK 读，字符串字面量会被吃坏导致语法错误 |

## 字幕 vs 本地识别

| | 字幕（`subs`） | 本地识别（`asr`） |
|---|---|---|
| 需要 | 登录 cookie | 模型（已就位） |
| 耗时 | 秒级 | 16 分钟视频约 3–6 分钟 |
| 准确度 | 平台官方字幕，最准 | SenseVoice，中文口播很好 |
| 覆盖 | 有字幕的视频 | 全部 |
| 成本 | 0 | 0 |

`get` 会自动选：先试字幕，拿不到就落本地识别。

## 常见问题

**`错误：B 站风控拦截（HTTP 412）`** → 代理没关掉。确认走了 `--proxy=` 且 `NO_PROXY=*`。

**`yt-dlp 探测失败`** → 先跑 `node bilisum.mjs probe <url>` 看是不是链接本身的问题。

**字幕为空** → 要么没登录（cookie 缺失/过期），要么该视频确实没字幕。B 站部分视频需要在播放器里手动开启「中文 AI」字幕才会生成。

**识别结果为空** → 检查窗长。如果某个窗特别长（> 60 s）说明切点吸附异常。
