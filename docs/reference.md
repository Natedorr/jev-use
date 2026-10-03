# Reference

<img src="../assets/loop.svg" alt="The loop sends state and typed questions to Jev; verdicts come back with confidence; escalations wake the LLM; generated results rejoin the loop" width="100%">

## `jev_judge`

Batch every question about one state into one call — latency is flat in
question count ([measured](https://github.com/Nyarlathoteppppp/pi-heed/blob/main/EXPERIMENTS.md):
1/4/8 questions ≈ 274 ms median), and cost amortizes across the shared state.

| Param | Type | Notes |
| --- | --- | --- |
| `state` | string, optional | everything Jev may consider — facts, tool output, file excerpts (≤ ~30k tokens). Never Read a file just to paste it: use `source` |
| `source` | `{file, head?, tail?, lines?, grep?, context?}`, optional | a file the server reads and judges, so it never enters your context. `lines` is an inclusive range (`"120-180"`); `grep` is a regex, `context` the lines around each hit. Relative paths resolve against the client's MCP roots; `JEV_ALLOW_PATHS` widens them. With `state`, `state` frames the source |
| `images[]` | paths, optional, ≤ 8 (each ≤ 32 MB) | screenshots for Jev to look at. Paths only, never base64. Needs a vision model (`JEV_VISION_MODEL`); not redacted, and they leave the machine on a remote backend |
| `questions[]` | array | each: `{id?, type, question, options?, levels?, criteria?}` |
| `questions[].type` | `noul` \| `choice` \| `score` | noul = probability a statement is true; choice = pick one enumerated option; score = position on an ordered list of levels |
| `questions[].options` | choice only | ≥ 2 labels, or a `label → meaning` map |
| `questions[].levels` | score only | ≥ 2 ordered level descriptions |
| `questions[].criteria` | noul only, optional | `{true, false}` meanings, to sharpen calibration |
| `confidence_threshold` | number, default per confidence source — `0.5` reported, `0.4` estimated | verdicts below it escalate |
| `model` | string, optional | backend model override |

```jsonc
// input
{
  "state": "CI run #142: build ok, 214 tests passed, 0 failed; 1 test quarantined as flaky last week",
  "questions": [
    { "id": "passed", "type": "noul",   "question": "Did the run fully succeed?" },
    { "id": "next",  "type": "choice", "question": "Next action?",
      "options": { "merge": "everything green", "rerun": "looks flaky", "hold": "needs attention" } },
    { "id": "risk",  "type": "score",  "question": "How risky is merging now?",
      "levels": ["routine", "worth a look", "incident"] }
  ]
}
```

```jsonc
// result (shape exact, values illustrative)
{
  "verdicts": [
    { "id": "passed", "type": "noul",   "answer": 0.97, "confidence": 0.94,
      "confidenceFrom": "estimated", "escalate": false },
    { "id": "next",  "type": "choice", "answer": "merge", "confidence": 0.34,
      "confidenceFrom": "reported", "escalate": true,
      "reason": "unsure", "distribution": { "merge": 0.55, "rerun": 0.41, "hold": 0.04 },
      "hint": "Jev answered (merge) at reported confidence 0.34 < 0.5. Treat the answer as a prior, not a decision — reason it out yourself." },
    { "id": "risk",  "type": "score",  "answer": 0.8, "confidence": 0.81,
      "confidenceFrom": "reported", "escalate": false,
      "distribution": { "0": 0.35, "1": 0.5, "2": 0.15 },
      "legend": { "0": "routine", "1": "worth a look", "2": "incident" } }
  ],
  "escalated": true,
  "backend": "typesafe",
  "latencyMs": 187
}
```

### Question grammar and model compatibility

Not every model can emit an array argument, and Ollama's `/v1/systemone` spells
questions differently from jev-use. `questions` is therefore normalized
(`normalizeQuestions` in `src/protocol.ts`) before screening, so all of these
are equivalent and answered with one verdict per question:

| Sent as | Example |
| --- | --- |
| array (canonical) | `[{"type":"noul","question":"Did it pass?"}]` |
| one question object | `{"type":"noul","question":"Did it pass?"}` |
| JSON string of either | `"[{\"type\":\"noul\",\"question\":\"Did it pass?\"}]"` |
| `id -> question` map (Ollama shape) | `{"passed":{"type":"noul","instructions":"Did it pass?"}}` |

Aliases accepted inside a question: `instructions` for `question`;
`criteria` as the options of a `choice` (label -> meaning, `null` = the label
describes itself) or the levels of a `score` (array); and the type spellings
`yes_no`/`boolean`, `pick`/`select`, `rate`/`scale`. Anything that still does not
fit the grammar below is rejected, or escalated as `open_ended`.

```
questions := [question, ...]                    (>= 1)
question  := { type: "noul",   question, criteria?: {true, false} }
           | { type: "choice", question, options: [label, ...] | {label: meaning} }   (2..26)
           | { type: "score",  question, levels: [level, ...] }                       (2..26, ordered)
           each with optional id
```

Models that cannot do arrays should send one question per call, or a JSON string
of the array. Per-model limits (question count, options, vision) live in
`src/models.ts`.

A score `answer` is the distribution's expected position on your levels —
`0.8` means "between *routine* and *worth a look*, closer to the latter";
`legend` maps indices back to your words.

## `jev_gate`

One proposed action, one risk check.

| Param | Type |
| --- | --- |
| `state` | string — current task context |
| `tool`, `input` | the action, verbatim |
| `description` | optional intent |
| `confidence_threshold` | default per confidence source (`0.5` reported / `0.4` estimated) |

Returns `{decision: allow | deny | escalate, confidence, confidenceFrom, hint}` — one
allow/deny `choice` under the hood, `escalate` when confidence falls below
the threshold. **`allow` stays silent and falls through to your normal
permission flow — the gate can never grant anything, only deny or ask — and a
provider that is down escalates to `ask` with the reason `unreachable`, never
to `allow`.**

The action is the one part of the judged state you did not write, so its
credentials are redacted before the call ([src/redact.ts](../src/redact.ts)):
URL passwords, auth and cookie headers, `-u user:pass`, `--token=`/`SECRET=`
values, and known key shapes become `[redacted]`. Everything the answer
depends on — the tool, the flags, the host, the path — is sent as-is, and a
value that is only a reference (`$GITHUB_TOKEN`) is left alone. What the
removal costs the verdict is measured in [bench/RESULTS.md](../bench/RESULTS.md). As a PreToolUse hook it spends zero LLM
tokens on the allow path (a deny/ask feeds its reason back to the model —
that is the point) and adds one ~100 ms round trip per gated call, so scope
the matcher to tools worth gating.

## `jev_filter`

Judge many items against one question on the server; only the survivors come back.
Use it after Grep/Glob: `Grep -l` → `jev_filter` → Read the matches.

| Param | Type | Notes |
| --- | --- | --- |
| `paths` / `glob` / `file`+`each` / `grep_output` | exactly one | explicit files · glob (honours `.gitignore`) · one file split into `line`, `jsonl` or `block` items · a saved `grep -n` output, one item per hit |
| `question` / `choice` | exactly one | `question`: yes/no per item. `choice`: `{question, options}`, one option per item, counted |
| `excerpt` | optional | what Jev sees of each *file* item: `{head, tail, lines, grep, context}` (default first 80 lines). Ignored for `file`+`each` and `grep_output` |
| `return` | `matches`, `ranked` or `counts` | default `matches` for `question` (input order), `counts` for `choice` |
| `min_p`, `top_k` | optional | `matches` keeps `p >= min_p` (default 0.5); `ranked` defaults to `top_k` 20 |
| `model` | optional | backend model override |

At most 500 items per call (narrow with Grep/Glob first). Item ids: the path for
file items, `file#N` for `each` items, `path:line` for `grep_output`.

```jsonc
// result: one of
{ "matches": ["src/session.ts"], "judged": 26, "escalated": [], "skipped": [{ "item": "a.bin", "why": "binary" }] }
{ "ranked": [{ "item": "src/session.ts", "p": 0.93 }], "judged": 26, "escalated": [] }
{ "counts": { "flaky": 3, "real_failure": 1 }, "examples": { "flaky": ["test.log#2"] }, "judged": 4, "escalated": [] }
```

`escalated` lists ids Jev was unsure of (not in `matches`): look at them yourself.
`skipped` holds unreadable or binary items; a path outside the allowed roots fails
the whole call. Measured (nimble, 26 files, 125,960 B): 33.5 s, 510 B back.

## `jev_wait`

Block until a background process is ready, failed or gone. Liveness is checked
locally and for free; Jev is asked only when new output appears. Attach only: it
never spawns a process.

| Param | Type | Notes |
| --- | --- | --- |
| `output_file` | string | the background task's output file |
| `pid` | integer | liveness check. With only `pid` and no questions it never calls Jev |
| `until` | string | yes/no question for "ready" |
| `fail_if` | string | yes/no question for "failed" |
| `timeout_s` | number | default 120, max 600 |
| `tail` | integer | lines of output Jev sees per check, default 150 |
| `idle_s` | number | without a pid: seconds of silence before Jev is asked whether it finished or is stuck, default 30 |
| `model` | string | backend model override |

Result `{status, label, alive?, waited_s, checks, outcome?, hint?}`:

| `status` | `label` | Meaning |
| --- | --- | --- |
| 1 | ready | `until` matched |
| 2 | failed | `fail_if` matched |
| 3 | exited | the process is gone; `outcome` is `success`, `failure` or `unclear` |
| 0 | timeout | still running: call again |
| 4 | escalate | Jev was unsure and nothing clearer followed, or it could not tell whether a silent process finished: read the output yourself |

Precedence on a check: `fail_if` > `until` > `exited` > `escalate`.

## Models

| Model | Context | Images | Notes |
| --- | --- | --- | --- |
| hosted `jev-*` | 64k (≤ 30k state) | no | the default |
| `nimble` (local) | 8,192, shared by state and the whole question set | no | ≤ 64 questions, ≤ 26 options, 64 KB body; keep slices tight |
| `clef`, `clef-flash` | as hosted | yes | ≤ 64 questions, ≤ 26 options; route images here with `JEV_VISION_MODEL`. No body limit found on local Ollama; the server refuses images over 32 MB and more than 8 per call |

The table lives in `models.json` at the package root, matched by longest model
name prefix. To add a model or change a number, drop a file of the same shape at
`~/.config/jev-use/models.json` (or point `JEV_MODELS_FILE` at one); its entries
merge over the bundled ones field by field, so you only restate what changes:

```json
{ "models": { "my-model": { "contextTokens": 4096, "vision": true, "maxQuestions": 1 },
              "nimble":   { "maxQuestions": 8 } } }
```

Fields: `contextTokens`, `maxQuestions`, `maxOptions`, `maxBodyBytes`, `vision`,
`questionSetInPrompt`; omit a limit for none. Unknown fields are ignored, and a
broken file is skipped. The `JEV_VISION`, `JEV_MAX_*` env settings below still
win over the file.

Unknown models get the hosted defaults; `JEV_CONTEXT_TOKENS` overrides their
window. OpenRouter and Vercel backends cannot take images and return `no_vision`.

## The verdict contract

Every verdict:
`{id, type, answer, confidence, confidenceFrom, escalate, reason?, hint?, distribution?, legend?}`.
`reason`/`hint` appear exactly when `escalate` is true; `distribution`/`legend`
whenever the provider returns them; `confidenceFrom` whenever the question
actually reached Jev.

| reason | when | meaning |
| --- | --- | --- |
| `writing` | pre-call | the step must produce new text/code — structurally the LLM's |
| `open_ended` | pre-call | not expressible as noul/choice/score (nothing to enumerate) |
| `oversized` | pre-call | the state exceeds ~30k tokens — shrink it or take the questions over |
| `no_vision` | pre-call | `jev_judge` got `images` but the model or backend cannot read them — set `JEV_VISION_MODEL=clef-flash` (typesafe backend only) |
| `unsure` | post-call | answer too flat to act on; it stays in `answer` as a prior |
| `unreachable` | on failure | Jev unreachable — proceed as if it didn't exist |

Pre-call reasons come from a deterministic router (no request spent); each
handback is a normal verdict with a hint, never an exception.

**What the `confidence` scalar is, and where it came from.** Every verdict
says so itself, in `confidenceFrom`:

| `confidenceFrom` | who produced it | escalates below |
| --- | --- | --- |
| `reported` | Jev's own confidence head, returned for `choice` and `score` answers | `0.5` |
| `estimated` | jev-use, from the answer's own distribution: top-minus-runner-up for `choice`/`score`, `2·\|p − 0.5\|` for `noul` | `0.4` |

`noul` answers carry no reported confidence from any provider, so they are
always `estimated`; one batch mixing `check` with `pick`/`rate` therefore comes
back part reported, part estimated, and each verdict is judged against its own
number. Through the Vercel gateway the head arrives out-of-band in
`providerMetadata.typesafe.confidence`, keyed by question id.

The two are the same scale read two ways, measured over 318 live
choice/score answers ([bench/RESULTS.md](../bench/RESULTS.md)): on a
two-option question they agree to the wire's 2-decimal rounding, and on
three or more the margin reads a median `0.05` (up to `0.17`) lower, because
it also subtracts however the losing mass splits. Hence the lower bar for
the estimate. An explicit `confidence_threshold` covers every verdict
whatever its source, and always wins.

## Library

```js
import { Jev, check, pick, rate } from "jev-use";

const jev = new Jev();                 // backend resolved from the environment

const { answers, verdicts } = await jev.judge(state, {
  next: pick("Next action?", { merge: "all green", rerun: "looks flaky", hold: "needs attention" }),
  risk: rate("How risky?", ["routine", "worth a look", "incident"]),
  passed: check("Did the run fully succeed?"),
});
answers.next;   // { answer: "merge", confidence: 0.93, confidenceFrom: "reported", escalate: false }

const verdict = await jev.gate(state, { tool: "Bash", input: { command } });
verdict.decision;   // "allow" | "deny" | "escalate"
```

Both halves of the handoff are in the surface. Before writing a question,
`route` says whether the step is Jev-shaped at all — no client, no key, no
call:

```js
import { route } from "jev-use";

route({ producesContent: true, enumerable: true });    // { to: "llm", reason: "writing" }
route({ producesContent: false, enumerable: false });  // { to: "llm", reason: "open_ended" }
route({ producesContent: false, enumerable: true });   // { to: "jev" }
```

After the call, every answer carries the other half — `escalate`, `reason`,
`hint`, and Jev's answer kept as a prior ([the table above](#the-verdict-contract)).

The three builders write the three primitives — `check` → `noul`, `pick` →
`choice`, `rate` → `score` — and the wire vocabulary stays exactly that.
`answers` is keyed by the names you asked under; `verdicts` is the same
verdicts in the order you asked them, alongside `escalated`, `backend`,
`model`, `latencyMs` and `usage`.

`new Jev({ backend: "mock" })` judges with no key at all, and
`new Jev({ backend: myBackend })` takes any `JevBackend` (tests, custom
transports). Defaults set on the client — `confidenceThreshold`, `model` —
are overridable per call: `jev.judge(state, questions, { model })`.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `JEV_BACKEND` | auto-detect | `typesafe` \| `openrouter` \| `vercel` \| `mock` |
| `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` | — | provider credential; auto-detected in this order |
| `JEV_MODEL` | provider default (`jev-latest`) | model override |
| `JEV_VISION_MODEL` | — | model used when a `jev_judge` call has `images` and names no `model` (e.g. `clef-flash`) |
| `JEV_CONTEXT_TOKENS` | model profile | context window for a model jev-use has no profile for |
| `JEV_MODELS_FILE` | `~/.config/jev-use/models.json` | extra or overriding model profiles, merged over the bundled `models.json` |
| `JEV_VISION` | model profile | `on` \| `off`: force whether the model can read images, for a model the profile has wrong or does not know |
| `JEV_MAX_QUESTIONS` | model profile (64 on Ollama models) | questions per call; `1` forces one question per call, and extras come back as `oversized` to send again |
| `JEV_MAX_OPTIONS` | model profile (26; 24 for tev1) | options per choice or score question |
| `JEV_MAX_BODY_BYTES` | model profile | largest request body the server accepts |
| `JEV_QUESTIONS_INPUT` | `any` | how `jev_judge` advertises `questions` to the calling model: `any` (array, one question, JSON string or id map), `array`, `single` (one question object), or `string` (a JSON string). Use a single plain shape for models whose tool-calling chokes on unions; every spelling is still accepted |
| `JEV_ALLOW_PATHS` | — | extra directories (platform path delimiter) that `source`, `images`, `jev_filter` and `jev_wait` may read, beyond the client's MCP roots |
| `JEV_FILTER_CONCURRENCY` | `4` | parallel Jev calls inside one `jev_filter` |
| `JEV_GATE_THRESHOLD` | per confidence source (`0.5` / `0.4`) | hook-gate escalation threshold, for both sources at once |

Provider dialects: TypeSafe and OpenRouter share the native wire shape
(OpenRouter's `decisions` endpoint is alpha and may move), carrying
`confidence` on the answer itself; Vercel's gateway renames `noul`→`boolean`,
moves the model into a header, drops the `legend` echo, and relays the
confidence head in `providerMetadata.typesafe.confidence` instead — a map keyed
by question id, with `boolean` answers absent from it. All three are normalized
by the adapters, provenance included; wire shapes are
pinned by fixture tests against documented formats — `jev-use doctor` is the
live check.

## CLI

```
jev-use install [claude|codex|pi]   wire the server into your harness via its own CLI (all found, if no target)
jev-use serve                 stdio MCP server
jev-use hook gate             PreToolUse hook adapter (Claude Code / Codex)
jev-use judge ['{...}']       one-shot JudgeRequest from argv or stdin
jev-use doctor                backend resolution + one live round trip + vision model check
```
