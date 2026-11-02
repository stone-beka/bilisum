# bilisum —— 贴一条 B 站链接，出一份速读稿

[![ci](https://github.com/stone-beka/bilisum/actions/workflows/ci.yml/badge.svg)](https://github.com/stone-beka/bilisum/actions/workflows/ci.yml)

> 不用装插件，不用开会员，不用把视频看完。给它一个 BV 号 / 链接 / `b23.tv` 短链，它把视频变成一份带时间点的中文速读稿。

**它解决什么**：一条 25 分钟的演讲、一期 40 分钟的杂谈，你只想知道它讲了什么、值不值得看。现在你要么看完，要么看 UP 主自己剪的推广片段。bilisum 走第三条路——**把音轨转录成文，再让模型读文本写速读稿**。

**它不是"AI 总结视频"的又一个套壳**：全链路本地跑，只有最后一步（读文本写稿）发生在对话模型里。

```
链接 ──► yt-dlp 取音轨 ──► ffmpeg 解码裸 PCM ──► 30s 分窗 ──► 本地 SenseVoice(ONNX) 识别
                                                                      │
                                                                      ▼
                                              转写文件（含视频基本信息 + 热门评论）
                                                                      │
                                                                      ▼
                                                       对话里的模型读它 → 写《速读稿》
```

## 先看效果

[`examples/`](examples/) 里有一份**真实产物**：25 分钟的[菲尔兹奖得主邓煜演讲](https://www.bilibili.com/video/BV1A9xh6ZEg4) → 7.5 KB 中文速读稿。摘一段：

> **30 秒速读**：邓煜用 25 分钟讲了三件事：AI 该被当工具用、数学界该怎么用、以及某大厂最近那批「解了几百个开放问题」的证明到底该怎么看。……他的诉求是三条 "proper use"：思路公开、数据可追溯、发布前尽力验证。

不是模板填空——是模型读完 19556 字转写后写出来的。

## 安装

**Windows**：双击 `一键开始.cmd`。它会检查 Node、装依赖、下模型、跑自检，缺什么就告诉你补什么。

**手动三步**：

```bash
git clone https://github.com/stone-beka/bilisum.git && cd bilisum/bilisum
npm install                       # 只有一个依赖：sherpa-onnx-node（本地 ASR）
pwsh scripts/fetch-models.ps1     # 下 SenseVoice 模型（228MB）+ yt-dlp / ffmpeg
node bilisum.mjs doctor           # 自检
```

国内网络最容易卡的三处，脚本已经处理了：

| 问题 | 处理 |
|---|---|
| HuggingFace 连不上 | `fetch-models.ps1` 依次试 `hf-mirror.com` 镜像 → 官方 → 代理，都不行才报错，并给出期望的 SHA-256 |
| 代理该不该走 | 默认读 `HTTPS_PROXY` 环境变量，不写死；而 B 站请求**强制直连**（走代理会 412） |
| yt-dlp / ffmpeg 从 GitHub Releases 下载 | 由 `fetch-models.ps1` 一并处理，不依赖包管理器 |

macOS / Linux：逻辑一样，但 `fetch-models.ps1` 需要 PowerShell（`pwsh`）；也可按脚本里的 URL + SHA-256 手动放文件。

## 装不上？先跑 `doctor`

```
$ node bilisum.mjs doctor
bilisum 安装自检

  ✓  Node 24.18.0         满足 >= 20
  ✓  yt-dlp               取视频信息与音轨 · scripts\yt-dlp.exe
  ✓  ffmpeg               音轨解成裸 PCM
  ✓  SenseVoice 模型       228.2 MB，大小对得上
  ✓  Silero VAD           1.7 MB，大小对得上
  ✓  cache 可写
  ✓  cookie               已登录：xxx

结论：可以跑。先试：node bilisum.mjs probe "BV1A9xh6ZEg4"
```

每一项失败都直接给修复命令；模型只下了一半会按字节数认出来，不会让你跑到一半才发现。

## 为什么值得看代码（而不是只有个 README）

几个真正踩过的坑，都在代码里：

| 坑 | 处理 |
|---|---|
| **B 站字幕接口会返回假文件**：`player/v2` 每次给的 `subtitle_url` 不同，残缺文件甚至是**别的视频的字幕**，而 HTTP 全是 200 | 用 `${aid}${cid}` 文件名前缀硬筛 + 用视频已知时长校验覆盖率，<90% 判为不全，逐轮重新请求换文件（`subsViaApi`） |
| **长音频整段喂会静默返回空文本**，退出码仍是 0 | 30 秒分窗，切点吸附到 ±1.5s 内 RMS 最低的 10ms 帧，避免切断字（`planCuts`） |
| 没登录时评论只给前 3 条且翻页被拦 | 检测到降级就在转写文件头标注"只取到前 3 条"，绝不假装完整 |
| 官方字幕缺失 | 自动降级到本地 ASR，不报错退出 |

## 输出长什么样

转写文件是**中间产物**（`cache/<BV>.transcript.md`），头部自动带：视频基本信息（作者/粉丝数/发布/播放/点赞/投币/收藏/评论/弹幕/时长）、热门评论（默认 40 条）、逐句时间轴。模型读它，产出《速读稿》。

时间轴是纯数字 `[00:01:43]`，不带可点击链接——因为给模型读的版本要省 token；`--full` 会另写一份给人看的。

## 方向研究（`research.mjs`）

单条视频用 `bilisum.mjs get`；**给的是一个方向而不是一条链接**时用 `research.mjs`，它分两阶段，中间强制停下来让人确认：

```bash
node research.mjs "最近显卡价格" --kind price --recon --keywords "显卡 降价|显卡 涨价" --json
node research.mjs "最近显卡价格" --kind price --ups "mid1,mid2" --pick 3 --json
```

第一阶段只做**信源侦察**：按垂直度、近 90 天更新节奏、粉丝与中位播放是否合理，算出 A 档专业源 / B 档相关权威源，并给出被挡掉的原因。**谁来当信源是人的决定，不是工具的**，所以这里必须停。

第二阶段只从确认过的 UP 主页里按方向+时效筛片、取逐字稿、按触发词抽帧。

这个设计解决的问题是：AI 自动搜「谁在讲这个话题」时，永远会推给你播放最高的那个——而播放最高往往不是最专业的。

## 隐私与红线

- **cookie 只在本地**（`cache/cookies.txt`，已 gitignore），仓库里没有、也永远不会有登录凭据
- 音轨、模型、转写产物全部在 `cache/` 与 `models/`，同样不入库
- 登录失效时会打印一个 B 站扫码链接，手机确认后自动续期——**不需要账号密码，也不需要复制 cURL**

## 已知限制（不粉饰）

- 单机、单账号、单人使用；没有并发、没有队列、没有 Web UI
- 测试只覆盖纯函数（16 例，`node --test`）；网络与 ASR 全链路没有自动化测试
- 速度取决于本机 CPU/GPU：25 分钟视频本地识别约 3–5 分钟
- 早期还有一个 `dsh-bili-digest/` 插件原型，**已废弃**（缺入口文件），保留仅为历史；以 `bilisum/` 为准

## License

代码 MIT。视频内容与字幕版权归原权利人，本工具只做个人阅读辅助，请勿用于二次分发。
