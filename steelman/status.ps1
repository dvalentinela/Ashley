#Requires -Version 5.1
<#
.SYNOPSIS
    Shows what is installed, whether the STEELMAN server is up, what it is bound to,
    and how much of the loaded model sits on the GPU.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\status.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'lib\common.ps1')
Assert-SteelmanPlatform
$P = Get-SteelmanPaths $PSScriptRoot
$M = Read-JsonFile $P.Manifest
$base = Get-SteelmanBaseUrl $M
$ok = $true

Write-Host '== Installation' -ForegroundColor Cyan
if (Test-Path -LiteralPath $P.Installed) {
    $inst = Read-JsonFile $P.Installed
    Write-Host ('Model     : {0} ({1}) from {2}@{3}' -f $inst.file, $inst.quantization, $inst.hf_repo, $inst.revision.Substring(0, 12))
    Write-Host ('SHA-256   : {0}' -f $inst.sha256)
    Write-Host ('Selected  : {0}' -f $inst.selection_reason)
    Write-Host ('Runtime   : Ollama {0} ({1}, zip SHA-256 {2})' -f $inst.runtime.version, $inst.runtime.artifact, $inst.runtime.artifact_sha256)
    Write-Host ('Installed : {0}' -f $inst.installed_utc)
    if (Test-Path -LiteralPath $inst.ollama_blob) {
        Write-Host 'Blob      : present (file name = verified SHA-256)'
    } else {
        Write-Host ('Blob      : MISSING {0}' -f $inst.ollama_blob) -ForegroundColor Red
        $ok = $false
    }
    $promptSha = Get-StringSha256 (Get-SteelmanSystemPrompt $P.Persona)
    if ($promptSha -ne $inst.system_prompt_sha256) {
        Write-Host 'Persona   : persona.md changed since install; re-run install.ps1 to apply it.' -ForegroundColor Yellow
    } else {
        Write-Host 'Persona   : registered prompt matches persona.md'
    }
} else {
    Write-Host 'Not installed. Run install.ps1.' -ForegroundColor Yellow
    $ok = $false
}

Write-Host ''
Write-Host '== Server' -ForegroundColor Cyan
$version = Get-SteelmanServerVersion $base
$procs = Get-SteelmanProcesses $P
if ($version -and $procs.Count -gt 0) {
    Write-Host ('Running   : Ollama {0} at {1}' -f $version, $base)
    foreach ($proc in $procs) {
        $ws = 0
        try { $ws = [math]::Round((Get-Process -Id $proc.ProcessId).WorkingSet64 / 1GB, 2) } catch { }
        Write-Host ('Process   : PID {0}, {1} GiB working set: {2}' -f $proc.ProcessId, $ws, $proc.CommandLine)
    }
    $addrs = Get-ListeningAddresses ([int]$M.runtime.port)
    if ($addrs.Count -gt 0) {
        $exposed = @($addrs | Where-Object { $_ -ne '127.0.0.1' -and $_ -ne '::1' })
        if ($exposed.Count -gt 0) {
            Write-Host ('Binding   : EXPOSED on {0}' -f ($addrs -join ', ')) -ForegroundColor Red
            $ok = $false
        } else {
            Write-Host ('Binding   : {0} (loopback only)' -f ($addrs -join ', '))
        }
    }
    try {
        $ps = Invoke-RestMethod -Uri ($base + '/api/ps') -TimeoutSec 5 -UseBasicParsing
        $loaded = @($ps.models)
        if ($loaded.Count -eq 0) {
            Write-Host 'Loaded    : nothing (the model loads on first request and unloads after 30 minutes idle)'
        }
        foreach ($lm in $loaded) {   # not $m: PowerShell names are case-insensitive and $M is the manifest
            $gpuPct = 0
            if ($lm.size -gt 0) { $gpuPct = [math]::Round(100 * $lm.size_vram / $lm.size) }
            Write-Host ('Loaded    : {0}, {1:N1} GiB, {2}% on GPU, expires {3}' -f $lm.name, ($lm.size / 1GB), $gpuPct, $lm.expires_at)
        }
    } catch {
        Write-Host ('Loaded    : /api/ps failed: {0}' -f $_) -ForegroundColor Yellow
    }
} elseif ($version) {
    Write-Host ('{0} answers (Ollama {1}) but no process from runtime\ollama is running: another program owns the port.' -f $base, $version) -ForegroundColor Red
    $ok = $false
} else {
    Write-Host 'Stopped. Start with launch.ps1 (or launch.ps1 -ServerOnly).'
}

Write-Host ''
if ($ok) { Write-Host 'Status: OK' -ForegroundColor Green } else { Write-Host 'Status: needs attention' -ForegroundColor Yellow }
