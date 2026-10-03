import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadImages, MAX_IMAGES } from "../images.js";
import { judge } from "../judge.js";
import {
  ESTIMATED_CONFIDENCE_THRESHOLD,
  normalizeQuestions,
  REPORTED_CONFIDENCE_THRESHOLD,
} from "../protocol.js";
import { allowedPaths } from "../sources.js";
import {
  errorResult,
  joinState,
  limitsFor,
  questionsInputFor,
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
        "Answer typed judgment questions (yes/no, pick one, score) about one state in a few hundred ms. " +
        "Use when you must decide: did the build/test/command succeed, which next action, how severe, " +
        "is this screenshot an error. Batch every question about one state into ONE call. " +
        "Don't Read a file or paste a log just to pass it here: give `source` ({file, tail|head|lines|grep}) " +
        "or `images` (paths) and the server reads it, so only the verdict returns. " +
        "Not for new text/code, exit codes, exact-string matches, or options you cannot list. " +
        "Returns per question {answer, confidence, confidenceFrom, escalate, reason, hint}; " +
        "confidenceFrom is \"reported\" (Jev's own head) or \"estimated\" (from the distribution). " +
        "escalate=true hands the question back: writing/open_ended = yours, oversized = narrow the source, " +
        "unsure = answer is only a prior, unreachable = proceed without Jev, " +
        "no_vision = set JEV_VISION_MODEL=clef-flash.",
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
        questions: questionsInputFor(ctx.env),
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
    async ({ state, source, questions: rawQuestions, confidence_threshold, images, model }) => {
      if (state === undefined && !source && !images?.length) {
        return errorResult("Give `state`, `source`, `images`, or a mix — there is nothing to judge.");
      }
      try {
        const questions = normalizeQuestions(rawQuestions);
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
