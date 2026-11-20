# 发布到 VS Code Marketplace（豆包编程助手）
# 用法：双击 dist\发布.cmd，或在扩展目录执行：pwsh -File ..\..\tools\publish.ps1
param(
  [string]$Version = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root "extension\doubao-coder"

Set-Location $ext
$pkg = Get-Content (Join-Path $ext "package.json") -Raw | ConvertFrom-Json
$publisher = $pkg.publisher
$name = $pkg.name
if (-not $Version) { $Version = $pkg.version }
"发布：$publisher.$name@$Version"

if (-not $env:VSCE_PAT) {
  $secure = Read-Host -AsSecureString "粘贴 Marketplace PAT（输入不回显）"
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:VSCE_PAT = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if (-not $env:VSCE_PAT) { throw "没有 PAT，已取消。" }

"== 1/2 发布 =="
npx --yes @vscode/vsce publish --allow-missing-repository 2>&1 | Tee-Object -Variable out | Out-Host
if ($LASTEXITCODE -ne 0) {
  "发布失败：请检查 publisher 是否已创建（https://marketplace.visualstudio.com/manage）、PAT 是否有 Marketplace: Manage 权限。"
  exit $LASTEXITCODE
}

"== 2/2 等待商店生效 =="
$url = "https://marketplace.visualstudio.com/items?itemName=$publisher.$name"
for ($i = 1; $i -le 40; $i++) {
  Start-Sleep -Seconds 15
  try {
    $resp = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 20
    if ($resp.StatusCode -eq 200) { "已上架：$url"; break }
  } catch {
    "等待中（第 $i 次，最多 10 分钟）…"
  }
}
Start-Process $url