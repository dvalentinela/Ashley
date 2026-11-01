#Requires -Version 5.1
<#
.SYNOPSIS
    Starts the isolated STEELMAN server on 127.0.0.1 and opens a terminal chat.

.DESCRIPTION
    The server keeps running after you leave the chat (type /bye), so the local API
    stays available for Catherine or scripts. Shut it down with stop.ps1.

    Chat tips: /bye leaves, /clear forgets the conversation, and three double quotes
    start and end a multi-line message. Readline history is disabled
    (OLLAMA_NOHISTORY=1), so conversations are not saved to disk by this chat.

.PARAMETER ServerOnly
    Start (or confirm) the server and return without opening the chat.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1 -ServerOnly
#>
[CmdletBinding()]
param(
    [switch]$ServerOnly
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')
Assert-SteelmanPlatform
$P = Get-SteelmanPaths $PSScriptRoot
$M = Read-JsonFile $P.Manifest
$base = Get-SteelmanBaseUrl $M

$version = Start-SteelmanServer $P $M
Write-Host ('STEELMAN server: Ollama {0} at {1} (localhost only)' -f $version, $base)
Write-Host ('  Native API : {0}/api/chat' -f $base)
Write-Host ('  OpenAI API : {0}/v1/chat/completions' -f $base)

$show = Test-SteelmanModelRegistered $M
if (-not $show) {
    throw ('Model "{0}" is not registered. Run install.ps1 first.' -f $M.model_name)
}
if ($ServerOnly) { return }

Write-Host ''
Write-Host ('STEELMAN ({0}, {1}). /bye to leave; the server keeps running until stop.ps1.' -f $show.details.parameter_size, $show.details.quantization_level) -ForegroundColor Cyan
Set-SteelmanEnvironment $P $M
& $P.OllamaExe run $M.model_name
