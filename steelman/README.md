# STEELMAN

The AI House's consigliere: an independent, local language model that gives Jack
and Catherine an adversarial second read. It runs entirely on Jack's Windows
machine, answers only on `127.0.0.1`, and cannot act on anything. It produces
advice and nothing else.

> **Status (1 Nov 2026):** the verified weights and persona v0.3 were tested live
> in a Linux build container (llama.cpp, CPU). With the 14B model, the answer met
> every explicit requirement of the reference test, but it was weak on
> originality and voice. The Windows scripts are parsed and unit-checked but
> **have not run on Windows yet**. See [Verification](#verification). STEELMAN
> becomes operational on Jack's machine when `install.ps1` and `test.ps1` have
> run there.

## Quick start (Windows 10 1803+ or Windows 11)

From this folder, in a normal (non-admin) PowerShell window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1   # hardware check, runtime, weights, register model
powershell -NoProfile -ExecutionPolicy Bypass -File .\test.ps1      # live inference test with the reference prompt
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1    # terminal chat (type /bye to leave)
powershell -NoProfile -ExecutionPolicy Bypass -File .\status.ps1    # health, binding, GPU share
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop.ps1      # shut the server down
```

`-ExecutionPolicy Bypass` applies to that one process only; it does not change
the machine's policy. Nothing needs administrator rights.

What `install.ps1` needs:

| | 7B | 14B |
|---|---|---|
| RAM (auto-selection rule) | an 8 GB PC | a 16 GB PC and a memory budget of 13 GiB (see below) |
| Download | ~4.4 GiB weights + Ollama runtime | ~8.4 GiB weights + Ollama runtime |
| Free disk during install | ~14 GiB | ~23 GiB |

The disk figure counts the GGUF twice because Ollama stores its own
byte-identical copy. Pass `-RemoveGgufAfterImport` to delete the downloaded file
once that copy is confirmed. The Ollama Windows zip bundles GPU libraries, so
the runtime is a few GB; its exact size was not measured here.

## What gets installed, and where

Everything stays inside this folder. Nothing touches the rest of the system.

```
steelman/
  runtime/ollama/       Ollama v0.40.13 for Windows (official release zip, SHA-256 checked)
  runtime/installed.json  what was installed, hashes, selection reason
  runtime/hardware.json   what install.ps1 detected
  models/gguf/          the verified GGUF download
  models/ollama/        Ollama's model store (OLLAMA_MODELS); blob named sha256-<hash>
  logs/server.log       server output
  tests/results/        test transcripts (git-ignored: may hold private prompts)
```

- The server listens on **`127.0.0.1:11435`**. Ollama's default port 11434,
  `%USERPROFILE%\.ollama`, and any Ollama you already run are left alone.
- Environment variables are set only in the processes these scripts start. No user
  or machine environment variable is written.
- Runtime settings from `model-manifest.json`: `OLLAMA_NO_CLOUD=1` (no remote
  models, no web search), `OLLAMA_NOHISTORY=1` (the terminal chat keeps no history
  file), one model, one request at a time, unload after 30 minutes idle.
- Because the server binds to loopback only, Windows Firewall has no reason to
  prompt.

Uninstall: run `stop.ps1`, then delete `runtime\`, `models\` and `logs\` (or the
whole folder).

## Model selection

`install.ps1 -Model auto` (the default) applies the rule in
`model-manifest.json`:

```
budget = largest discrete GPU's VRAM (NVIDIA, or AMD Radeon RX/PRO; 4 GiB+)
       + max(0, RAM - 8 GiB reserved for Windows and apps)
14B  if RAM >= 15 GiB and budget >= 13 GiB
7B   otherwise, if RAM >= 7 GiB
(RAM = what Windows reports as usable: a 16 GB PC shows about 15.8 GiB,
 an 8 GB PC about 7.8 GiB, hence 15 and 7.)
```

Examples: 16 GiB RAM with no GPU gets 7B; 16 GiB with an 8 GiB GPU gets 14B with
partial offload; 32 GiB with no GPU gets 14B on CPU (slower). Override with
`-Model 14b` or `-Model 7b`. Integrated GPUs and Intel Arc are not counted, which
is conservative.

| | Preferred: 14B | Fallback: 7B |
|---|---|---|
| Model | huihui-ai Qwen2.5-14B-Instruct-abliterated | huihui-ai Qwen2.5-7B-Instruct-abliterated-v2 |
| GGUF repo | `featherless-ai-quants/huihui-ai-Qwen2.5-14B-Instruct-abliterated-GGUF` | `tensorblock/Qwen2.5-7B-Instruct-abliterated-v2-GGUF` |
| Pinned revision | `ed48fef312b00cd47b68a390e4d900c0e065d13e` | `02a09afd3e8f21b886dadfe4ec0566b74ef2ee70` |
| File | `huihui-ai-Qwen2.5-14B-Instruct-abliterated-Q4_K_M.gguf` | `Qwen2.5-7B-Instruct-abliterated-v2-Q4_K_M.gguf` |
| Quantization | Q4_K_M (GGUF file_type 15) | Q4_K_M (GGUF file_type 15) |
| Size | 8,988,110,816 bytes | 4,683,074,112 bytes |
| SHA-256 | `1c354d92bc72320ea828b638b5122fff77a29e84d65c404e28c404ee2e3c6179` | `69be06c4feabbb9e77517446b5f991a2dac11b9e2dc5441e263cf82b3c3ccbee` |
| Architecture | qwen2, 48 layers, 32K native context | qwen2, 28 layers, 32K native context |
| License | none declared on the quant card; root model Apache-2.0 | Apache-2.0 (quant card and upstream) |

The URLs are pinned to a commit, not `main`, and each SHA-256 is the Hugging Face
LFS object id at that commit. Both files were downloaded on 1 Nov 2026 and
`sha256sum` matched.

## Provenance: read before trusting the weights

- **These are third-party community modifications** of Alibaba's Qwen2.5-Instruct
  models. "Abliteration" removes the internal direction associated with refusals.
  It adds no knowledge and no reasoning ability, and it does not make the model
  unrestricted in any reliable sense. huihui-ai's own numbers for the 7B v2 show
  small trade-offs against the original: TruthfulQA **57.81 vs 62.46**,
  MMLU-Pro 42.03 vs 43.12, IF_Eval 77.82 vs 76.44. The TruthfulQA drop matters
  for a role built around reality-testing, so treat STEELMAN's factual claims as
  claims to check.
- **14B chain is partly unverifiable.** The upstream repo
  `huihui-ai/Qwen2.5-14B-Instruct-abliterated` returned HTTP 401 from the Hugging
  Face API on 1 Nov 2026, which means deleted, renamed or private. Its card and the
  abliteration step can no longer be inspected. The featherless quant card declares
  no license. Apache-2.0 applies by inheritance from `Qwen/Qwen2.5-14B-Instruct`,
  but that is an inference.
- **7B Q4_K_M was removed from `main`.** TensorBlock deleted every GGUF except
  Q2_K on 27 Jan 2026 (commit `98cac230`). The Q4_K_M file is still served at the
  pinned older commit. If Hugging Face ever purges it, the manifest needs a new
  source, and `install.ps1` will fail with a download error rather than fetch
  something else.

## Architecture and containment

```
  Jack ── launch.ps1 (ollama run) ─┐
  test.ps1 / scripts ──────────────┼─► http://127.0.0.1:11435 ─► runtime\ollama\ollama.exe serve
  Catherine (future, local) ───────┘                               └─ models\ollama\blobs\sha256-<verified hash>
```

The boundary is architectural, as the brief requires. The prompt is not asked to
water anything down.

- **No executor.** Nothing in this folder executes model output. Ollama can return
  structured "tool calls" if a caller offers tools, but they come back as text to
  the caller. The caller must never execute what STEELMAN returns. That is the rule
  for any integration.
- **No egress features.** `OLLAMA_NO_CLOUD=1` disables Ollama's remote models and
  web search. STEELMAN needs the network only during `install.ps1`.
- **Loopback only.** `status.ps1` and `test.ps1` check the listening address and
  flag anything other than `127.0.0.1` or `::1`.
- **Prompt-level role.** The system prompt states that STEELMAN cannot contact
  anyone, run commands, control REAPER or change Catherine. That only shapes what
  it says; the guarantee comes from the plumbing above.

House principle: *"All inputs are allowed. Only rested decisions are allowed to act."*

## Local API

Base URL: **`http://127.0.0.1:11435`** (while the server runs: `launch.ps1`,
`launch.ps1 -ServerOnly`, or after `install.ps1` / `test.ps1`).

Native Ollama API:

```powershell
$body = @{ model = 'steelman'; stream = $false
           messages = @(@{ role = 'user'; content = 'My read on X is Y. Tear it apart.' }) } | ConvertTo-Json -Depth 5
$r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:11435/api/chat `
       -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8'
$r.message.content
```

OpenAI-compatible API (`/v1/chat/completions`, model `steelman`, any API key string):

```sh
curl http://127.0.0.1:11435/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"steelman","messages":[{"role":"user","content":"..."}]}'
```

### Integration contract for Catherine

1. Send only `user` and `assistant` messages. A caller-supplied `system` message
   **replaces** STEELMAN's persona (Ollama behavior).
2. Do not pass `tools`. Never execute anything parsed from STEELMAN's output.
3. Label the output as STEELMAN's advisory input, kept separate from Catherine's
   own view and from any decision record.
4. **Reachability:** the Catherine runtime in this repository (`src/agent/`) is a
   Cloudflare Worker, and a Worker cannot reach `127.0.0.1` on Jack's PC. Wiring
   them together needs either a Catherine process that runs locally, or Jack's
   explicit decision to expose STEELMAN through an authenticated tunnel. A tunnel
   ends the loopback-only boundary. Nothing here does either.

## Changing the persona

The persona lives in `persona.md`, and its system prompt block is the only copy
the model sees.

1. Edit the block between the `STEELMAN-SYSTEM-PROMPT` markers.
2. Re-run `install.ps1`. Downloads are reused, and the model is re-registered.
3. Run `test.ps1`. `status.ps1` warns when `persona.md` has changed since the
   last install.

## Files

| File | Purpose |
|---|---|
| `install.ps1` | Hardware report, model selection, runtime + weights download with SHA-256 checks, Modelfile rendering, `ollama create`, blob and prompt verification |
| `launch.ps1` | Starts the isolated server (hidden, detached) and opens the terminal chat; `-ServerOnly` for API use |
| `stop.ps1` | Stops only processes running from `runtime\ollama\` |
| `status.ps1` | Installed model and hashes, server and processes, binding, loaded model and GPU share, persona drift |
| `test.ps1` | Live test over the localhost API with the reference prompt; saves a transcript and prints the rubric |
| `persona.md` | Persona design record and the system prompt |
| `Modelfile` | Ollama template: sampling, context, and placeholders for the GGUF path and system prompt |
| `model-manifest.json` | Single source of truth: runtime version, model URLs, revisions, sizes, hashes, lineage, selection rule |
| `tests/reference-test.json` | The reference prompt and the automated checks shared by `test.ps1` and `tools/verify_gguf.py` |
| `tools/verify_gguf.py` | Cross-platform harness: runs a GGUF through llama.cpp with the same persona, sampling and checks |
| `lib/common.ps1` | Shared helpers |
| `reports/` | Verification reports |
| `AGENTS.md` | Rules for coding agents working in this folder |

## Verification

[`reports/2026-11-01-container-verification.md`](reports/2026-11-01-container-verification.md)
has the method, all six live answers (2 models × 3 persona versions), timings and
scores. In short:

| Persona | 14B automated checks | 7B automated checks |
|---|---|---|
| v0.1 | 6/7 | 6/7 |
| v0.2 | 7/7 | 7/7 |
| v0.3 (current) | 7/7 | 6/7 |

The automated checks are only a floor. Both models are clear and non-sycophantic,
but their moves are conventional and the ironworker voice does not come through.
Treat STEELMAN as a structured second opinion, not yet as an original strategist.

## Troubleshooting

- **"running scripts is disabled on this system"**: use the
  `powershell -ExecutionPolicy Bypass -File ...` form shown above.
- **"…is already answering … but not from STEELMAN's runtime"**: another program
  uses port 11435. Change `runtime.port` in `model-manifest.json`.
- **Slow answers**: `status.ps1` shows how much of the model sits on the GPU. On
  CPU only, the 14B is slow: about 1.2-1.5 answer tokens/s on a 4-vCPU cloud VM,
  or 4.5-5.5 minutes per full answer. A desktop with fast RAM does better. If it
  is still too slow, re-run `install.ps1 -Model 7b`.
- **Interrupted download**: re-run `install.ps1`. The weights download resumes,
  and nothing is used until its SHA-256 matches.
- **Hash mismatch**: the bad file is deleted automatically. A repeat mismatch means
  the upstream file changed; do not edit the hash to make it pass.
