# 下载 SenseVoice 模型（本地 ASR 用）并逐文件校验 SHA-256
#
# 用法：
#   pwsh scripts/fetch-models.ps1                # 自动选最快的源（先镜像，再官方）
#   pwsh scripts/fetch-models.ps1 -Proxy http://127.0.0.1:7890
#   pwsh scripts/fetch-models.ps1 -Check         # 只校验已有文件，不下载
#   pwsh scripts/fetch-models.ps1 -Force         # 忽略已有文件，强制重下
#
# 设计要点（都是踩过的坑）：
#   - 路径全部相对脚本位置推导：别人 clone 到哪都能用（旧版写死了绝对路径）
#   - 代理不写死：默认读 HTTPS_PROXY / HTTP_PROXY 环境变量，没配就直连
#   - 源可换：HuggingFace 在墙内常常连不上，先试 hf-mirror.com 镜像
#   - 校验 bytes + SHA-256 双保险：下到半截的文件必须拒绝

param(
  [string]$Proxy = "",
  [switch]$Check,
  [switch]$Force,
  [string]$Mirror = "https://hf-mirror.com"
)

$ErrorActionPreference = 'Stop'

# 脚本在 <repo>/bilisum/scripts/ 下，仓库根是上两级
$here   = $PSScriptRoot
$base   = Split-Path -Parent $here
$models = Join-Path $base 'models'
$tmp    = Join-Path $base 'cache'
$ua     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'

# 没显式给 -Proxy 就看环境变量；都没有就直连
if (-not $Proxy) {
  if ($env:HTTPS_PROXY) { $Proxy = $env:HTTPS_PROXY }
  elseif ($env:HTTP_PROXY) { $Proxy = $env:HTTP_PROXY }
}

$assets = @(
  @{ dir='sensevoice-onnx'; name='model.int8.onnx'; path='/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx'; bytes=239233841; sha='c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  @{ dir='sensevoice-onnx'; name='tokens.txt';      path='/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt';        bytes=315894;    sha='f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  @{ dir='silero';          name='silero_vad.onnx'; path='/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx';                                     bytes=1807522;   sha='a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28' }
)

function Test-Asset($asset) {
  $dest = Join-Path (Join-Path $models $asset.dir) $asset.name
  if (-not (Test-Path -LiteralPath $dest)) { return $false }
  if ((Get-Item -LiteralPath $dest).Length -ne $asset.bytes) { return $false }
  $h = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
  return ($h -eq $asset.sha)
}

Write-Host "模型目录：$models"
if ($Proxy) { Write-Host "代理：$Proxy" } else { Write-Host "代理：直连（如需代理请设 HTTPS_PROXY 或加 -Proxy）" }

if ($Check) {
  Write-Host "`n=== 校验模式 ==="
  $bad = 0
  foreach ($a in $assets) {
    if (Test-Asset $a) { Write-Host ("  [ OK ] {0}" -f $a.name) }
    else { Write-Host ("  [MISS] {0}（缺失或哈希不符）" -f $a.name); $bad++ }
  }
  if ($bad -gt 0) { Write-Host "`n共 $bad 个文件需要下载：pwsh scripts/fetch-models.ps1" }
  exit $bad
}

New-Item -ItemType Directory -Force -Path $models, $tmp | Out-Null

# 候选源：镜像优先（墙内更快），再官方
$hosts = @($Mirror, 'https://huggingface.co')
if ($Proxy) { Write-Host "（每个源会先直连试一次，失败再走代理）" }

foreach ($a in $assets) {
  $dir  = Join-Path $models $a.dir
  $dest = Join-Path $dir $a.name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  if (-not $Force -and (Test-Asset $a)) {
    Write-Host ("[skip] {0} 已存在且校验通过" -f $a.name)
    continue
  }

  $part = Join-Path $tmp ("{0}.part" -f $a.name)
  $got  = $false

  foreach ($h in $hosts) {
    foreach ($useProxy in @($false, $true)) {
      if ($useProxy -and -not $Proxy) { continue }
      $url = "$h$a.path"
      $via = if ($useProxy) { "经代理 $Proxy" } else { '直连' }
      Write-Host ("[get ] {0}  ({1} MB)  ← {2} {3}" -f $a.name, [math]::Round($a.bytes / 1MB, 1), $h, $via)

      $curlArgs = @('-L', '--fail', '--retry', '2', '--retry-delay', '2', '--connect-timeout', '20', '-H', "User-Agent: $ua", '-o', $part, $url)
      if ($useProxy) { $curlArgs = @('--proxy', $Proxy) + $curlArgs }

      & curl.exe @curlArgs 2>$null
      if ($LASTEXITCODE -ne 0) {
        Write-Host ("       失败（curl 退出码 {0}），换下一个源" -f $LASTEXITCODE)
        continue
      }

      $size = (Get-Item -LiteralPath $part).Length
      $hash = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLower()
      if ($size -ne $a.bytes -or $hash -ne $a.sha) {
        Write-Host ("       校验不通过：{0} B（期望 {1}） sha={2}" -f $size, $a.bytes, $hash.Substring(0, 16))
        continue
      }
      Move-Item -LiteralPath $part -Destination $dest -Force
      Write-Host ("[ OK ] {0}  {1} B  哈希一致" -f $a.name, $size)
      $got = $true
      break
    }
    if ($got) { break }
  }

  if (-not $got) {
    Write-Host ("[FAIL] {0} 所有源都失败。" -f $a.name)
    Write-Host "       可手动下载后放到：$dest"
    Write-Host ("       期望 bytes={0} sha256={1}" -f $a.bytes, $a.sha)
  }
}

Write-Host "`n=== 最终清单 ==="
$allOk = $true
foreach ($a in $assets) {
  if (Test-Asset $a) { Write-Host ("  [ OK ] {0}" -f $a.name) } else { Write-Host ("  [MISS] {0}" -f $a.name); $allOk = $false }
}
if ($allOk) {
  Write-Host "`n模型就绪。下一步：node bilisum.mjs doctor"
} else {
  Write-Host "`n还有文件没就绪；装好后重跑本脚本的 -Check 验证。"
  exit 1
}
