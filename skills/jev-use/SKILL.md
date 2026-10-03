---
name: jev-use
description: "Use before a step that is a decision, not writing: did a command, build or test run succeed (log, test output, build output); triaging or filtering MANY items (which of these files or grep hits matter, is it relevant, flaky vs real failures); waiting for a background process or dev server to be ready or stuck; checking a screenshot; or gating one risky command. Jev reads the file, log, process or image itself and returns a small typed verdict, so the data never enters your context. Take any verdict back with escalate. Never for writing text or code, deterministic checks (exit codes, exact strings, file existence), or options you cannot list."
---

# Handing off to Jev

Grep and Glob **find**. Read is for what you must **see to write**. Jev answers
questions about what you **don't need to see**: is it relevant, did it fail, is
it ready, what's on screen. Grep/Glob narrow, Jev filters by meaning, you Read
only the survivors.

## Hard rules

1. Never Read a file just to pass its contents to Jev. Use `source`.
2. Never poll a process with repeated `cat`/sleep. Call `jev_wait` once.
3. Never Read a screenshot just to check it. Pass `images: [path]`.
4. Never use Jev for what is deterministic: exit codes, exact-string matches,
   file existence. Use the shell or Grep.
5. Many items: narrow with Grep/Glob first, then ONE `jev_filter` call. Never
   one Jev call per item.
6. Batch every question about one state into one call.
7. Honour `escalate`: the `reason` tells you what to do (table below).

## Recipes

**Did the build or test run fail?** Judge the tail of the log.
```jsonc
jev_judge { "source": { "file": "build.log", "tail": 200 },
  "questions": [{ "id": "failed", "type": "noul", "question": "Did the build or tests fail?" }] }
```

**Triage test failures into flaky / real / infra.** `counts` comes back, plus the ids of items Jev could not place.
```jsonc
jev_filter { "file": "test.log", "each": "block",
  "choice": { "question": "What kind of failure is this?",
    "options": { "flaky": "passes on rerun", "real_failure": "a genuine bug", "infra": "network, disk, timeout" } } }
```

**Which of these grep hits matter?** `grep -l X`, then rank, then Read the top few.
```jsonc
jev_filter { "paths": ["src/a.ts", "src/b.ts"], "question": "Does this file handle session expiry?",
  "return": "ranked", "top_k": 5 }
```
For "does this file contain X" add `"excerpt": { "grep": "X", "context": 5 }`.

**Wait for the dev server to be ready.** Start it with background Bash, then once:
```jsonc
jev_wait { "output_file": "<background task output file>", "pid": 1234,
  "until": "Is the server listening and ready for requests?",
  "fail_if": "Has it crashed or hit a fatal error?" }
```
`status`: 1 ready, 2 failed, 3 exited (check `outcome`), 0 timeout (still running: call again), 4 escalate.

**Is the long job stuck?** Add `"idle_s": 60`: after that much silence Jev is asked whether it finished or is stuck. With only `pid` it is a free is-it-alive wait that never calls Jev.

**Screenshot check.** Paths only; you never see pixels.
```jsonc
jev_judge { "images": ["shot.png"],
  "questions": [{ "id": "error", "type": "noul", "question": "Is an error overlay visible?" }] }
```
Needs `JEV_VISION_MODEL=clef-flash`. Images are not redacted: with a remote backend a screenshot leaves the machine as-is.

**Gate one risky command.** `jev_gate { "state": "...", "tool": "Bash", "input": "rm -rf build/" }` for a one-off. If every tool call needs gating, wire the `jev-use hook gate` PreToolUse hook once instead: the decision leaves the conversation for good.

## Escalation reasons

| `reason` | Meaning | Do this |
| --- | --- | --- |
| `unsure` | Answer is only a prior (still in `answer`) | Use it as a hint, decide yourself |
| `oversized` | State too big for the model | Narrow with `tail`/`lines`/`grep`, or filter first |
| `no_vision` | Model or backend cannot read images | Set `JEV_VISION_MODEL=clef-flash` (not openrouter/vercel), or look yourself |
| `unreachable` | Jev is down | Proceed as if Jev did not exist |
| `writing` / `open_ended` | Structurally yours | Do it yourself |

`jev_filter`: ids in `escalated` are items Jev was unsure of; `skipped` are
unreadable or binary. Look at both yourself. A path outside the allowed roots
fails the whole call (`JEV_ALLOW_PATHS` widens it). At most 500 items.

## Model notes

- **nimble** (local): 8k-token window shared by state and the whole question
  set, so keep slices tight (`tail`, `grep`+`context`) and questions few.
- **clef-flash**: use for images and long states. Set `JEV_VISION_MODEL` so
  calls with `images` route to it without a `model` argument.
- `JEV_CONTEXT_TOKENS` overrides the window for unknown models.

---

## Background

Jev answers in ~250 ms at a judgment-model rate ($0.042/Mtok in, $0 out). It is
a RATE win, not a token win: Jev spends more tokens per decision, so the saving
is real only when the decision **leaves the conversation**. That is why data
goes by reference.

| Where the facts are | Nothing blocked | Blocked until decided |
| --- | --- | --- |
| **In your context** | `jev_judge`, all questions in ONE call | `jev_gate`; or the PreToolUse hook (24 gated commands, 17.1 s, zero LLM tokens, vs 46.9 s / $0.2366 through a supervisor LLM) |
| **In a file, log, process or image** | `jev_judge` `source`/`images`, `jev_filter`, `jev_wait` | same tools, then act on the verdict |
| **To be written by you** | yours | yours |

Measured: 12 questions in ONE call took 224 ms; one at a time, 2,662 ms.
`jev_filter` over 26 files (126 KB) returned 510 B. A screenshot costs ~1,360
tokens to Read, per read and on every later turn; the verdict is ~300 chars.
Argument shapes and results: `docs/reference.md`. Numbers and caveats:
`bench/RESULTS.md`.
