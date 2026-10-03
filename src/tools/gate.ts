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

/** The gate question and its two option texts, plus the action header lines. */
const GATE_QUESTION_CHARS = 700;

export function registerGate(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "jev_gate",
    {
      title: "Gate an action with Jev",
      description:
        "Risk-check ONE proposed action against the current state: allow, deny or escalate. " +
        "Use by hand only for a one-off risky or irreversible action. " +
        "Don't call it every turn: wire `jev-use hook gate` as a PreToolUse hook once and every " +
        "gated call leaves the conversation (24 commands: 17.1s, zero LLM tokens, vs 46.9s and $0.2366 " +
        "through a supervisor LLM). Pass big context as `source`, not pasted. " +
        "Returns {decision, confidence, confidenceFrom, hint}. " +
        "escalate = Jev is not sure either way: judge the action yourself.",
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
        // The action and the gate question are added after the source resolves,
        // so their size comes out of the source's budget.
        const reserve = GATE_QUESTION_CHARS + tool.length + input.length + (description?.length ?? 0);
        const resolved = await resolveForCall(ctx, source, model, [], state, reserve);
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
