#!/usr/bin/env python3
"""Verify a STEELMAN GGUF end to end without Ollama.

Runs the selected model directly through llama.cpp (llama-cpp-python) with:
  - the system prompt block from persona.md,
  - the sampling parameters from the Modelfile template,
  - the chat template embedded in the GGUF (the one Ollama will also use),
  - the reference prompt and automated checks from tests/reference-test.json.

It first checks the file's SHA-256 against model-manifest.json, so a passing run
means "this exact file, with this exact persona, produced this answer".

Usage:
  python -I tools/verify_gguf.py --model 7b --gguf /path/to/file.gguf --out report.json

Requires: pip install llama-cpp-python  (CPU build is enough).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROMPT_RE = re.compile(
    r"<!-- STEELMAN-SYSTEM-PROMPT:BEGIN -->\s*```text\r?\n(.*?)\r?\n```\s*<!-- STEELMAN-SYSTEM-PROMPT:END -->",
    re.S,
)


def system_prompt() -> str:
    text = (ROOT / "persona.md").read_text(encoding="utf-8")
    m = PROMPT_RE.search(text)
    if not m:
        sys.exit("persona.md: system prompt block not found")
    prompt = m.group(1).replace("\r\n", "\n").strip()
    if '"""' in prompt:
        sys.exit('persona.md: system prompt contains """')
    return prompt


def modelfile_params() -> dict:
    params: dict = {"stop": []}
    for line in (ROOT / "Modelfile").read_text(encoding="utf-8").splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0] == "PARAMETER":
            key, value = parts[1], parts[2]
            if key == "stop":
                params["stop"].append(value.strip('"'))
            else:
                params[key] = float(value) if "." in value else int(value)
    return params


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def run_checks(text: str, checks: list) -> list:
    results = []
    for c in checks:
        t = c["type"]
        if t == "absent":
            ok = re.search(c["pattern"], text) is None
        elif t == "present":
            ok = re.search(c["pattern"], text) is not None
        elif t == "all_present":
            ok = all(re.search(p, text) for p in c["patterns"])
        elif t == "count_at_least":
            ok = len(list(re.finditer(c["pattern"], text))) >= c["min"]
        elif t == "absent_in_head":
            ok = re.search(c["pattern"], text[: c["head_chars"]]) is None
        elif t == "min_words":
            ok = len(text.split()) >= c["min"]
        else:
            raise ValueError(f"unknown check type {t}")
        results.append({"id": c["id"], "description": c["description"], "pass": ok})
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["14b", "7b"], required=True)
    ap.add_argument("--gguf", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--skip-hash", action="store_true", help="only if the hash was verified separately")
    args = ap.parse_args()

    manifest = json.loads((ROOT / "model-manifest.json").read_text(encoding="utf-8"))
    entry = manifest["models"][args.model]
    reference = json.loads((ROOT / "tests" / "reference-test.json").read_text(encoding="utf-8"))
    params = modelfile_params()
    sys_prompt = system_prompt()

    report: dict = {
        "started_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_key": args.model,
        "file": args.gguf.name,
        "expected_sha256": entry["sha256"],
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "cpu_count": os.cpu_count(),
            "python": platform.python_version(),
        },
        "system_prompt_sha256": hashlib.sha256(sys_prompt.encode("utf-8")).hexdigest(),
        "params": params,
        "seed": args.seed,
    }

    size = args.gguf.stat().st_size
    report["size_bytes"] = size
    if size != entry["size_bytes"]:
        sys.exit(f"size mismatch: {size} != {entry['size_bytes']}")
    if not args.skip_hash:
        t0 = time.time()
        digest = sha256_file(args.gguf)
        report["sha256"] = digest
        report["hash_seconds"] = round(time.time() - t0, 1)
        if digest != entry["sha256"]:
            sys.exit(f"SHA-256 mismatch: {digest} != {entry['sha256']}")
        print(f"sha256 OK {digest}", flush=True)

    import llama_cpp  # imported late so --help works without it

    report["runtime"] = f"llama-cpp-python {llama_cpp.__version__}"
    t0 = time.time()
    llm = llama_cpp.Llama(
        model_path=str(args.gguf),
        n_ctx=params.get("num_ctx", 8192),
        n_threads=args.threads,
        seed=args.seed,
        verbose=False,
    )
    report["load_seconds"] = round(time.time() - t0, 1)
    md = llm.metadata
    report["gguf_metadata"] = {
        k: md.get(k)
        for k in (
            "general.architecture",
            "general.name",
            "general.file_type",
            "general.quantization_version",
            "qwen2.block_count",
            "qwen2.context_length",
        )
    }
    tmpl = md.get("tokenizer.chat_template", "")
    report["chat_template_sha256"] = hashlib.sha256(tmpl.encode("utf-8")).hexdigest() if tmpl else None
    report["chat_template_is_chatml"] = "<|im_start|>" in tmpl
    print(f"loaded in {report['load_seconds']}s: {report['gguf_metadata']}", flush=True)

    messages = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": reference["prompt"]},
    ]
    t0 = time.time()
    out = llm.create_chat_completion(
        messages=messages,
        temperature=params["temperature"],
        top_p=params["top_p"],
        top_k=params["top_k"],
        repeat_penalty=params["repeat_penalty"],
        max_tokens=params["num_predict"],
        stop=params["stop"],
        seed=args.seed,
    )
    elapsed = time.time() - t0
    text = out["choices"][0]["message"]["content"]
    usage = out.get("usage", {})
    report["generation"] = {
        "seconds": round(elapsed, 1),
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "finish_reason": out["choices"][0].get("finish_reason"),
        "approx_tokens_per_second_overall": round((usage.get("completion_tokens") or 0) / elapsed, 2),
    }
    report["prompt"] = reference["prompt"]
    report["response"] = text
    report["checks"] = run_checks(text, reference["checks"])
    report["automated_pass"] = all(c["pass"] for c in report["checks"])
    report["finished_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    print("\n===== RESPONSE =====\n" + text + "\n====================\n")
    for c in report["checks"]:
        print(f"[{'PASS' if c['pass'] else 'FAIL'}] {c['id']}: {c['description']}")
    print(f"generation: {report['generation']}")
    if args.out:
        args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"report written to {args.out}")
    return 0 if report["automated_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
