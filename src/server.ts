/**
 * The MCP surface. Only `tools` are used — the one MCP primitive every
 * major harness (Claude Code, Codex CLI, Cursor, Gemini CLI, VS Code,
 * pi) supports — so jev-use works anywhere MCP does. The handoff-return
 * leg is expressed entirely in tool RESULTS (`escalate` + `reason`),
 * never as a server-initiated callback.
 *
 * The tools call the engine directly rather than the `Jev` client: the
 * client's extra `answers` map would duplicate every verdict in a payload an
 * LLM pays for, and a tool result is exactly the ordered `JudgeResult`.
 *
 * Each tool lives in its own `tools/` module; this file only wires them up.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { effectiveEnv } from "./config.js";
import type { JevBackend } from "./backends/types.js";
import { registerFilter } from "./tools/filter.js";
import { registerGate } from "./tools/gate.js";
import { registerJudge } from "./tools/judge.js";
import type { ToolContext } from "./tools/context.js";

export const SERVER_NAME = "jev-use";
export const SERVER_VERSION = "0.8.0";

/** Build the MCP server: its tools over one already-resolved backend. */
export function createServer(
  backend: JevBackend,
  options: { root?: string; env?: Record<string, string | undefined> } = {},
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const fallback = options.root ?? process.cwd();
  let cached: string[] | undefined;
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    cached = undefined;
  });
  /**
   * The client's roots when it offers them, else the launch directory. Asked
   * lazily — the handshake must be done — and cached until the client says
   * they changed. A failed ask falls back without caching.
   */
  const listRoots = async (): Promise<string[]> => {
    if (cached) return cached;
    if (!server.server.getClientCapabilities()?.roots) return (cached = [fallback]);
    try {
      const { roots } = await server.server.listRoots();
      const paths = roots.filter((r) => r.uri.startsWith("file:")).map((r) => fileURLToPath(r.uri));
      return (cached = paths.length > 0 ? paths : [fallback]);
    } catch {
      return [fallback];
    }
  };
  const ctx: ToolContext = {
    backend,
    root: fallback,
    listRoots,
    env: options.env ?? effectiveEnv(),
  };
  registerJudge(server, ctx);
  registerGate(server, ctx);
  registerFilter(server, ctx);
  return server;
}
