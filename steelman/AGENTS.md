# AGENTS.md - working on STEELMAN

Instructions for any coding agent (Codex, Claude Code, others) that changes files
in `steelman/`. Jack, the owner, holds final authority; these rules come from his
brief of 1 Nov 2026.

## Scope

- Work only inside `steelman/`. This folder sits in the Operator repository but is
  independent of it: do not modify `src/`, `catherine/`, `migrations/`, `docs/`, the
  QRF project, cloud services, or any other AI House component (CATHERINE, REAPER,
  SELU'UNE).
- Never import, copy or summarise Jack's private conversation archive into this folder.
- Do not invent history or personality for Catherine or SELU'UNE.

## Hard boundaries (architecture, not tone)

- STEELMAN is advisory only. Do not give it tools, a tool executor, network access,
  file write access, or any path to REAPER, Catherine, email, chat apps or other
  systems. If a future integration needs STEELMAN's output, the *caller* reads the
  text; nothing executes what STEELMAN says.
- Keep the API bound to `127.0.0.1` (`runtime.host` in `model-manifest.json`).
  Exposing it beyond loopback is Jack's decision, recorded in writing, not a
  refactor.
- Keep `OLLAMA_NO_CLOUD=1` and `OLLAMA_NOHISTORY=1` in the runtime environment.
- Environment changes stay process-scoped. Never write user or machine environment
  variables, never touch an existing Ollama install, its port 11434 or `~/.ollama`.
- No paid services. No admin rights.

## What gets committed

- Committed: scripts, `persona.md`, `Modelfile`, `model-manifest.json`, `tests/reference-test.json`,
  `tools/`, `reports/`, documentation.
- Never committed (see `.gitignore`): `models/`, `runtime/`, `logs/`, `tests/results/`,
  any `*.gguf`. No secrets anywhere; STEELMAN needs none.

## Changing the model

1. Get the repo, the commit hash, the file size and the LFS SHA-256 from the Hugging
   Face API (`/api/models/<repo>/tree/<revision>?expand=true`, field `lfs.oid`).
2. Read the model card and the upstream base model's card; record license and
   lineage in `model-manifest.json`, including anything you could not verify.
3. Download the file, check `sha256sum` against the manifest, then run
   `python -I tools/verify_gguf.py --model <key> --gguf <path> --out <report.json>`.
4. Record the result in `reports/`. Say which runtime and hardware the test ran on.

Do not describe an abliterated model as unrestricted, infallible or smarter. Abliteration
removes a refusal direction; it does not add knowledge, and the published evaluations
show small regressions (notably TruthfulQA for the 7B).

## Changing the persona

- The only system prompt is the fenced block between the `STEELMAN-SYSTEM-PROMPT`
  markers in `persona.md`. Do not copy it into other files.
- Never put three double quotes in a row in it (it ends the Modelfile `SYSTEM` block).
- Keep the boundaries paragraph. Do not add policy lectures or blanket disclaimers;
  the brief asks for direct analysis inside an architectural boundary.
- After a change: re-run `install.ps1` on Windows (downloads are reused) and `test.ps1`,
  or `tools/verify_gguf.py` elsewhere.

## Modelfile

- `@@GGUF_PATH@@` and `@@SYSTEM_PROMPT@@` must each appear exactly once and nowhere
  else (not even in comments); `install.ps1` enforces this.
- No `TEMPLATE` line: Ollama v0.40 can prefer the GGUF's embedded chat template, so a
  custom template is not a reliable control. The embedded Qwen2.5 ChatML template is
  what the reference tests used.

## PowerShell conventions

- Windows PowerShell 5.1 compatible: no `??`, no ternary, no `-Parallel`, no
  `ConvertFrom-Json -AsHashtable`.
- ASCII only in `.ps1` files (5.1 reads BOM-less UTF-8 as ANSI).
- `Set-StrictMode -Version 3.0`, `$ErrorActionPreference = 'Stop'` (set in `lib/common.ps1`).
- Variable names are case-insensitive: `$m` overwrites `$M` (the manifest), `$p`
  overwrites `$P` (the paths). Pick distinct names.
- Quote native arguments that contain commas (`'--format=csv,noheader'`).
- Check `$LASTEXITCODE` after native commands; they do not throw.
- Read and write files with explicit UTF-8 (`[System.IO.File]` + `UTF8Encoding($false)`).

## Reporting

State plainly what ran where. A Linux container test is not a Windows install. Do not
report STEELMAN as operational on Jack's machine until `install.ps1` and `test.ps1`
have run there.
