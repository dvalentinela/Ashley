# Shared helpers for the STEELMAN scripts. Dot-source only:
#   . (Join-Path $PSScriptRoot 'lib\common.ps1')
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Assert-SteelmanPlatform {
    if ($env:OS -ne 'Windows_NT') {
        throw 'STEELMAN scripts target Windows. On Linux/macOS use tools/verify_gguf.py to test a GGUF directly.'
    }
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or newer is required (found $($PSVersionTable.PSVersion))."
    }
}

function Get-SteelmanPaths([string]$Root) {
    $root = [System.IO.Path]::GetFullPath($Root)
    return [pscustomobject]@{
        Root              = $root
        Manifest          = Join-Path $root 'model-manifest.json'
        Persona           = Join-Path $root 'persona.md'
        ModelfileTemplate = Join-Path $root 'Modelfile'
        ReferenceTest     = Join-Path $root 'tests\reference-test.json'
        ResultsDir        = Join-Path $root 'tests\results'
        RuntimeDir        = Join-Path $root 'runtime'
        DownloadsDir      = Join-Path $root 'runtime\downloads'
        OllamaDir         = Join-Path $root 'runtime\ollama'
        OllamaExe         = Join-Path $root 'runtime\ollama\ollama.exe'
        Rendered          = Join-Path $root 'runtime\Modelfile.rendered'
        Installed         = Join-Path $root 'runtime\installed.json'
        Hardware          = Join-Path $root 'runtime\hardware.json'
        PidFile           = Join-Path $root 'runtime\server.pid'
        GgufDir           = Join-Path $root 'models\gguf'
        OllamaModels      = Join-Path $root 'models\ollama'
        LogsDir           = Join-Path $root 'logs'
    }
}

function Read-JsonFile([string]$Path) {
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    return ($text | ConvertFrom-Json)
}

function Write-JsonFile([string]$Path, $Object) {
    $json = $Object | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-SteelmanBaseUrl($Manifest) {
    return ('http://{0}:{1}' -f $Manifest.runtime.host, $Manifest.runtime.port)
}

function Get-StringSha256([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return (-join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }))
    } finally {
        $sha.Dispose()
    }
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# Extracts the system prompt between the STEELMAN-SYSTEM-PROMPT markers in persona.md.
function Get-SteelmanSystemPrompt([string]$PersonaPath) {
    $text = [System.IO.File]::ReadAllText($PersonaPath, [System.Text.Encoding]::UTF8)
    $pattern = '(?s)<!-- STEELMAN-SYSTEM-PROMPT:BEGIN -->\s*```text\r?\n(.*?)\r?\n```\s*<!-- STEELMAN-SYSTEM-PROMPT:END -->'
    $m = [regex]::Match($text, $pattern)
    if (-not $m.Success) {
        throw 'persona.md: system prompt block not found between the STEELMAN-SYSTEM-PROMPT markers.'
    }
    $prompt = ($m.Groups[1].Value -replace "`r`n", "`n").Trim()
    if ($prompt.Contains('"""')) {
        throw 'persona.md: the system prompt contains three double quotes in a row, which would end the Modelfile SYSTEM block early.'
    }
    return $prompt
}

# Process-scoped environment for the isolated runtime. Nothing is written to the
# user or machine environment, so any other Ollama install is unaffected.
function Set-SteelmanEnvironment($Paths, $Manifest) {
    $env:OLLAMA_HOST = ('{0}:{1}' -f $Manifest.runtime.host, $Manifest.runtime.port)
    $env:OLLAMA_MODELS = $Paths.OllamaModels
    foreach ($p in $Manifest.runtime.environment.PSObject.Properties) {
        Set-Item -Path ('Env:' + $p.Name) -Value ([string]$p.Value)
    }
}

function Get-SteelmanServerVersion([string]$BaseUrl) {
    try {
        $r = Invoke-RestMethod -Uri ($BaseUrl + '/api/version') -TimeoutSec 3 -UseBasicParsing
        return [string]$r.version
    } catch {
        return $null
    }
}

function Wait-SteelmanServer([string]$BaseUrl, [int]$TimeoutSec = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $v = Get-SteelmanServerVersion $BaseUrl
        if ($v) { return $v }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

# Every process whose executable lives under runtime\ollama\ belongs to STEELMAN
# (the server and the runner processes it spawns). Nothing else is touched.
function Get-SteelmanProcesses($Paths) {
    $prefix = $Paths.OllamaDir.TrimEnd('\') + '\'
    $procs = @(Get-CimInstance -ClassName Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
    })
    return ,$procs
}

function Start-SteelmanServer($Paths, $Manifest) {
    $base = Get-SteelmanBaseUrl $Manifest
    $existing = Get-SteelmanServerVersion $base
    if ($existing) {
        $ours = Get-SteelmanProcesses $Paths
        if ($ours.Count -eq 0) {
            throw ("{0} is already answering (Ollama {1}) but not from STEELMAN's runtime. Stop that server, or change runtime.port in model-manifest.json." -f $base, $existing)
        }
        return $existing
    }
    if (-not (Test-Path -LiteralPath $Paths.OllamaExe)) {
        throw ("Runtime not installed ({0} is missing). Run install.ps1 first." -f $Paths.OllamaExe)
    }
    New-Item -ItemType Directory -Force -Path $Paths.LogsDir, $Paths.OllamaModels | Out-Null
    Set-SteelmanEnvironment $Paths $Manifest
    $log = Join-Path $Paths.LogsDir 'server.log'
    # cmd.exe /s /c keeps the server detached in a hidden window and appends its
    # output to logs\server.log. The environment set above is inherited.
    $cmdLine = '/d /s /c ""{0}" serve >> "{1}" 2>&1"' -f $Paths.OllamaExe, $log
    $wrapper = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdLine -WorkingDirectory $Paths.OllamaDir -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath $Paths.PidFile -Value $wrapper.Id -Encoding ASCII
    $v = Wait-SteelmanServer $base 90
    if (-not $v) {
        throw ("The STEELMAN server did not answer on {0} within 90 seconds. See {1}." -f $base, $log)
    }
    return $v
}

function Test-SteelmanModelRegistered($Manifest) {
    $base = Get-SteelmanBaseUrl $Manifest
    $body = @{ model = $Manifest.model_name } | ConvertTo-Json
    try {
        return (Invoke-RestMethod -Method Post -Uri ($base + '/api/show') -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 30 -UseBasicParsing)
    } catch {
        return $null
    }
}

function Get-ListeningAddresses([int]$Port) {
    try {
        return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -ExpandProperty LocalAddress -Unique)
    } catch {
        return @()
    }
}
