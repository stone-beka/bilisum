# 下载 SenseVoice 模型并逐文件校验 SHA-256
# 用途：本地 ASR 路线的模型准备（DSH 自己的 stt-sensevoice/runtime/assets.json 是权威来源）
# 注意：HuggingFace 直连不可达，必须走系统代理；这与 B 站（必须直连）相反。

$ErrorActionPreference = 'Stop'
$base   = "C:\Users\23077\Desktop\b速读\bilisum"
$models = "$base\models"
$tmp    = "$base\cache"
$proxy  = "http://127.0.0.1:7890"
$ua     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
$repo   = "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07"
$vadRepo= "https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc"

# 目标子目录、文件名、URL、字节数、SHA-256
$assets = @(
  @{ dir='sensevoice-onnx'; name='model.int8.onnx';   url="$repo/model.int8.onnx";   bytes=239233841; sha='c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  @{ dir='sensevoice-onnx'; name='tokens.txt';        url="$repo/tokens.txt";        bytes=315894;    sha='f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  @{ dir='silero';          name='silero_vad.onnx';   url="$vadRepo/silero_vad.onnx";bytes=1807522;   sha='a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28' }
)

New-Item -ItemType Directory -Force -Path $models, $tmp | Out-Null

foreach ($a in $assets) {
  $dir  = Join-Path $models $a.dir
  $dest = Join-Path $dir $a.name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  # 已存在且校验通过就直接跳过（幂等）
  if (Test-Path -LiteralPath $dest) {
    $h = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    if ($h -eq $a.sha) { Write-Host "[skip] $($a.name) 已存在且哈希正确"; continue }
    Write-Host "[warn] $($a.name) 已存在但哈希不符，重新下载"
  }

  $part = Join-Path $tmp "$($a.name).part"
  Write-Host "[get ] $($a.name)  ($([math]::Round($a.bytes/1MB,1)) MB) ..."
  # HF resolve -> CDN 会 302，需要 -L；直连不通，必须 --proxy
  & curl.exe -L --fail --proxy $proxy --retry 3 --retry-delay 2 --connect-timeout 30 `
      -H "User-Agent: $ua" -o $part $a.url
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] curl 退出码 $LASTEXITCODE"
    continue
  }

  $got = (Get-Item -LiteralPath $part).Length
  $h   = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $a.bytes -or $h -ne $a.sha) {
    Write-Host "[FAIL] $($a.name) 校验不通过：bytes=$got(期望 $($a.bytes))  sha=$h(期望 $($a.sha))"
    continue
  }
  Move-Item -LiteralPath $part -Destination $dest -Force
  Write-Host "[ OK ] $($a.name)  $got B  哈希一致"
}

Write-Host "`n=== 最终清单 ==="
Get-ChildItem -LiteralPath $models -Recurse -File | ForEach-Object {
  "  {0,12} B  {1}  {2}" -f $_.Length, ($_.FullName -replace [regex]::Escape($models), 'models'), (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower().Substring(0,16)
}
