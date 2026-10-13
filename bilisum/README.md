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

字幕路线需要登录态。**匿名状态实测字幕命中 0/40**，所以必须登录。

### 方法 A：复制为 cURL（推荐，不用去找 cookie 那一行）

1. 用 Edge 或 Chrome 打开 <https://www.bilibili.com>，**确认已登录**（右上角有头像）
2. 按 `F12` 打开开发者工具，切到 **Network / 网络** 标签
3. **按 `F5` 刷新页面**（不刷新的话请求列表是空的）
4. 在请求列表里**右键任意一条**发往 `bilibili.com` 的请求
5. 选 **Copy → Copy as cURL (bash)**
   （Edge 中文：复制 → 以 cURL 格式复制）
6. **把整段粘给我** —— 里面已经包含了 cookie

不需要你手动挑字段，我那边会解析。

### 方法 B：只要 SESSDATA

1. `F12` → **Application / 应用程序** 标签（看不到就点标签栏的 `>>`）
2. 左侧 **Storage → Cookies → https://www.bilibili.com**
3. 找名字为 **`SESSDATA`** 的那一行，点它
4. 下方 **Value** 列双击全选复制
5. 给我 `SESSDATA=<值>`

> 注意：值里的 `%2C` 是 URL 编码的逗号，**原样复制，别解码**。

### 我拿到之后做什么

```powershell
node scripts/set-cookie.mjs "<你粘贴的内容>"
```

它会：解析 → 调 B 站 `nav` 接口**验证真的登录了** → 才写入 `cache/cookies.txt`（Netscape 格式）。

验证这步很关键：不验证的话，cookie 过期时的症状是"字幕莫名其妙取不到"，你会分不清是**没登录**还是**这个视频本来就没字幕**。校验失败会明确报 `code=-101 账号未登录`，且**不会落盘**。

随时可复查：

```powershell
node scripts/set-cookie.mjs --check
```

### 安全提醒

- `SESSDATA` **等价于你的 B 站登录态**，拿到它等于拿到账号
- 它只存在 `bilisum/cache/cookies.txt`，已被 `.gitignore` 排除，不会进版本库
- 想让它失效：B 站 → 设置 → 安全隐私 → **退出所有设备**
- **不想给完全可以**：`asr` 本地识别路线不需要 cookie（慢一点，但免费、覆盖全部视频）

> 为什么不能我直接读浏览器：Edge/Chrome 的 cookie 库被运行中的浏览器**独占锁定**，
> 连 `CreateFileW` 全共享模式和 `robocopy /B` 都拿不到（本会话未提权）。
> 唯一免关浏览器的办法是 Firefox（其 `cookies.sqlite` 不加密也不独占），但本机没装。


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
| 需要 | **登录 cookie（`SESSDATA`）** | 无（模型已就位） |
| 耗时 | 秒级 | 16 分钟视频约 3–6 分钟 |
| 准确度 | 平台官方字幕，最准 | SenseVoice，中文口播很好 |
| 覆盖 | 有字幕的视频 | 全部 |
| 成本 | 0 | 0 |
| 匿名可用性 | **实测 0/40 命中**（必须登录） | ✅ 完全可用 |

`get` 会自动选：先试字幕，拿不到就落本地识别。

> **所以：没有 cookie 也能用**，只是走 ASR（慢一点，但免费且覆盖全部）。
> Cookie 只影响能否走"字幕"这条快车道。

### 关于"B 站不稳定"的更正

早先我记录过"匿名请求间歇性失败（成功/失败/成功）"。**复测 18 次全部成功**——
那次失败是**我自己突发限流**造成的：短时间内连打排行榜 API、搜索、多次探测。
正常使用（一个视频一次探测）是稳定的。代码里保留重试只是为了顶住偶发限流。

## 字幕是怎么拿到的（这段很反直觉）

**没有走 yt-dlp。** 实测 yt-dlp 对某个视频报"无字幕"，而 B 站的 `player/v2` 接口
明明返回了 `lan=ai-zh`。而且 yt-dlp 拿到的字幕**没有可用的时间轴**，我们要的正是时间轴。
所以直接走官方接口：

```
view?bvid=BV…            → aid, cid, 标题, 时长
player/v2?aid=&cid=      → subtitle.subtitles[] → subtitle_url（带签名的 .json）
下载那个 url             → { body: [{from, to, content}, …] }  ← 官方精确时间轴
```

### 坑：同一个视频有一堆"字幕文件"，只有一个是完整的

同一个视频连调 4 次 `player/v2`，返回的 `subtitle_url` **指向不同文件**，
内容长度天差地别，而 **HTTP 状态码每次都是 200**：

| 返回的文件名（hash 前缀） | 段数 | 覆盖时长 |
|---|---|---|
| `117166825281470413348692…` | **1119** | **2710s ✓ 完整** |
| `113368631412447264608165…` | 30 | 93s |
| `117166825281470413348692…` | 1119 | 2710s ✓ 完整 |
| `16560705161614942327d728…` | 138 | 306s |

那些残缺文件里甚至出现过**完全不相干视频的字幕**（短剧台词），不是截断，是错文件。

**规律**：完整那份的文件名以 **`${aid}${cid}`** 开头
（上例 `117166825281470` = aid，`41334869261` = cid）。

**做法**：每轮重新请求 `player/v2`，先按文件名筛出规范文件，再下载并用
**视频已知时长**校验覆盖度（不足九成视为不完整）。筛名这步很关键——加之前
6 次重试全是垃圾，加之后 **6/6 完整、每次只投 2 次请求**。

> 顺带更正一个我先前写错的判断：curl 与 node fetch 对**同一个 URL** 拿到的长度
> 各自完全稳定（38368 / 33476），所以"截断"不是网络或客户端问题，纯粹是选错了文件。

## 常见问题

**`错误：B 站风控拦截（HTTP 412）`** → 代理没关掉。确认走了 `--proxy=` 且 `NO_PROXY=*`。

**`yt-dlp 探测失败`** → 先跑 `node bilisum.mjs probe <url>` 看是不是链接本身的问题。

**字幕为空** → 要么没登录（cookie 缺失/过期），要么该视频确实没字幕。B 站部分视频需要在播放器里手动开启「中文 AI」字幕才会生成。

**识别结果为空** → 检查窗长。如果某个窗特别长（> 60 s）说明切点吸附异常。
