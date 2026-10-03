import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { judge } from "../judge.js";
import {
  ESTIMATED_CONFIDENCE_THRESHOLD,
  REPORTED_CONFIDENCE_THRESHOLD,
} from "../protocol.js";
import {
  errorResult,
  joinState,
  limitsFor,
  questionShape,
  resolveForCall,
  sourceShape,
  type ToolContext,
} from "./context.js";

export function registerJudge(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "jev_judge",
    {
      title: "Batch fast judgments with Jev",
      description:
        "Hand a batch of quick judgment questions to Jev (TypeSafe AI's System One model): " +
        "a typed verdict in a few hundred milliseconds, at a judgment-model rate instead of " +
        "LLM reasoning. " +
        "Use it whenever the next step is a JUDGMENT over facts you ALREADY have in context — did X " +
        "succeed, which option next, how good is Y — not a generation. Batch every question you " +
        "have about one state into ONE call (batching is where the speedup comes from). " +
        "If the data to judge is sitting in a file, pass `source` instead of `state` so the server " +
        "reads it and the data never passes through this conversation. " +
        "Do NOT use it for anything that needs new text/code written, or choices whose options you " +
        "cannot enumerate — that work is yours. " +
        "Each verdict returns {answer, confidence, confidenceFrom, escalate, reason, hint}. " +
        "confidenceFrom says where the number came from: \"reported\" = Jev's own confidence head, " +
        "\"estimated\" = worked out by jev-use from the answer's distribution. escalate=true means the " +
        "question is handed back to you: writing/open_ended = structurally yours, " +
        "oversized = the state is too big to judge, " +
        "unsure = Jev's answer is only a prior (it is still included) — decide yourself, " +
        "unreachable = Jev is down, proceed without it.",
      inputSchema: {
        state: z
          .string()
          .optional()
          .describe(
            "The shared context/environment both parties judge against: relevant facts, recent tool " +
              "output, file excerpts — facts you ALREADY have. Serialize objects to JSON. Keep it " +
              "under ~30k tokens, and never read a file into your context just to paste it here: " +
              "use `source` instead. Give `state`, `source`, or both (state then frames the source).",
          ),
        source: sourceShape.optional(),
        questions: z
          .array(questionShape)
          .min(1)
          .describe("All questions you have about this state — batch them."),
        confidence_threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            // Built from the constants the engine applies, never retyped: this
            // string said "Default 0.75" while calls escalated below 0.4.
            `Escalate verdicts below this confidence. Unset: ${REPORTED_CONFIDENCE_THRESHOLD} for a ` +
              `confidence Jev reported, ${ESTIMATED_CONFIDENCE_THRESHOLD} for one jev-use estimated ` +
              "from the answer's distribution (each verdict says which, in confidenceFrom).",
          ),
        model: z.string().optional().describe("Backend model override, e.g. jev-latest."),
      },
    },
    async ({ state, source, questions, confidence_threshold, model }) => {
      if (state === undefined && !source) {
        return errorResult("Give `state`, `source`, or both — there is nothing to judge.");
      }
      try {
        const resolved = await resolveForCall(ctx, source, model, questions, state);
        const { limits } = limitsFor(ctx, model);
        const result = await judge(
          ctx.backend,
          {
            state: joinState(state, resolved),
            questions,
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
