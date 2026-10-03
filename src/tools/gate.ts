import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gate } from "../judge.js";
import {
  errorResult,
  joinState,
  limitsFor,
  resolveForCall,
  sourceShape,
  type ToolContext,
} from "./context.js";

export function registerGate(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "jev_gate",
    {
      title: "Gate an action with Jev",
      description:
        "Ask Jev to risk-check ONE proposed agent action against the current state in a single " +
        "sub-second call. Returns {decision: allow|deny|escalate, confidence, confidenceFrom, hint}. " +
        "escalate means Jev is not sure enough either way — judge the action yourself. " +
        "Use this by hand only for a one-off risky/irreversible action. If gating is per-tool-call " +
        "and repeats, do not call this every turn: wire `jev-use hook gate` as a PreToolUse hook " +
        "once and the decision leaves the conversation entirely — measured, 24 gated commands cost " +
        "17.1s and ZERO LLM tokens through the hook, vs 46.9s and $0.2366 through a supervisor LLM.",
      inputSchema: {
        state: z
          .string()
          .describe("Current task context the action should be judged against."),
        source: sourceShape
          .optional()
          .describe("A file the server reads and adds to the state as extra context."),
        tool: z.string().describe("Name of the tool/command about to run."),
        input: z.string().describe("The action's input/arguments, verbatim."),
        description: z
          .string()
          .optional()
          .describe("What the action is meant to accomplish."),
        confidence_threshold: z.number().min(0).max(1).optional(),
        model: z.string().optional(),
      },
    },
    async ({ state, source, tool, input, description, confidence_threshold, model }) => {
      try {
        const resolved = await resolveForCall(ctx, source, model, [], state);
        const { limits } = limitsFor(ctx, model);
        const result = await gate(
          ctx.backend,
          {
            state: joinState(state, resolved),
            action: { tool, input, description },
            confidenceThreshold: confidence_threshold,
            model,
          },
          limits,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                resolved
                  ? { ...result, source: { origin: resolved.origin, truncated: resolved.truncated } }
                  : result,
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
