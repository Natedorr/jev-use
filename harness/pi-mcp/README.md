# Jev for pi (MCP route)

pi loads MCP servers from `~/.pi/agent/mcp.json` via the `pi-mcp-adapter`
package (add `npm:pi-mcp-adapter` to `packages` in `~/.pi/agent/settings.json`).
Register the jev server there:

```json
{
  "mcpServers": {
    "jev": {
      "command": "node",
      "args": ["/abs/path/to/jev-use/dist/cli.js", "serve"],
      "env": {
        "JEV_BACKEND": "typesafe",
        "TYPESAFE_BASE_URL": "https://api.typesafe.ai",
        "JEV_MODEL": "jev-latest",
        "TYPESAFE_API_KEY": "***"
      }
    }
  }
}
```

The adapter exposes the tools as `mcp_<server>_<tool>` (i.e.
`mcp_jev_jev_judge`, `mcp_jev_jev_gate`), or bare names when the adapter
prefix is set to empty — both are accepted.

## Why MCP instead of the extension

`harness/pi/jev-use.ts` registers the same tools in-process when the
build directory (or the published package) is listed in `settings.json`
`packages`. Both routes work, but they should not be combined: with both
active the tools appear twice. Pick one.

The MCP route is the better default:

- The server env block is per-harness data, like the claude (`mcpServers`
  in `~/.claude.json`) and codex (`[mcp_servers.jev]` in
  `~/.codex/config.toml`) configurations — change the backend by editing
  JSON, not source.
- A child process isolates backend failures; the main agent stays responsive.
- No build-dir package registration to survive `pi update` / reinstalls.

If you do use the extension route, keep the build directory as a pi
package and skip this folder.

## No env? Use the config file

`dist/cli.js serve` resolves the backend from environment variables, and
from `~/.config/jev-use/config.json` when env is absent — env always wins.
That matters for SDK-launched agents, where process env can be lost:

```json
{
  "JEV_BACKEND": "typesafe",
  "TYPESAFE_BASE_URL": "http://your-llm-host:PORT",
  "JEV_MODEL": "your-model",
  "TYPESAFE_API_KEY": "***"
}
```

Keep it mode 600. `jev-use doctor` prints which source (env or file) won.
