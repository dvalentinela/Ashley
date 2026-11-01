#Requires -Version 5.1
<#
.SYNOPSIS
    Stops the STEELMAN server and its model runner processes.

.DESCRIPTION
    Only processes whose executable lives under this folder's runtime\ollama\ are
    stopped. Any other Ollama install on this machine is not touched.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'lib\common.ps1')
Assert-SteelmanPlatform
$P = Get-SteelmanPaths $PSScriptRoot
$M = Read-JsonFile $P.Manifest
$base = Get-SteelmanBaseUrl $M

$procs = Get-SteelmanProcesses $P
if ($procs.Count -eq 0) {
    Write-Host 'STEELMAN is not running.'
} else {
    foreach ($proc in $procs) {
        Write-Host ('Stopping PID {0} ({1})' -f $proc.ProcessId, $proc.CommandLine)
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-SteelmanProcesses $P).Count -gt 0 -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
    }
    $left = Get-SteelmanProcesses $P
    if ($left.Count -gt 0) {
        throw ('{0} STEELMAN process(es) are still running: {1}' -f $left.Count, (($left | ForEach-Object { $_.ProcessId }) -join ', '))
    }
    Write-Host 'STEELMAN stopped.'
}

if (Test-Path -LiteralPath $P.PidFile) { Remove-Item -LiteralPath $P.PidFile -Force }

$still = Get-SteelmanServerVersion $base
if ($still) {
    Write-Warning ('{0} still answers (Ollama {1}). That is another program on the same port, not STEELMAN.' -f $base, $still)
}
