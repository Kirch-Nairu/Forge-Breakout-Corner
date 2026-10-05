$ErrorActionPreference = "Stop"

$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$ModelFile = Join-Path $Here ".runtime\models\Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf"
$ModelUrl  = "https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf?download=true"
$Logs      = Join-Path $Here ".runtime\logs"
$Models    = Join-Path $Here ".runtime\models"
New-Item -ItemType Directory -Force -Path $Logs,$Models | Out-Null

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Find-Llama {
    $server = Get-Command llama-server.exe -ErrorAction SilentlyContinue
    if (-not $server) { $server = Get-Command llama-server -ErrorAction SilentlyContinue }

    $links = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    if (-not $server -and (Test-Path (Join-Path $links "llama-server.exe"))) {
        $server = Get-Item (Join-Path $links "llama-server.exe")
    }
    return $server
}

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host " KIRION QWEN DOSSIER EXPERIMENT" -ForegroundColor Cyan
Write-Host "============================================`n" -ForegroundColor Cyan

Set-Location $Here
python .\selftest.py

$server = Find-Llama
if (-not $server) {
    Write-Host "`n[KIRION] llama.cpp not found. Installing official WinGet package..." -ForegroundColor Yellow
    winget install --id ggml.llamacpp -e --accept-package-agreements --accept-source-agreements
    Refresh-Path
    $server = Find-Llama
}

if (-not $server) {
    throw "llama.cpp installed but llama-server is not visible yet. Reopen PowerShell and rerun Start-Qwen-Dossier.ps1."
}

Write-Host "`n[KIRION] Forcing direct resumable GGUF download..." -ForegroundColor Magenta
Write-Host "[KIRION] Target: $ModelFile" -ForegroundColor DarkGray

$curl = Get-Command curl.exe -ErrorAction Stop
& $curl.Source -L --fail --retry 20 --retry-delay 3 --connect-timeout 30 -C - -o $ModelFile $ModelUrl
if ($LASTEXITCODE -ne 0) { throw "Qwen GGUF download failed with curl exit code $LASTEXITCODE." }

$size = (Get-Item $ModelFile).Length
if ($size -lt 1500000000) {
    throw "Downloaded GGUF is unexpectedly small ($size bytes). Refusing to launch."
}

Write-Host "[KIRION] GGUF READY: $([math]::Round($size / 1GB, 2)) GiB" -ForegroundColor Green

$llmOut = Join-Path $Logs "qwen.log"
$llmErr = Join-Path $Logs "qwen-error.log"
$svcOut = Join-Path $Logs "dossier.log"
$svcErr = Join-Path $Logs "dossier-error.log"
$processes = @()

try {
    Write-Host "`n[KIRION] Starting local Qwen from disk..." -ForegroundColor Magenta

    $args = @(
        "-m", $ModelFile,
        "--ctx-size", "4096",
        "--threads", "4",
        "--n-gpu-layers", "0",
        "--host", "127.0.0.1",
        "--port", "8080"
    )

    $llm = Start-Process -FilePath $server.Source -ArgumentList $args -RedirectStandardOutput $llmOut -RedirectStandardError $llmErr -PassThru -NoNewWindow
    $processes += $llm

    Write-Host "[KIRION] Waiting for Qwen load..." -ForegroundColor Yellow
    $ready = $false
    for ($i = 0; $i -lt 600; $i++) {
        if ($llm.HasExited) {
            if (Test-Path $llmErr) { Get-Content $llmErr -Tail 160 }
            throw "Qwen process exited before becoming ready."
        }
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2
            if ($h.status -eq "ok") { $ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw "Qwen did not become ready within 20 minutes." }

    Write-Host "[KIRION] QWEN ONLINE" -ForegroundColor Green
    Write-Host "[KIRION] Starting dossier service..." -ForegroundColor Yellow

    $python = (Get-Command python).Source
    $svc = Start-Process -FilePath $python -ArgumentList ".\server.py" -WorkingDirectory $Here -RedirectStandardOutput $svcOut -RedirectStandardError $svcErr -PassThru -NoNewWindow
    $processes += $svc
    Start-Sleep -Seconds 2
    if ($svc.HasExited) {
        if (Test-Path $svcErr) { Get-Content $svcErr -Tail 160 }
        throw "Dossier service failed to start."
    }

    Write-Host "`n============================================" -ForegroundColor Green
    Write-Host " KIRION QWEN DOSSIER ONLINE" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Green
    Write-Host " Qwen    : http://127.0.0.1:8080"
    Write-Host " Dossier : http://127.0.0.1:7361"
    Write-Host " Model   : $ModelFile"
    Write-Host " Logs    : $Logs"
    Write-Host "============================================`n"
    Start-Process "http://127.0.0.1:7361"

    while (-not $svc.HasExited -and -not $llm.HasExited) { Start-Sleep -Seconds 3 }
}
finally {
    Write-Host "`n[KIRION] Shutting down experiment..." -ForegroundColor Yellow
    foreach ($p in $processes) {
        try { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch {}
    }
}
