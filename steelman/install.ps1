#Requires -Version 5.1
<#
.SYNOPSIS
    Installs STEELMAN on this Windows machine: an isolated Ollama runtime, one
    SHA-256-verified GGUF from Hugging Face, and the local model "steelman" built
    from persona.md + Modelfile.

.DESCRIPTION
    - No administrator rights, no paid services, no cloud features.
    - Everything lives under this folder (runtime\, models\, logs\). Nothing is
      written to the user or machine environment, and any existing Ollama install
      is left untouched (STEELMAN uses its own copy on 127.0.0.1:11435).
    - Safe to re-run: verified downloads are reused, and the model is re-registered
      from the current persona.md every time.

.PARAMETER Model
    auto (default): choose from detected RAM/VRAM using the rule in model-manifest.json.
    14b or 7b: force a choice.

.PARAMETER RemoveGgufAfterImport
    After Ollama has stored a byte-identical copy of the GGUF (its blob file is named
    by the same SHA-256), delete models\gguf\<file> to save disk space. A later
    re-install will download it again.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Model 7b
#>
[CmdletBinding()]
param(
    [ValidateSet('auto', '14b', '7b')]
    [string]$Model = 'auto',
    [switch]$RemoveGgufAfterImport
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')
Assert-SteelmanPlatform
$P = Get-SteelmanPaths $PSScriptRoot
$M = Read-JsonFile $P.Manifest
$base = Get-SteelmanBaseUrl $M
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on 5.1

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host ('== ' + $Text) -ForegroundColor Cyan
}

function Invoke-Download([string]$Url, [string]$OutFile) {
    $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($curl) {
        # curl.exe ships with Windows 10 1803+ and can resume an interrupted download.
        & $curl.Path --location --fail --retry 5 --retry-delay 3 --continue-at - --output $OutFile $Url
        if ($LASTEXITCODE -ne 0) {
            throw ('curl.exe exited with code {0} while downloading {1}' -f $LASTEXITCODE, $Url)
        }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    }
}

function Get-GpuInventory {
    $list = New-Object System.Collections.Generic.List[object]
    $smi = Get-Command nvidia-smi.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($smi) {
        try {
            # Quoted: an unquoted a,b argument would become a PowerShell array.
            foreach ($line in @(& $smi.Path '--query-gpu=name,memory.total' '--format=csv,noheader,nounits')) {
                $parts = ([string]$line).Split(',')
                if ($parts.Count -ge 2) {
                    $list.Add([pscustomobject]@{
                        Name    = $parts[0].Trim()
                        VramGiB = [math]::Round(([double]$parts[1].Trim()) / 1024, 1)
                        Source  = 'nvidia-smi'
                    })
                }
            }
        } catch {
            Write-Verbose ('nvidia-smi query failed: ' + $_)
        }
    }
    # Win32_VideoController.AdapterRAM is capped at 4 GiB, so read the 64-bit value
    # the display driver records under its device-class registry key.
    $classKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    foreach ($k in @(Get-ChildItem -Path $classKey -ErrorAction SilentlyContinue)) {
        if ($k.PSChildName -notmatch '^\d{4}$') { continue }
        try {
            $props = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
            if (-not $props) { continue }
            $names = @($props.PSObject.Properties | ForEach-Object { $_.Name })
            if ($names -notcontains 'DriverDesc') { continue }
            $name = [string]$props.DriverDesc
            $already = @($list | Where-Object { $_.Name -eq $name })
            if ($already.Count -gt 0) { continue }
            $bytes = [double]0
            if ($names -contains 'HardwareInformation.qwMemorySize') {
                $bytes = [double]$props.'HardwareInformation.qwMemorySize'
            } elseif ($names -contains 'HardwareInformation.MemorySize') {
                $raw = $props.'HardwareInformation.MemorySize'
                if ($raw -is [byte[]]) {
                    $bytes = [double][System.BitConverter]::ToUInt32($raw, 0)
                } else {
                    $bytes = [double][System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int]$raw), 0)
                }
            }
            $list.Add([pscustomobject]@{ Name = $name; VramGiB = [math]::Round($bytes / 1GB, 1); Source = 'registry' })
        } catch {
            Write-Verbose ('Skipping display adapter key {0}: {1}' -f $k.PSChildName, $_)
        }
    }
    return ,$list.ToArray()
}

# Only discrete GPUs with real dedicated memory count toward the 14B budget.
function Test-CountedGpu($Gpu) {
    if ($Gpu.VramGiB -lt 4) { return $false }
    if ($Gpu.Name -match 'NVIDIA') { return $true }
    if ($Gpu.Name -match 'Radeon.*\b(RX|PRO|VII)\b') { return $true }
    return $false
}

# ---------------------------------------------------------------------------
Write-Step 'Hardware'
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$cs = Get-CimInstance -ClassName Win32_ComputerSystem
$cpus = @(Get-CimInstance -ClassName Win32_Processor)
$ramGiB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
$cores = ($cpus | Measure-Object -Property NumberOfCores -Sum).Sum
$threads = ($cpus | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
$drive = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($P.Root))
$freeGiB = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)
$gpus = Get-GpuInventory
$counted = @($gpus | Where-Object { Test-CountedGpu $_ })
$bestVram = [double]0
if ($counted.Count -gt 0) { $bestVram = [double]($counted | Measure-Object -Property VramGiB -Maximum).Maximum }

Write-Host ('OS     : {0} {1} ({2})' -f $os.Caption, $os.Version, $arch)
Write-Host ('CPU    : {0} - {1} cores / {2} threads' -f $cpus[0].Name.Trim(), $cores, $threads)
Write-Host ('RAM    : {0} GiB' -f $ramGiB)
if ($gpus.Count -eq 0) { Write-Host 'GPU    : none detected' }
foreach ($g in $gpus) {
    $tag = 'not counted'
    if (Test-CountedGpu $g) { $tag = 'counted' }
    Write-Host ('GPU    : {0} - {1} GiB ({2}, {3})' -f $g.Name, $g.VramGiB, $g.Source, $tag)
}
Write-Host ('Disk   : {0} GiB free on {1}' -f $freeGiB, $drive.Name)

$existingOllama = Get-Command ollama.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingOllama) {
    Write-Host ('Note   : an existing Ollama is installed at {0}. It is left untouched; STEELMAN runs its own copy on port {1}.' -f $existingOllama.Path, $M.runtime.port)
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Warning 'Running elevated is not needed. STEELMAN installs entirely under this folder.'
}

switch ($arch) {
    'AMD64' { $artifact = $M.runtime.windows_artifact }
    'ARM64' { $artifact = $M.runtime.windows_artifact -replace 'amd64', 'arm64' }
    default { throw ('Unsupported processor architecture {0}. Ollama ships Windows builds for AMD64 and ARM64.' -f $arch) }
}

New-Item -ItemType Directory -Force -Path $P.RuntimeDir | Out-Null
$hw = [ordered]@{
    detected_utc   = (Get-Date).ToUniversalTime().ToString('o')
    os             = ('{0} {1}' -f $os.Caption, $os.Version)
    architecture   = $arch
    cpu            = $cpus[0].Name.Trim()
    cores          = $cores
    threads        = $threads
    ram_gib        = $ramGiB
    gpus           = @($gpus)
    counted_vram_gib = $bestVram
    disk_free_gib  = $freeGiB
    existing_ollama = $(if ($existingOllama) { $existingOllama.Path } else { $null })
}
Write-JsonFile $P.Hardware $hw

# ---------------------------------------------------------------------------
Write-Step 'Model selection'
$sel = $M.selection
$budget = [math]::Round($bestVram + [math]::Max(0, $ramGiB - $sel.reserved_ram_gib), 1)
if ($Model -eq 'auto') {
    if ($ramGiB -ge $sel.min_ram_gib_14b -and $budget -ge $sel.min_budget_gib_14b) {
        $key = '14b'
        $reason = ('auto: {0} GiB RAM, {1} GiB counted VRAM, budget {2} GiB >= {3}' -f $ramGiB, $bestVram, $budget, $sel.min_budget_gib_14b)
    } elseif ($ramGiB -ge $sel.min_ram_gib_7b) {
        $key = '7b'
        $reason = ('auto: budget {0} GiB < {1} GiB needed for 14B; {2} GiB RAM is enough for 7B' -f $budget, $sel.min_budget_gib_14b, $ramGiB)
    } else {
        throw ('{0} GiB RAM is below the {1} GiB minimum for the 7B model.' -f $ramGiB, $sel.min_ram_gib_7b)
    }
} else {
    $key = $Model
    $reason = ('forced with -Model {0} (budget {1} GiB)' -f $Model, $budget)
}
$entry = $M.models.$key
Write-Host ('Selected: {0} {1}' -f $entry.label, $entry.quantization)
Write-Host ('Reason  : {0}' -f $reason)
if ($key -eq '14b' -and $bestVram -lt 11) {
    Write-Host 'Expect CPU or partial-GPU speed with the 14B model. Use -Model 7b if answers are too slow.' -ForegroundColor Yellow
}
foreach ($note in @($entry.provenance_notes)) { Write-Host ('Provenance: ' + $note) -ForegroundColor DarkGray }

$ggufPath = Join-Path $P.GgufDir $entry.file
$blobPath = Join-Path $P.OllamaModels ('blobs\sha256-' + $entry.sha256)
$need = [double]1GB
if (-not (Test-Path -LiteralPath $P.OllamaExe)) { $need += 4GB }
if (-not (Test-Path -LiteralPath $blobPath)) { $need += [double]$entry.size_bytes }
if (Test-Path -LiteralPath $ggufPath) {
    $need += [math]::Max(0, [double]$entry.size_bytes - (Get-Item -LiteralPath $ggufPath).Length)
} else {
    $need += [double]$entry.size_bytes
}
if ($drive.AvailableFreeSpace -lt $need) {
    throw ('Not enough disk space: need about {0:N1} GiB on {1}, {2} GiB free.' -f ($need / 1GB), $drive.Name, $freeGiB)
}

# ---------------------------------------------------------------------------
Write-Step ('Runtime: Ollama {0} ({1})' -f $M.runtime.version, $artifact)
$versionStamp = Join-Path $P.OllamaDir 'STEELMAN_RUNTIME.txt'
$runtimeSha = $null
$haveRuntime = $false
if ((Test-Path -LiteralPath $P.OllamaExe) -and (Test-Path -LiteralPath $versionStamp)) {
    $stamp = @(Get-Content -LiteralPath $versionStamp)
    if ($stamp.Count -ge 2 -and $stamp[0].Trim() -eq ($M.runtime.version + ' ' + $artifact)) {
        $haveRuntime = $true
        $runtimeSha = $stamp[1].Trim()
    }
}
if ($haveRuntime) {
    Write-Host ('Already installed (zip SHA-256 {0}).' -f $runtimeSha)
} else {
    if ((Get-SteelmanProcesses $P).Count -gt 0) {
        throw 'STEELMAN runtime processes are running. Run stop.ps1, then re-run install.ps1.'
    }
    New-Item -ItemType Directory -Force -Path $P.DownloadsDir | Out-Null
    $sums = Join-Path $P.DownloadsDir ('sha256sum-' + $M.runtime.version + '.txt')
    if (Test-Path -LiteralPath $sums) { Remove-Item -LiteralPath $sums -Force }
    Invoke-Download ($M.runtime.download_base + $M.runtime.checksum_file) $sums

    $expected = $null
    if ($M.runtime.artifact_sha256 -and $artifact -eq $M.runtime.windows_artifact) {
        $expected = ([string]$M.runtime.artifact_sha256).ToLowerInvariant()
        Write-Host 'Using the runtime hash pinned in model-manifest.json.'
    } else {
        $pattern = '(^|[\s*/])' + [regex]::Escape($artifact) + '\s*$'
        $line = @(Get-Content -LiteralPath $sums | Where-Object { $_ -match $pattern }) | Select-Object -First 1
        if (-not $line) { throw ('{0} has no entry for {1}.' -f $M.runtime.checksum_file, $artifact) }
        $expected = (($line.Trim() -split '\s+')[0]).ToLowerInvariant()
        Write-Host ('Expected SHA-256 from the release checksum file: {0}' -f $expected)
    }

    $zip = Join-Path $P.DownloadsDir $artifact
    if ((Test-Path -LiteralPath $zip) -and ((Get-FileSha256 $zip) -ne $expected)) {
        # Leftover from an interrupted run; start the runtime download fresh.
        Remove-Item -LiteralPath $zip -Force
    }
    if (-not (Test-Path -LiteralPath $zip)) {
        Invoke-Download ($M.runtime.download_base + $artifact) $zip
    }
    $runtimeSha = Get-FileSha256 $zip
    if ($runtimeSha -ne $expected) {
        Remove-Item -LiteralPath $zip -Force
        throw ('Runtime SHA-256 mismatch: got {0}, expected {1}. The download was deleted; re-run install.ps1.' -f $runtimeSha, $expected)
    }
    Write-Host ('Runtime SHA-256 verified: {0}' -f $runtimeSha)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $staging = $P.OllamaDir + '.partial'
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $staging)
    if (-not (Test-Path -LiteralPath (Join-Path $staging 'ollama.exe'))) {
        throw ('ollama.exe not found at the top of {0}; the archive layout changed.' -f $artifact)
    }
    if (Test-Path -LiteralPath $P.OllamaDir) { Remove-Item -LiteralPath $P.OllamaDir -Recurse -Force }
    Move-Item -LiteralPath $staging -Destination $P.OllamaDir
    Set-Content -LiteralPath $versionStamp -Encoding ASCII -Value @(($M.runtime.version + ' ' + $artifact), $runtimeSha)
    Remove-Item -LiteralPath $zip -Force
    Write-Host ('Installed to {0}' -f $P.OllamaDir)
}

# ---------------------------------------------------------------------------
Write-Step ('Model weights: {0}' -f $entry.file)
New-Item -ItemType Directory -Force -Path $P.GgufDir | Out-Null
$verified = $false
if (Test-Path -LiteralPath $blobPath) {
    Write-Host 'Ollama already stores a blob with this SHA-256.'
}
if (Test-Path -LiteralPath $ggufPath) {
    $len = (Get-Item -LiteralPath $ggufPath).Length
    if ($len -eq [long]$entry.size_bytes) {
        Write-Host 'File present; verifying SHA-256 (about a minute for large files)...'
        if ((Get-FileSha256 $ggufPath) -eq $entry.sha256) {
            $verified = $true
        } else {
            Write-Warning 'Existing file failed SHA-256 verification; downloading it again.'
            Remove-Item -LiteralPath $ggufPath -Force
        }
    } elseif ($len -gt [long]$entry.size_bytes) {
        Remove-Item -LiteralPath $ggufPath -Force
    } else {
        Write-Host ('Resuming a partial download ({0:N1} of {1:N1} GiB).' -f ($len / 1GB), ([double]$entry.size_bytes / 1GB))
    }
}
if (-not $verified) {
    Write-Host ('Downloading {0:N1} GiB from {1}' -f ([double]$entry.size_bytes / 1GB), $entry.url)
    Invoke-Download $entry.url $ggufPath
    $len = (Get-Item -LiteralPath $ggufPath).Length
    if ($len -ne [long]$entry.size_bytes) {
        throw ('Downloaded size {0} does not match the expected {1} bytes. Re-run install.ps1 to resume.' -f $len, $entry.size_bytes)
    }
    $actual = Get-FileSha256 $ggufPath
    if ($actual -ne $entry.sha256) {
        Remove-Item -LiteralPath $ggufPath -Force
        throw ('SHA-256 mismatch: got {0}, expected {1}. The file was deleted.' -f $actual, $entry.sha256)
    }
}
Write-Host ('SHA-256 verified: {0}' -f $entry.sha256)

# ---------------------------------------------------------------------------
Write-Step 'Modelfile'
$prompt = Get-SteelmanSystemPrompt $P.Persona
$template = [System.IO.File]::ReadAllText($P.ModelfileTemplate, [System.Text.Encoding]::UTF8)
foreach ($token in @('@@GGUF_PATH@@', '@@SYSTEM_PROMPT@@')) {
    $count = [regex]::Matches($template, [regex]::Escape($token)).Count
    if ($count -ne 1) { throw ('Modelfile must contain {0} exactly once (found {1}).' -f $token, $count) }
}
$rendered = $template.Replace('@@GGUF_PATH@@', ('../models/gguf/' + $entry.file)).Replace('@@SYSTEM_PROMPT@@', $prompt)
$rendered = $rendered -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($P.Rendered, $rendered, (New-Object System.Text.UTF8Encoding($false)))
$promptSha = Get-StringSha256 $prompt
Write-Host ('Rendered {0} (system prompt SHA-256 {1})' -f $P.Rendered, $promptSha)

# ---------------------------------------------------------------------------
Write-Step ('Register model "{0}"' -f $M.model_name)
$serverVersion = Start-SteelmanServer $P $M
Write-Host ('Isolated Ollama {0} answering at {1}' -f $serverVersion, $base)
if ($serverVersion -ne $M.runtime.version.TrimStart('v')) {
    Write-Warning ('Server reports version {0}; the manifest pins {1}.' -f $serverVersion, $M.runtime.version)
}
Set-SteelmanEnvironment $P $M
& $P.OllamaExe create $M.model_name -f $P.Rendered
if ($LASTEXITCODE -ne 0) { throw ('ollama create failed with exit code {0}. See {1}.' -f $LASTEXITCODE, (Join-Path $P.LogsDir 'server.log')) }

if (-not (Test-Path -LiteralPath $blobPath)) {
    throw ('Expected blob {0} is missing: Ollama did not store a byte-identical copy of the verified GGUF.' -f $blobPath)
}
Write-Host ('Ollama blob matches the verified SHA-256: {0}' -f $blobPath)
$show = Test-SteelmanModelRegistered $M
if (-not $show) { throw 'The model was created but /api/show does not return it.' }
Write-Host ('Registered: family={0} parameters={1} quantization={2}' -f $show.details.family, $show.details.parameter_size, $show.details.quantization_level)
if ($show.details.quantization_level -ne $entry.quantization) {
    Write-Warning ('Ollama reports quantization {0}; expected {1}.' -f $show.details.quantization_level, $entry.quantization)
}
$showNames = @($show.PSObject.Properties | ForEach-Object { $_.Name })
if ($showNames -contains 'system') {
    if ((([string]$show.system) -replace "`r`n", "`n").Trim() -ne $prompt) {
        Write-Warning 'The registered system prompt differs from persona.md.'
    } else {
        Write-Host 'Registered system prompt matches persona.md.'
    }
}

if ($RemoveGgufAfterImport) {
    Remove-Item -LiteralPath $ggufPath -Force
    Write-Host ('Removed {0}; the byte-identical blob remains in models\ollama.' -f $ggufPath)
}

$installed = [ordered]@{
    installed_utc        = (Get-Date).ToUniversalTime().ToString('o')
    model_name           = $M.model_name
    model_key            = $key
    selection_reason     = $reason
    hf_repo              = $entry.hf_repo
    revision             = $entry.revision
    file                 = $entry.file
    size_bytes           = $entry.size_bytes
    sha256               = $entry.sha256
    quantization         = $entry.quantization
    ollama_blob          = $blobPath
    gguf_kept            = (-not $RemoveGgufAfterImport)
    system_prompt_sha256 = $promptSha
    runtime              = [ordered]@{
        name            = 'ollama'
        version         = $M.runtime.version
        server_reported = $serverVersion
        artifact        = $artifact
        artifact_sha256 = $runtimeSha
        api             = $base
    }
}
Write-JsonFile $P.Installed $installed

Write-Step 'Done'
Write-Host ('STEELMAN is registered. The server is running on {0} (localhost only).' -f $base)
Write-Host 'Next:'
Write-Host '  .\test.ps1     live inference test with the reference prompt'
Write-Host '  .\launch.ps1   terminal chat'
Write-Host '  .\status.ps1   health, loaded model, GPU share'
Write-Host '  .\stop.ps1     shut the server down'
