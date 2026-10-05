$ErrorActionPreference = "Stop"

$Here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Model = "bartowski/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M"
$Logs  = Join-Path $Here ".runtime\logs"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Find-Llama {
    $server = Get-Command llama-server.exe -ErrorAction SilentlyContinue
    if (-not $server) { $server = Get-Command llama-server -ErrorAction SilentlyContinue }
    $cli = Get-Command llama.exe -ErrorAction SilentlyContinue
    if (-not $cli) { $cli = Get-Command llama -ErrorAction SilentlyContinue }

    $links = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    if (-not $server -and (Test-Path (Join-Path $links "llama-server.exe"))) { $server = Get-Item (Join-Path $links "llama-server.exe") }
    if (-not $cli -and (Test-Path (Join-Path $links "llama.exe"))) { $cli = Get-Item (Join-Path $links "llama.exe") }
    return @{ Server = $server; Cli = $cli }
}

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host " KIRION QWEN DOSSIER EXPERIMENT" -ForegroundColor Cyan
Write-Host "============================================`n" -ForegroundColor Cyan

Set-Location $Here
python .\selftest.py

$found = Find-Llama
if (-not $found.Server -and -not $found.Cli) {
    Write-Host "`n[KIRION] llama.cpp not found. Installing official WinGet package..." -ForegroundColor Yellow
    winget install --id ggml.llamacpp -e --accept-package-agreements --accept-source-agreements
    Refresh-Path
    $found = Find-Llama
}

if (-not $found.Server -and -not $found.Cli) {
    throw "llama.cpp installed but executable is not visible yet. Reopen PowerShell and rerun Start-Qwen-Dossier.ps1."
}

$llmOut = Join-Path $Logs "qwen.log"
$llmErr = Join-Path $Logs "qwen-error.log"
$svcOut = Join-Path $Logs "dossier.log"
$svcErr = Join-Path $Logs "dossier-error.log"
$processes = @()

try {
    Write-Host "`n[KIRION] Starting Qwen. First run may download the GGUF; slow internet is okay, leave this terminal open." -ForegroundColor Magenta

    $args = @(
        "-hf", $Model,
        "--ctx-size", "4096",
        "--threads", "4",
        "--n-gpu-layers", "0",
        "--host", "127.0.0.1",
        "--port", "8080"
    )

    if ($found.Server) {
        $llm = Start-Process -FilePath $found.Server.Source -ArgumentList $args -RedirectStandardOutput $llmOut -RedirectStandardError $llmErr -PassThru -NoNewWindow
    } else {
        $llm = Start-Process -FilePath $found.Cli.Source -ArgumentList (@("serve") + $args) -RedirectStandardOutput $llmOut -RedirectStandardError $llmErr -PassThru -NoNewWindow
    }
    $processes += $llm

    Write-Host "[KIRION] Waiting for Qwen download/load..." -ForegroundColor Yellow
    $ready = $false
    for ($i = 0; $i -lt 900; $i++) {
        if ($llm.HasExited) {
            if (Test-Path $llmErr) { Get-Content $llmErr -Tail 120 }
            throw "Qwen process exited before becoming ready."
        }
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 2
            if ($h.status -eq "ok") { $ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw "Qwen did not become ready within 30 minutes." }

    Write-Host "[KIRION] QWEN ONLINE" -ForegroundColor Green
    Write-Host "[KIRION] Starting dossier service..." -ForegroundColor Yellow

    $python = (Get-Command python).Source
    $svc = Start-Process -FilePath $python -ArgumentList ".\server.py" -WorkingDirectory $Here -RedirectStandardOutput $svcOut -RedirectStandardError $svcErr -PassThru -NoNewWindow
    $processes += $svc
    Start-Sleep -Seconds 2
    if ($svc.HasExited) {
        if (Test-Path $svcErr) { Get-Content $svcErr -Tail 120 }
        throw "Dossier service failed to start."
    }

    Write-Host "`n============================================" -ForegroundColor Green
    Write-Host " KIRION QWEN DOSSIER ONLINE" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Green
    Write-Host " Qwen    : http://127.0.0.1:8080"
    Write-Host " Dossier : http://127.0.0.1:7361"
    Write-Host " Model   : $Model"
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
