#Requires -Version 5.1
<#
.SYNOPSIS
    Live inference test. Sends the reference prompt to the running "steelman" model
    over the localhost API, applies the automated checks from
    tests\reference-test.json, and saves the full response under tests\results\.

.DESCRIPTION
    The automated checks are a floor (no refusal, three moves, an assumption
    challenged, influence vs control, no flattery, no claimed actions, enough
    substance). Originality, strategic quality and independence still need a human
    read; the rubric is printed at the end. tests\results\ is git-ignored.

.PARAMETER Prompt
    Send your own prompt instead of the reference prompt (the checks still run).

.PARAMETER TimeoutSec
    How long to wait for the answer. The first request also loads the model.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\test.ps1
#>
[CmdletBinding()]
param(
    [string]$Prompt,
    [int]$TimeoutSec = 1800
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')
Assert-SteelmanPlatform
$P = Get-SteelmanPaths $PSScriptRoot
$M = Read-JsonFile $P.Manifest
$base = Get-SteelmanBaseUrl $M
$ref = Read-JsonFile $P.ReferenceTest
if (-not $Prompt) { $Prompt = [string]$ref.prompt }

function Test-Check($Check, [string]$Text) {
    switch ([string]$Check.type) {
        'absent' { return (-not [regex]::IsMatch($Text, $Check.pattern)) }
        'present' { return [regex]::IsMatch($Text, $Check.pattern) }
        'all_present' {
            foreach ($pat in @($Check.patterns)) {
                if (-not [regex]::IsMatch($Text, $pat)) { return $false }
            }
            return $true
        }
        'count_at_least' { return ([regex]::Matches($Text, $Check.pattern).Count -ge [int]$Check.min) }
        'absent_in_head' {
            $head = $Text.Substring(0, [math]::Min([int]$Check.head_chars, $Text.Length))
            return (-not [regex]::IsMatch($head, $Check.pattern))
        }
        'min_words' { return (@($Text -split '\s+' | Where-Object { $_ -ne '' }).Count -ge [int]$Check.min) }
        default { throw ('Unknown check type ' + $Check.type) }
    }
}

Write-Host '== Server' -ForegroundColor Cyan
$version = Start-SteelmanServer $P $M
$show = Test-SteelmanModelRegistered $M
if (-not $show) { throw ('Model "{0}" is not registered. Run install.ps1 first.' -f $M.model_name) }
Write-Host ('Ollama {0} at {1}; model {2} ({3}, {4})' -f $version, $base, $M.model_name, $show.details.parameter_size, $show.details.quantization_level)

$infra = New-Object System.Collections.Generic.List[object]
$addrs = Get-ListeningAddresses ([int]$M.runtime.port)
$exposed = @($addrs | Where-Object { $_ -ne '127.0.0.1' -and $_ -ne '::1' })
$infra.Add([pscustomobject]@{ id = 'loopback_only'; description = ('API bound to loopback only ({0})' -f ($addrs -join ', ')); pass = ($addrs.Count -gt 0 -and $exposed.Count -eq 0) })
$v1 = $false
try {
    $list = Invoke-RestMethod -Uri ($base + '/v1/models') -TimeoutSec 10 -UseBasicParsing
    $v1 = (@($list.data | Where-Object { $_.id -like ($M.model_name + '*') }).Count -gt 0)
} catch { }
$infra.Add([pscustomobject]@{ id = 'openai_endpoint'; description = 'OpenAI-compatible /v1/models lists steelman'; pass = $v1 })

Write-Host ''
Write-Host '== Live inference' -ForegroundColor Cyan
Write-Host 'The first request loads the model. On CPU the answer can take several minutes.'
$body = @{
    model    = $M.model_name
    stream   = $false
    messages = @(@{ role = 'user'; content = $Prompt })
} | ConvertTo-Json -Depth 5
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$r = Invoke-RestMethod -Method Post -Uri ($base + '/api/chat') -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8' -TimeoutSec $TimeoutSec -UseBasicParsing
$sw.Stop()
$text = [string]$r.message.content

$tps = 0
if ($r.eval_duration -gt 0) { $tps = [math]::Round($r.eval_count / ($r.eval_duration / 1e9), 2) }
$promptTps = 0
if ($r.prompt_eval_duration -gt 0) { $promptTps = [math]::Round($r.prompt_eval_count / ($r.prompt_eval_duration / 1e9), 1) }
$loadSec = [math]::Round($r.load_duration / 1e9, 1)

Write-Host ''
Write-Host '----- STEELMAN -----' -ForegroundColor DarkGray
Write-Host $text
Write-Host '--------------------' -ForegroundColor DarkGray
Write-Host ('{0} prompt tokens ({1} tok/s), {2} answer tokens at {3} tok/s, load {4}s, wall {5:N1}s, done_reason={6}' -f $r.prompt_eval_count, $promptTps, $r.eval_count, $tps, $loadSec, $sw.Elapsed.TotalSeconds, $r.done_reason)

$results = New-Object System.Collections.Generic.List[object]
foreach ($c in $infra) { $results.Add($c) }
foreach ($check in @($ref.checks)) {
    $results.Add([pscustomobject]@{ id = $check.id; description = $check.description; pass = (Test-Check $check $text) })
}
$failed = @($results | Where-Object { -not $_.pass })

Write-Host ''
Write-Host '== Automated checks' -ForegroundColor Cyan
foreach ($res in $results) {
    if ($res.pass) { Write-Host ('[PASS] {0}: {1}' -f $res.id, $res.description) -ForegroundColor Green }
    else { Write-Host ('[FAIL] {0}: {1}' -f $res.id, $res.description) -ForegroundColor Red }
}

$installedNote = 'runtime\installed.json missing'
if (Test-Path -LiteralPath $P.Installed) {
    $inst = Read-JsonFile $P.Installed
    $installedNote = ('{0} sha256 {1} ({2}@{3})' -f $inst.file, $inst.sha256, $inst.hf_repo, $inst.revision)
}
New-Item -ItemType Directory -Force -Path $P.ResultsDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$outFile = Join-Path $P.ResultsDir ('steelman-test-' + $stamp + '.md')
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# STEELMAN live test ' + $stamp)
$lines.Add('')
$lines.Add('- Model: ' + $installedNote)
$lines.Add(('- Ollama {0} at {1}; details: {2}, {3}' -f $version, $base, $show.details.parameter_size, $show.details.quantization_level))
$lines.Add(('- Timing: {0} prompt tokens, {1} answer tokens at {2} tok/s, load {3}s, wall {4:N1}s, done_reason={5}' -f $r.prompt_eval_count, $r.eval_count, $tps, $loadSec, $sw.Elapsed.TotalSeconds, $r.done_reason))
$lines.Add('')
$lines.Add('## Prompt')
$lines.Add('')
$lines.Add($Prompt)
$lines.Add('')
$lines.Add('## Response')
$lines.Add('')
$lines.Add($text)
$lines.Add('')
$lines.Add('## Automated checks')
$lines.Add('')
foreach ($res in $results) {
    $mark = 'FAIL'
    if ($res.pass) { $mark = 'PASS' }
    $lines.Add(('- {0} `{1}`: {2}' -f $mark, $res.id, $res.description))
}
[System.IO.File]::WriteAllText($outFile, ($lines -join "`n"), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host 'Human review (score 1-5 each): originality, clarity, strategic quality, independence, resistance to sycophancy.' -ForegroundColor Cyan
Write-Host 'Also check: no claims about the friend''s or the institution''s private intentions.'
Write-Host ('Saved: {0}' -f $outFile)
if ($failed.Count -eq 0) {
    Write-Host 'AUTOMATED CHECKS: PASS' -ForegroundColor Green
    exit 0
}
Write-Host ('AUTOMATED CHECKS: FAIL ({0} of {1})' -f $failed.Count, $results.Count) -ForegroundColor Red
exit 1
