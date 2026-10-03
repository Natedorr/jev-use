import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadImages, MAX_IMAGES } from "../images.js";
import { judge } from "../judge.js";
import {
  ESTIMATED_CONFIDENCE_THRESHOLD,
  REPORTED_CONFIDENCE_THRESHOLD,
} from "../protocol.js";
import { allowedPaths } from "../sources.js";
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
        "unreachable = Jev is down, proceed without it, " +
        "no_vision = the model or backend cannot read images (set JEV_VISION_MODEL=clef-flash). " +
        "To check a screenshot without reading it into your context, pass its path in `images`: " +
        "the server reads and encodes it, and only the verdict comes back.",
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
        images: z
          .array(z.string())
          .max(MAX_IMAGES)
          .optional()
          .describe(
            "Paths of PNG/JPEG/WebP files (relative to the server's working directory) judged " +
              "together with the state, by every question. Paths only, never base64 or the image " +
              "itself: the server reads the file so the pixels never enter this conversation. " +
              "Needs a vision model (JEV_VISION_MODEL). Screenshots leave the machine when the " +
              "backend is remote, and are not redacted.",
          ),
        model: z.string().optional().describe("Backend model override, e.g. jev-latest."),
      },
    },
    async ({ state, source, questions, confidence_threshold, images, model }) => {
      if (state === undefined && !source && !images?.length) {
        return errorResult("Give `state`, `source`, `images`, or a mix — there is nothing to judge.");
      }
      try {
        // A call with images and no explicit model goes to the vision model.
        const effective = model ?? (images?.length ? ctx.env.JEV_VISION_MODEL || undefined : undefined);
        const { limits } = limitsFor(ctx, effective);
        // When the model or backend cannot take images, skip reading the files: empty
        // placeholders still make the screen hand every question back as no_vision.
        const canSeeImages = limits.profile?.vision === true && ctx.backend.supportsImages !== false;
        const loaded =
          images?.length && canSeeImages
            ? await loadImages(images, { roots: await ctx.listRoots(), allowPaths: allowedPaths(ctx.env) })
            : null;
        const resolved = await resolveForCall(ctx, source, effective, questions, state);
        const result = await judge(
          ctx.backend,
          {
            state: joinState(state, resolved),
            questions,
            confidenceThreshold: confidence_threshold,
            model: effective,
            ...(loaded ? { images: loaded.data } : images?.length ? { images: images.map(() => "") } : {}),
          },
          limits,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...result,
                ...(resolved ? { source: { origin: resolved.origin, truncated: resolved.truncated } } : {}),
                ...(loaded ? { images: loaded.origins } : {}),
              }),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
