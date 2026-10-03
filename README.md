# jev-use

**English** | [简体中文](README.zh-CN.md)

The best way for Claude Code, Codex, and [pi](https://github.com/badlogic/pi-mono)
to work with [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev):
hand the tasks that need no text output to Jev — faster steps, fewer
tokens, tasks done sooner and better.

It makes the LLM and Jev true collaborators: when content needs to be
written, the LLM takes over; when a step just needs a fast decision, Jev
executes it.

## Demos — real runs, 1× speed

<table>
<tr>
<td width="50%" valign="top"><b>Directions task: Jev clicks, the LLM types</b> — 10 decisions (p50 274 ms) · 4 writes; Jev rejects a wrong route, the LLM rewrites<br><img src="assets/collab.gif" alt="OpenStreetMap directions: Jev picks controls in green, the LLM types the locations in blue; a wrong 1809km geocode is rejected by Jev and repaired by the LLM, ending on the real 3.7km walking route" width="100%"></td>
<td width="50%" valign="top"><b>Context compaction</b> — 200 messages judged in 7 calls, one LLM paragraph replaces the dropped pile; recall 3/3<br><img src="assets/compact.gif" alt="A real transcript fills the context window to 94%; Jev tints each message keep or drop, the LLM's summary paragraph replaces the dropped block, the window falls to 44% and three recall checks pass" width="100%"></td>
</tr>
<tr>
<td width="50%" valign="top"><b>Pong: ball speed = decision latency</b> — 86 Jev decisions in 20 s vs 6 (haiku) and 3 (gemini) called the usual way; enum-constrain both and the gap is 3×<br><img src="assets/pong.gif" alt="Three Pong lanes replaying a live run at 1x: the Jev ball sweeps the field at ~224ms per decision while the LLM balls crawl" width="100%"></td>
<td width="50%" valign="top"><b>Gate every shell command</b> — dangerous ones denied in ~230 ms with a reason, zero LLM tokens<br><img src="assets/gate.gif" alt="A 24-command dev session gated at 1x: dangerous commands denied at confidence 1.00, benign ones allowed" width="100%"></td>
</tr>
</table>

Every demo is a rerunnable script in [bench/examples/](bench/examples);
all numbers, methodology, variance and caveats:
[bench/RESULTS.md](bench/RESULTS.md) · third-party measurements:
[docs/evidence.md](docs/evidence.md).

## Install

```bash
npx -y jev-use install    # wires Claude Code, Codex, and pi — whichever it finds
```

Set one key in the environment your agent runs in (`JEV_BACKEND=mock` for
a keyless dry run):

| Provider | Env var |
| --- | --- |
| [TypeSafe direct](https://typesafe.ai/) | `TYPESAFE_API_KEY` |
| [OpenRouter](https://openrouter.ai/typesafe/jev-1.13) | `OPENROUTER_API_KEY` |
| [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev) | `AI_GATEWAY_API_KEY` |

`npx -y jev-use doctor` checks the wiring. Judged state goes to the
provider you configure; `JEV_BACKEND=mock` stays local. Plugin form with
the routing skill and the PreToolUse gate:
[harness/claude-code](harness/claude-code/README.md) ·
[harness/codex](harness/codex/README.md).

## Configuration

The MCP server also reads `~/.config/jev-use/config.json` (flat keys named
after the env vars):

```json
{
  "JEV_BACKEND": "typesafe",
  "TYPESAFE_BASE_URL": "https://api.example.com",
  "JEV_MODEL": "your-model",
  "TYPESAFE_API_KEY": "your-key",
  "JEV_TIMEOUT_MS": "60000"
}
```

Precedence: real environment variables > config file > code defaults.
A missing or broken file is ignored. This matters for SDK-launched agents
that don't inherit the agent's process env (Claude Code subagents, Codex
SDK, headless runners) — the file fills what the environment lost.
`JEV_TIMEOUT_MS` caps each attempt; default 60 s, since small models on
local Ollama can need ~30 s cold load on the first call. For pi, the same
env block goes in the `mcp.json` server entry — see
[harness/pi-mcp](harness/pi-mcp/README.md).

## Four tools, by reference

Jev does not replace Grep, Glob or Read. Grep/Glob find, Read is for what you
must see to write, and Jev answers questions about what you don't need to
see — so the data never enters your context:

| Tool | Use it for |
| --- | --- |
| `jev_judge` | typed questions about one state; `source` reads a file or log tail, `images` checks a screenshot |
| `jev_filter` | many files, grep hits or log blocks ranked or counted by one question |
| `jev_wait` | one call that waits for a background process to be ready, failed or gone |
| `jev_gate` | one risky action; for every call, use the PreToolUse hook |

The bulk pattern: **Grep narrows → `jev_filter` ranks by meaning → Read only the
survivors.** Screenshots go by path (`JEV_VISION_MODEL=clef-flash`) and are not
redacted, so with a remote backend they leave the machine as-is.

## Use as a library

`npm i jev-use` — zero runtime dependencies on the judgment path:

```js
import { Jev, check, pick, rate } from "jev-use";

const jev = new Jev();

const { answers } = await jev.judge(state, {
  next: pick("Next action?", { merge: "all green", rerun: "looks flaky", hold: "needs attention" }),
  risk: rate("How risky?", ["routine", "worth a look", "incident"]),
  passed: check("Did the run fully succeed?"),
});
// answers.next → { answer: "merge", confidence: 0.93, confidenceFrom: "reported", escalate: false }
```

Anything Jev can't or shouldn't decide comes back with `escalate: true`
and a typed reason. Tools, verdict shape, escalation contract, CLI:
[docs/reference.md](docs/reference.md).

## Small enough to read

| File | Job |
| --- | --- |
| [src/protocol.ts](src/protocol.ts) | Questions (`check`/`pick`/`rate`), verdicts, escalation reasons |
| [src/dispatch.ts](src/dispatch.ts) | Pre-call routing: what never reaches Jev |
| [src/judge.ts](src/judge.ts) | screen → backend → hand back what is unsure; `gate` |
| [src/jev.ts](src/jev.ts) | The `Jev` client over that engine |
| [src/redact.ts](src/redact.ts) | Credentials stripped from a gated action before it is sent |
| [src/backends/](src/backends) | TypeSafe, OpenRouter, Vercel, mock adapters |
| [src/server.ts](src/server.ts) | The two MCP tools |
| [src/cli.ts](src/cli.ts) | `install`, `serve`, `hook gate`, `doctor` |
| [skills/jev-use/SKILL.md](skills/jev-use/SKILL.md) | The routing rules the agent follows |

## Development

```console
$ npm run typecheck && npm test    # unit tests incl. per-provider wire fixtures
$ npm run smoke                    # real MCP client ↔ built CLI over stdio
$ node bench/run.mjs               # micro-benchmarks, your key and region
```

Substantially written with Claude Code (AI-assisted).

MIT © [shitianfang](https://github.com/shitianfang)
