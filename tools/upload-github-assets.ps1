# 把 README 与截图上传到 GitHub 仓库（需要 GitHub PAT）
# 用法：双击 dist\上传到GitHub.cmd
param([string]$Token = $env:GITHUB_TOKEN)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root "extension\doubao-coder"
$owner = "xk5320"
$repoName = "doubao-coder"
$api = "https://api.github.com/repos/$owner/$repoName"

if (-not $Token) {
  $secure = Read-Host -AsSecureString "粘贴 GitHub PAT（classic 勾 repo / fine-grained 勾 Contents 读写，输入不回显）"
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if (-not $Token) { throw "没有 token，已取消。" }
$headers = @{ Authorization = "Bearer $Token"; "User-Agent" = "doubao-coder"; Accept = "application/vnd.github+json" }

function Put-File([string]$path, [string]$file, [string]$message, [string]$branchParam) {
  $url = "$api/contents/$path"
  $bytes = [IO.File]::ReadAllBytes($file)
  $obj = @{ message = $message; content = [Convert]::ToBase64String($bytes) }
  if ($branchParam) { $obj.branch = $branchParam }
  try {
    $existing = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -ErrorAction Stop
    $obj.sha = $existing.sha
  } catch { }
  $body = $obj | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri $url -Headers $headers -Method Put -Body $body -ContentType "application/json" | Out-Null
  "已上传：$path"
}

# 空仓库：第一次提交不带 branch，创建默认分支
Put-File "README.md" (Join-Path $ext "README.md") "docs: add README" ""
$info = Invoke-RestMethod -Uri $api -Headers $headers -Method Get
$branch = if ($info.default_branch) { $info.default_branch } else { "main" }
"默认分支：$branch"

foreach ($name in @("shot01.png", "shot02.png")) {
  $local = Join-Path $ext "media\screenshots\$name"
  Put-File "docs/screenshots/$name" $local "docs: add screenshot $name" $branch
}

$base = "https://raw.githubusercontent.com/$owner/$repoName/$branch"
"图片地址："
"$base/docs/screenshots/shot01.png"
"$base/docs/screenshots/shot02.png"
Start-Sleep -Seconds 3
foreach ($url in @("$base/docs/screenshots/shot01.png", "$base/docs/screenshots/shot02.png")) {
  try { $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 20; "OK $($r.StatusCode) $url" } catch { "未生效（稍等再试）：$url" }
}
Start-Process "https://github.com/$owner/$repoName"