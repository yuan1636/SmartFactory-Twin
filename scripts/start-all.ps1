<#
  SmartFactory Twin 一键启动（第 3 阶段 Batch 2）

  顺序：数据库容器 → 等 pg_isready → 后端 uvicorn → 数据模拟器 → 前端 Vite
  用法（仓库根目录）：
      powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1

  说明：
  - 后端 / 模拟器 / 前端各起一个新窗口，窗口不要关，关掉对应服务就停。
  - 8000 已被占用时跳过后端启动（避免 uvicorn 端口冲突直接退出）。
  - 任何一步失败都打印退出码并以同样的码退出，便于脚本化调用。
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step([int]$index, [string]$text) {
    Write-Host ("[{0}/4] {1}" -f $index, $text) -ForegroundColor Cyan
}

function Write-Note([string]$text) {
    Write-Host ("        " + $text) -ForegroundColor DarkGray
}

function Exit-Fail([int]$index, [string]$text, [int]$code) {
    Write-Host ("[{0}/4] 失败：{1}（退出码 {2}）" -f $index, $text, $code) -ForegroundColor Red
    exit $code
}

function Test-PortBusy([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

# ---------------- [1/4] 数据库 ----------------
Write-Step 1 '启动 PostgreSQL 容器（docker compose up -d）'
docker compose up -d
if ($LASTEXITCODE -ne 0) { Exit-Fail 1 'docker compose up -d' $LASTEXITCODE }

Write-Step 1 '等待数据库就绪（pg_isready，最多 60 秒）'
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    docker exec sftwin-db pg_isready -U sf -d smartfactory *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ready) { Exit-Fail 1 '数据库 60 秒内未就绪，请执行 docker logs sftwin-db 查看' 1 }
Write-Note '数据库已就绪：127.0.0.1:5433 / smartfactory'

$py = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
    Write-Host '找不到 .venv\Scripts\python.exe，请先创建虚拟环境并安装 requirements.txt' -ForegroundColor Red
    exit 1
}

# ---------------- [2/4] 后端 ----------------
Write-Step 2 '启动后端 FastAPI（新窗口，127.0.0.1:8000）'
if (Test-PortBusy 8000) {
    Write-Note '8000 端口已被占用，跳过启动（要重启请先结束旧进程）'
} else {
    $backendCmd = "& '$py' -m uvicorn app.main:app --port 8000"
    Start-Process -FilePath 'powershell' -ArgumentList '-NoExit', '-Command', $backendCmd -WorkingDirectory $root

    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $resp = Invoke-WebRequest 'http://127.0.0.1:8000/api/v1/health' -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) { $ok = $true; break }
        } catch {
            # 后端还在启动，继续等
        }
    }
    if (-not $ok) { Exit-Fail 2 '后端 30 秒内未响应 /api/v1/health' 1 }
    Write-Note '后端已就绪：http://127.0.0.1:8000/docs'
}

# ---------------- [3/4] 模拟器 ----------------
Write-Step 3 '启动数据模拟器（新窗口，2 秒一个采样点）'
$simCmd = "& '$py' -m data_pipeline.simulator"
Start-Process -FilePath 'powershell' -ArgumentList '-NoExit', '-Command', $simCmd -WorkingDirectory $root
Write-Note '模拟器每 2 秒写一轮；新增窗口里 Ctrl+C 可停（会打印统计块）'

# ---------------- [4/4] 前端 ----------------
Write-Step 4 '启动前端 Vite（新窗口，127.0.0.1:5173）'
$frontDir = Join-Path $root 'frontend'
if (-not (Test-Path (Join-Path $frontDir 'node_modules'))) {
    Write-Note '未找到 node_modules，先执行 npm install（约 1 分钟）'
    Push-Location $frontDir
    npm install --no-audit --no-fund
    $installCode = $LASTEXITCODE
    Pop-Location
    if ($installCode -ne 0) { Exit-Fail 4 'npm install' $installCode }
}
Start-Process -FilePath 'powershell' -ArgumentList '-NoExit', '-Command', 'npm run dev' -WorkingDirectory $frontDir

# 等 Vite 起来再给结论，避免用户以为没启动
$webOk = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest 'http://127.0.0.1:5173/overview' -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $webOk = $true; break }
    } catch {
    }
}
if ($webOk) {
    Write-Note '前端已就绪：http://127.0.0.1:5173/overview'
} else {
    Write-Note '前端窗口已打开但 20 秒内未响应 5173，请查看该窗口的报错'
}

Write-Host ''
Write-Host '全部启动完成。三个服务窗口请保持打开：' -ForegroundColor Green
Write-Host '  后端   http://127.0.0.1:8000/docs'
Write-Host '  前端   http://127.0.0.1:5173/overview'
Write-Host '  数据库 docker ps 可见 sftwin-db（宿主端口 5433）'
exit 0
