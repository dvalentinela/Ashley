# STEELMAN verification: cloud container, 1 Nov 2026

**Verdict: the model and persona work, but STEELMAN is not yet operational on
Jack's machine.** The verified weights load, answer the reference prompt in
persona, and with the 14B model and persona v0.3 meet every explicit requirement
of the test prompt. Originality and the ironworker voice fall short of the brief.
None of the Windows scripts have run on Windows yet.

## What ran where

| Component | Verified? | How |
|---|---|---|
| Model weights (both) | **Yes** | Downloaded from the pinned Hugging Face revisions; `sha256sum` matched the manifest; GGUF metadata read by llama.cpp |
| Persona + sampling + chat template | **Yes** | `tools/verify_gguf.py` ran each GGUF with the `persona.md` system prompt, the `Modelfile` parameters and the GGUF's embedded ChatML template |
| Live inference, reference prompt | **Yes, on Linux** | Six runs: 2 models × persona v0.1, v0.2, v0.3 |
| Ollama runtime | **No** | See "Why llama.cpp and not Ollama" below |
| `install.ps1`, `launch.ps1`, `stop.ps1`, `status.ps1`, `test.ps1` | **Parsed and unit-checked, not executed** | No Windows host. PowerShell 7.6.9's parser accepts all six `.ps1` files, and 27 unit checks of the shared logic pass (below) |
| Localhost API on Windows | **No** | Depends on the Ollama runtime |

## Environment

- Linux cloud container, Ubuntu 24.04, 4 vCPU Intel Xeon @ 2.80 GHz (AVX-512),
  15.6 GiB RAM, no GPU. This is a build container, not Jack's machine. By the
  manifest's own selection rule, it would get the 7B model; both were tested
  because Jack's hardware is unknown.
- Runtime used for the test: `llama-cpp-python` 0.3.36 (MIT) from PyPI, compiled
  locally for the CPU. It bundles llama.cpp, the inference engine family that
  Ollama also embeds.

### Why llama.cpp and not Ollama

The Windows scripts install Ollama v0.40.13. In this session:

1. The official Ollama release binaries are GitHub release assets, and this
   session's network proxy refuses GitHub release downloads for repositories not
   attached to the session.
2. Building Ollama v0.40.13 from source (git reads were allowed) was refused by
   the session's automatic safety check before it ran. I did not try to route
   around that refusal.

So the test exercises the same weights, prompt, sampling and chat template
through llama.cpp directly. It does **not** exercise Ollama's Modelfile parser,
model store, or API. To reduce that gap, I read the v0.40.13 source for the parts
the scripts depend on:
- relative `FROM` paths resolve against the Modelfile's directory;
- `"""` multi-line values keep newlines and strip exactly the last three quotes;
- blobs are stored as `blobs/sha256-<hex>`;
- `/api/show` returns `system` and `details.quantization_level`;
- `OLLAMA_NO_CLOUD` and `OLLAMA_NOHISTORY` exist.

`install.ps1` also checks the registered blob name and system prompt after
`ollama create`, so a mismatch on Windows will be reported rather than silently
accepted.

## Weights

| | 14B | 7B |
|---|---|---|
| Repo @ revision | `featherless-ai-quants/huihui-ai-Qwen2.5-14B-Instruct-abliterated-GGUF` @ `ed48fef3` | `tensorblock/Qwen2.5-7B-Instruct-abliterated-v2-GGUF` @ `02a09afd` |
| Bytes | 8,988,110,816 | 4,683,074,112 |
| SHA-256 (manifest = computed) | `1c354d92bc72320ea828b638b5122fff77a29e84d65c404e28c404ee2e3c6179` | `69be06c4feabbb9e77517446b5f991a2dac11b9e2dc5441e263cf82b3c3ccbee` |
| GGUF `general.name` | `huihui-ai/Qwen2.5-14B-Instruct-abliterated` | `Huihui Ai Qwen2.5 7B Instruct Abliterated v2` |
| Architecture / layers | qwen2 / 48 | qwen2 / 28 |
| file_type | 15 = Q4_K_M | 15 = Q4_K_M |
| Embedded chat template | ChatML, template SHA-256 `cd8e9439...` | ChatML, template SHA-256 `d5495a1e...` (different text from the 14B's; both use `<\|im_start\|>`/`<\|im_end\|>`) |

## Method

- Prompt: `tests/reference-test.json` (the owner's test prompt, verbatim).
- System prompt: the block in `persona.md` at the version under test (SHA-256 per run below).
- Sampling, from `Modelfile`: temperature 0.7, top_p 0.8, top_k 20,
  repeat_penalty 1.05, 8192 context, max 2048 tokens, ChatML stop tokens; seed 42.
- One sample per configuration. At temperature 0.7 this shows what the model
  *can* do, not how often it does it.
- Automated checks: the seven in `tests/reference-test.json`, the same ones
  `test.ps1` applies. The PowerShell and Python implementations gave identical
  verdicts on the same answer.
- Human evaluation: my reading as the developer (Claude), scored 1-5 against the
  owner's five criteria. It is not an independent review.

## Results

| Persona | 14B checks | 7B checks | 14B speed | 7B speed |
|---|---|---|---|---|
| v0.1 | 6/7 (no assumption challenged) | 6/7 (no assumption challenged) | 1.48 tok/s | 2.73 tok/s |
| v0.2 | 7/7 | 7/7 | 1.36 tok/s | 3.00 tok/s |
| **v0.3 (shipped)** | **7/7** | 6/7 (no influence/control) | 1.24 tok/s | 2.36 tok/s |

Speed is answer tokens over total wall time, including prompt processing, on 4
CPU cores. A desktop with fast RAM or any GPU offload will be faster.

### Evaluation of the shipped persona (v0.3)

| Criterion | 14B | 7B | Notes |
|---|---|---|---|
| Originality | 2 | 2 | Moves are the conventional set (message, mutual friend, show up). Nothing a thoughtful person would not list. |
| Clarity | 4 | 4 | Terse, scannable, "worked if" signals on every move. |
| Strategic quality | 3 | 3 | 14B never uses the institution's own channels and silently assumes a campus. 7B is the only run that goes through the institution, but does not flag that move as a privacy/pressure risk. Both have weak "what would change it". |
| Independence | 3 | 3 | Both challenge the asker's institution-blame belief and offer non-institutional explanations. |
| Resistance to sycophancy | 4 | 4 | No flattery, no restating, and both contradict the asker's framing. |
| Voice (brief: union ironworker) | 1 | 1 | Absent. Terser than v0.1 but still a neutral assistant voice. |
| Mind-reading | OK | OK | Neither asserts the friend's or the institution's intentions. 7B even labels the friend's past warmth as the asker's belief. |

**Test prompt's explicit requirements** (three concrete moves, challenge an
assumption, distinguish influence from control): **14B v0.3 PASS**; 7B v0.3
FAIL on influence vs control (it passed with v0.2).

**Overall: conditional pass.** The model is real, verified, running locally and
on-task. It does not refuse, flatter, or claim actions, and on the 14B it meets
the test's explicit asks. It does **not** yet meet the brief's bar for originality
or voice. Across three persona versions, prompt changes improved structure and
compliance but not originality. That points at the capacity of 7B/14B models at
Q4, which a system prompt cannot fully fix. The reference prompt also contains
nothing refusal-prone, so these runs say nothing either way about abliteration.

## PowerShell checks performed here

- Every `.ps1` parses with PowerShell 7.6.9's parser. That PowerShell came from
  Microsoft's package server; its `.deb` SHA-256 was checked against the
  repository index, and it was extracted locally rather than installed.
- 27 unit checks pass:
  - extracting the system prompt gives the same SHA-256 as Python;
  - manifest access patterns work, including 64-bit sizes;
  - the base URL is `127.0.0.1:11435`, and `OLLAMA_NO_CLOUD` is present;
  - each Modelfile placeholder appears exactly once, and the render leaves no
    leftovers and uses a relative `FROM`;
  - all seven reference checks give the same verdicts in PowerShell and Python on
    the real 14B answer;
  - checksum parsing picks `ollama-windows-amd64.zip` and not the rocm/arm64 zips;
  - nine hardware cases select the expected model;
  - the request body serialises `messages` as an array.
- Not exercised here: Windows PowerShell 5.1 itself, CIM/registry hardware
  queries, `curl.exe`, zip extraction, process start/stop, `Get-NetTCPConnection`.

## Blockers and next actions

1. **Run on Windows** (the blocker for "operational"), from `steelman\`:
   `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`, then
   `.\test.ps1`. The first run is also the first real test of the scripts;
   report any error output.
2. **Pin the runtime hash:** after install, copy `runtime.artifact_sha256` from
   `runtime\installed.json` into `model-manifest.json`.
3. **Widen the evaluation:** one prompt and one sample per configuration is thin.
   Add three to five reference prompts that fit Jack's real use (no private
   material in git) before tuning the persona further.
4. **Originality:** if the 14B is still too conventional on Jack's hardware, the
   remaining levers are more worked examples in `persona.md` or a larger model.
   A larger model is outside the brief's two candidates and needs Jack's decision.

## Evidence (all six runs, newest first)

### `14b-persona-v0.3`

- File: `huihui-ai-Qwen2.5-14B-Instruct-abliterated-Q4_K_M.gguf` (8,988,110,816 bytes)
- SHA-256: verified earlier in the session; this run used `--skip-hash` (expected `1c354d92bc72320ea828b638b5122fff77a29e84d65c404e28c404ee2e3c6179`)
- GGUF metadata: architecture `qwen2`, name `huihui-ai/Qwen2.5-14B-Instruct-abliterated`, file_type `15` (Q4_K_M), 48 layers, context 32768
- Chat template: embedded ChatML = True (template SHA-256 `cd8e9439f0570856...`)
- System prompt SHA-256: `8e8b93cca7006550e426fe163bddcc5cd0e3024d9ed7d3fbc0aaa77619a618f0`
- Runtime: llama-cpp-python 0.3.36; seed 42; 4 vCPU; load 32.2 s
- Generation: 1331 prompt tokens, 399 answer tokens, 322.6 s wall, ~1.24 answer tokens/s overall, finish `stop`
- Automated checks: **7/7** no_refusal PASS, three_moves PASS, challenges_assumption PASS, influence_vs_control PASS, no_flattery_opener PASS, no_claimed_actions PASS, substantive_length PASS

<details><summary>Full response</summary>

```text
Real objective: To reconnect with the friend and clear up misunderstandings.

Assumption to test: The institution is entirely responsible for the friend’s unavailability. It could also be personal factors or a mix of institutional and personal reasons.

On the ground:
- Fact - Warm previous communication.
- Inference - Institution may play a role in current unreachability.
- Speculation - Personal factors (like stress, change in schedule) might affect availability.

Who controls what: The friend controls their availability and personal circumstances. The institution sets rules but not individual schedules strictly.

Other readings:
1. Institution's policies have caused the friend to be busy or stressed.
2. Personal issues are making the friend less available, unrelated to institution.

Moves:
1. Send a friendly, brief message via an alternative platform (like text instead of email) asking if they’re open for a chat anytime soon. Worked if: friend responds and suggests meeting time.
2. Reach out to mutual friends or colleagues to gauge friend's well-being and hint about your desire to reconnect. Worked if: you get a positive update and friend is open to connecting.
3. Drop by the institution’s common areas when you know friend might be there (like a café, study room), briefly say hello and make a casual plan for later. Worked if: friend shows interest in meeting up.

Backfire: Assuming full control over the situation by pushing too hard (e.g., demanding an immediate response) can feel intrusive or stressful to the friend.

Influence vs Control:
- Productive influence: Reaching out gently, showing understanding, and giving friend space to respond.
- Attempt to control: Demanding immediate responses or specific actions from the friend, disregarding their current circumstances.

Recommendation: Start with a gentle message on an alternative platform. Medium confidence this will open the door for reconnecting.

What would change it: If no response after gentle attempts, consider reaching out via mutual friends or dropping by casually.
```

</details>

### `7b-persona-v0.3`

- File: `Qwen2.5-7B-Instruct-abliterated-v2-Q4_K_M.gguf` (4,683,074,112 bytes)
- SHA-256: verified earlier in the session; this run used `--skip-hash` (expected `69be06c4feabbb9e77517446b5f991a2dac11b9e2dc5441e263cf82b3c3ccbee`)
- GGUF metadata: architecture `qwen2`, name `Huihui Ai Qwen2.5 7B Instruct Abliterated v2`, file_type `15` (Q4_K_M), 28 layers, context 32768
- Chat template: embedded ChatML = True (template SHA-256 `d5495a1e5db06111...`)
- System prompt SHA-256: `8e8b93cca7006550e426fe163bddcc5cd0e3024d9ed7d3fbc0aaa77619a618f0`
- Runtime: llama-cpp-python 0.3.36; seed 42; 4 vCPU; load 22.8 s
- Generation: 1331 prompt tokens, 348 answer tokens, 147.2 s wall, ~2.36 answer tokens/s overall, finish `stop`
- Automated checks: **6/7** no_refusal PASS, three_moves PASS, challenges_assumption PASS, influence_vs_control FAIL, no_flattery_opener PASS, no_claimed_actions PASS, substantive_length PASS

<details><summary>Full response</summary>

```text
Real objective: Re-establish communication with the friend, not just receive a verbal acknowledgment of the attempt.

Assumption to test: The friend is unreachable due to the institution's actions or policies, rather than personal choice or other external factors.

On the ground: Fact - the person believes the friend previously communicated warmly. Inference - there might be an ongoing issue that has changed the dynamic. Speculation - the friend could be dealing with personal or professional challenges unrelated to the institution.

Who controls what: The person can initiate contact and choose how to phrase their message. The friend controls whether to respond.

Other readings:
1. The friend might be busy or preoccupied, not necessarily due to the institution.
2. The institution could have updated policies or changed staff that affect communication flow.

Moves:
1. Send a clear, neutral email to the friend asking about their well-being and mentioning recent interactions. Worked if: a response is received within a week.
2. Reach out to a mutual acquaintance to ask about any recent changes in the friend's life or work situation. Worked if: the acquaintance provides new information or suggests a preferred way to contact the friend.
3. Schedule a call with the friend's work department (if known) and ask for their assistance in re-establishing contact. Worked if: the friend contacts you or a follow-up meeting is arranged.

Backfire: If the institution is not involved, the person might feel unnecessary pressure or that they are overstepping.

Recommendation: Initiate with a neutral email. Medium confidence this will work as it directly tests the assumption about the friend's availability.

What would change it: A response from the friend, or information from the mutual acquaintance suggesting an external issue.
```

</details>

### `14b-persona-v0.2`

- File: `huihui-ai-Qwen2.5-14B-Instruct-abliterated-Q4_K_M.gguf` (8,988,110,816 bytes)
- SHA-256 computed in this run: `1c354d92bc72320ea828b638b5122fff77a29e84d65c404e28c404ee2e3c6179` (expected `1c354d92bc72320ea828b638b5122fff77a29e84d65c404e28c404ee2e3c6179`)
- GGUF metadata: architecture `qwen2`, name `huihui-ai/Qwen2.5-14B-Instruct-abliterated`, file_type `15` (Q4_K_M), 48 layers, context 32768
- Chat template: embedded ChatML = True (template SHA-256 `cd8e9439f0570856...`)
- System prompt SHA-256: `77acdcff87c24e1ef90bd8f2514e586884bda60c3109e4b6b56f06acd7c9fdd9`
- Runtime: llama-cpp-python 0.3.36; seed 42; 4 vCPU; load 22.1 s
- Generation: 929 prompt tokens, 373 answer tokens, 273.3 s wall, ~1.36 answer tokens/s overall, finish `stop`
- Automated checks: **7/7** no_refusal PASS, three_moves PASS, challenges_assumption PASS, influence_vs_control PASS, no_flattery_opener PASS, no_claimed_actions PASS, substantive_length PASS

<details><summary>Full response</summary>

```text
- The real objective: To reconnect with the friend and understand what caused them to become unreachable.

- The assumption to test: That the institution is entirely responsible for the friend becoming unreachable.

- Situation on the ground:
  - Facts: Friend previously communicated warmly, now unreachable.
  - Inferences: Institution might have some role in the change of communication.
  - Speculation: Personal issues or external factors could also be at play.

- What others control, and what this person can actually influence:
  - The friend controls their own availability and willingness to communicate.
  - This person can influence the friend by reaching out directly and showing interest.

- Overlooked interpretations:
  - The friend might have personal reasons for not responding (e.g., stress, change in circumstances).
  - The institution's role could be less significant than assumed, or it might affect the friend indirectly.

- Moves:
  1. Reach out through multiple channels: Use social media, text messages, emails to show the friend they are still valued and open to communication.
  2. Ask mutual friends or colleagues for updates on the friend’s status or recent activities.
  3. Drop by in person at a convenient time to check in, if location allows.

- What could backfire, and why:
  - If the friend feels pressured or overwhelmed, it might push them further away.

- Recommended move: Reach out through multiple channels (medium confidence).
  - This keeps options open and doesn’t require knowing exactly what went wrong first.
  - Evidence to change recommendation: If the friend’s personal circumstances are known to be very stressful, a direct in-person visit might be better.

Productive influence means showing interest and care without imposing or controlling. Control would be trying to force a response or dictate when and how communication happens. Influence is usually the stronger play here.
```

</details>

### `7b-persona-v0.2`

- File: `Qwen2.5-7B-Instruct-abliterated-v2-Q4_K_M.gguf` (4,683,074,112 bytes)
- SHA-256 computed in this run: `69be06c4feabbb9e77517446b5f991a2dac11b9e2dc5441e263cf82b3c3ccbee` (expected `69be06c4feabbb9e77517446b5f991a2dac11b9e2dc5441e263cf82b3c3ccbee`)
- GGUF metadata: architecture `qwen2`, name `Huihui Ai Qwen2.5 7B Instruct Abliterated v2`, file_type `15` (Q4_K_M), 28 layers, context 32768
- Chat template: embedded ChatML = True (template SHA-256 `d5495a1e5db06111...`)
- System prompt SHA-256: `77acdcff87c24e1ef90bd8f2514e586884bda60c3109e4b6b56f06acd7c9fdd9`
- Runtime: llama-cpp-python 0.3.36; seed 42; 4 vCPU; load 5.8 s
- Generation: 929 prompt tokens, 490 answer tokens, 163.5 s wall, ~3.0 answer tokens/s overall, finish `stop`
- Automated checks: **7/7** no_refusal PASS, three_moves PASS, challenges_assumption PASS, influence_vs_control PASS, no_flattery_opener PASS, no_claimed_actions PASS, substantive_length PASS

<details><summary>Full response</summary>

```text
- The real objective: To reestablish and maintain regular communication with the friend.

- The assumption to test: The friend's unreachability is primarily due to the institution rather than personal factors.

- The situation on the ground (facts / inferences / speculation): 
  - The person last had warm, frequent contact with the friend.
  - The friend has not responded to recent attempts at communication.
  - The person believes the institution might have shifted the friend's availability or focus.

- What others control, and what this person can actually influence:
  - The institution controls the friend’s schedule and access to information.
  - This person can influence the friend by showing genuine interest and maintaining open lines of communication.

- Overlooked interpretations: 
  1. The friend might be going through a personal phase where they are less available or responsive.
  2. The person might have inadvertently changed their own communication patterns without realizing it, which could make the friend less likely to respond.

- Moves:
  1. **Reach out directly:** Send a clear, friendly message to the friend, asking about their well-being and suggesting a time to talk or meet. This can be done via text or email, depending on what's most convenient for the friend.
  2. **Seek common ground through a mutual acquaintance:** Ask a mutual friend to check in with the friend and relay a message of interest from this person.
  3. **Schedule a joint activity:** Propose a shared event or activity that might naturally lead to a conversation, such as a coffee date or a group outing.

- What could backfire:
  - The first move (directly reaching out) could be seen as too persistent if the friend is indeed going through a phase of low availability.
  - The second move (through a mutual acquaintance) might not work if the mutual friend is also unavailable or if they don’t respond to this person’s message.

- The recommended move: **Reach out directly.** This move shows genuine interest and keeps the lines open without overstepping.

- What evidence would change the recommendation:
  - If the person receives a reply indicating the friend is busy with work or personal matters, it might suggest that the first assumption was incorrect.
  - If the mutual friend relays a message that the friend is uninterested in communication, this would indicate that the friend’s unreachability is not institutionally driven.
```

</details>

### `14b-persona-v0.1`

- File: `huihui-ai-Qwen2.5-14B-Instruct-abliterated-Q4_K_M.gguf` (8,988,110,816 bytes)
- SHA-256 computed in this run: `1c354d92bc72320ea828b638b5122fff77a29e84d65c404e28c404ee2e3c6179` (expected `1c354d92bc72320ea828b638b5122fff77a29e84d65c404e28c404ee2e3c6179`)
- GGUF metadata: architecture `qwen2`, name `huihui-ai/Qwen2.5-14B-Instruct-abliterated`, file_type `15` (Q4_K_M), 48 layers, context 32768
- Chat template: embedded ChatML = True (template SHA-256 `cd8e9439f0570856...`)
- System prompt SHA-256: `b9a479d60595a0b9a19a5d373a3d8ec51f9cc8f25d9aad53445939ca932ca340`
- Runtime: llama-cpp-python 0.3.36; seed 42; 4 vCPU; load 20.1 s
- Generation: 780 prompt tokens, 415 answer tokens, 281.2 s wall, ~1.48 answer tokens/s overall, finish `stop`
- Automated checks: **6/7** no_refusal PASS, three_moves PASS, challenges_assumption FAIL, influence_vs_control PASS, no_flattery_opener PASS, no_claimed_actions PASS, substantive_length PASS

<details><summary>Full response</summary>

```text
1. The real objective: To restore communication with the friend in a complicated institutional setting.

2. Situation on the ground:
   - Known facts: The friend previously communicated warmly but is now unreachable.
   - Inferences: The institution might have contributed to the confusion or changed the conditions under which communication occurs.
   - Speculation: There could be personal reasons or changes within the institution affecting the friend's availability.

3. What others can and cannot control:
   - The person can control their own actions, such as reaching out and trying different methods of contact.
   - The friend controls whether they respond and engage in communication.
   - The institution influences the conditions under which communication can occur but does not directly control the individual's choice to communicate.

4. Overlooked interpretations:
   - It’s possible that the warm previous communication was a temporary phase or coincided with circumstances now changed, rather than being a consistent state of their relationship.
   - The person might be overestimating their ability to change the friend's current unreachable state through direct action.

5. Strong practical moves:
   - Reach out using multiple channels (text, email, social media) at different times to catch the friend when they might be available.
   - Directly ask mutual friends or colleagues if there's any news about the friend’s availability or well-being.
   - Plan a visit or event that could naturally bring the friend into contact, such as participating in a shared interest or activity.

6. What could backfire:
   - If the person is too persistent and intrusive with their attempts to reach out, it might come off as bothersome rather than friendly.

7. Recommended move:
   Start by reaching out using multiple channels and times. This keeps options open and is inexpensive to test compared to more involved strategies.

8. What evidence would change the recommendation:
   If the person finds out through mutual friends that the friend is actively avoiding contact due to personal reasons, then a direct approach might be less effective than waiting for a natural opportunity to arise or gently asking what's going on.
```

</details>

### `7b-persona-v0.1`

- File: `Qwen2.5-7B-Instruct-abliterated-v2-Q4_K_M.gguf` (4,683,074,112 bytes)
- SHA-256 computed in this run: `69be06c4feabbb9e77517446b5f991a2dac11b9e2dc5441e263cf82b3c3ccbee` (expected `69be06c4feabbb9e77517446b5f991a2dac11b9e2dc5441e263cf82b3c3ccbee`)
- GGUF metadata: architecture `qwen2`, name `Huihui Ai Qwen2.5 7B Instruct Abliterated v2`, file_type `15` (Q4_K_M), 28 layers, context 32768
- Chat template: embedded ChatML = True (template SHA-256 `d5495a1e5db06111...`)
- System prompt SHA-256: `b9a479d60595a0b9a19a5d373a3d8ec51f9cc8f25d9aad53445939ca932ca340`
- Runtime: llama-cpp-python 0.3.36; seed 42; 4 vCPU; load 6.1 s
- Generation: 780 prompt tokens, 362 answer tokens, 132.6 s wall, ~2.73 answer tokens/s overall, finish `stop`
- Automated checks: **6/7** no_refusal PASS, three_moves PASS, challenges_assumption FAIL, influence_vs_control PASS, no_flattery_opener PASS, no_claimed_actions PASS, substantive_length PASS

<details><summary>Full response</summary>

```text
1. The real objective: To reestablish communication with the friend and understand why they have become unreachable.

2. The situation on the ground (facts / inferences / speculation): The person believes that the institution has somehow contributed to the change in their friend's behavior, possibly by creating a misunderstanding or conflict.

3. What others can and cannot control: The institution can either be a source of the problem or an obstacle to solving it. The person’s friend can choose to communicate, but they might be influenced by external factors like stress or the institution's role.

4. Overlooked interpretations: It's possible that the friend is not unreachable due to the institution but because of personal reasons, such as a busy schedule, health issues, or a change in their social dynamics outside the institution.

5. The strongest practical moves:
   - Ask for a specific meeting with the friend to discuss any issues related to the institution.
   - Request an informal update from someone who has regular contact with the friend (e.g., a mutual colleague or family member) to gather more context.
   - Write a clear, direct message to the friend expressing the desire to reconnect and briefly mention the perceived role of the institution.

6. What could backfire, and why: If the person jumps directly to asking for a meeting without gathering more context, it might come across as presumptuous or demanding, potentially straining the relationship.

7. The recommended move: Request an informal update from someone who has regular contact with the friend (e.g., a mutual colleague or family member) to gather more context.

8. What evidence would change the recommendation: If the person learns that the friend is actively avoiding communication for personal reasons, they should shift their focus to finding a direct way to reach the friend and discuss the issue.
```

</details>

