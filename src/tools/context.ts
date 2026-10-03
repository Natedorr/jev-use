/**
 * What every MCP tool module receives, and the helpers they share: the wire
 * shape of a question, and turning a `source` reference into judged state.
 */

import { z } from "zod";
import { defaultModel, profileFor, stateBudget } from "../models.js";
import type { Question } from "../protocol.js";
import {
  allowedPaths,
  isLocalBackend,
  resolveSource,
  SourceError,
  type Resolved,
  type Source,
} from "../sources.js";
import type { JevBackend } from "../backends/types.js";
import type { ScreenLimits } from "../dispatch.js";

/** Characters kept free for the `--- source ---` header and the truncation marker. */
const SOURCE_OVERHEAD_CHARS = 300;

export interface ToolContext {
  backend: JevBackend;
  /** The directory the server started in: the scope when the client reports no roots. */
  root: string;
  /**
   * Where relative `source` paths resolve, and the boundary they may not leave:
   * the client's MCP roots, else just `root`.
   */
  listRoots: () => Promise<string[]>;
  env: Record<string, string | undefined>;
}

/** The `Question` shape as MCP callers send it — the wire contract, unchanged. */
export const questionShape = z.object({
  id: z
    .string()
    .optional()
    .describe("Your identifier for this question; echoed back in the verdict."),
  type: z
    .enum(["noul", "choice", "score"])
    .describe(
      "noul = probability that something is true; choice = pick one of enumerated options; " +
        "score = place the state on an ordered list of levels.",
    ),
  question: z.string().describe("The question, phrased about the state."),
  options: z
    .union([z.array(z.string()), z.record(z.string(), z.string())])
    .optional()
    .describe(
      "choice only: >= 2 distinct options — a list of labels, or a map of label -> what picking it means.",
    ),
  levels: z
    .array(z.string())
    .optional()
    .describe(
      "score only: >= 2 ORDERED level descriptions (e.g. ['broken', 'works but rough', 'production ready']). " +
        "The answer is a possibly-fractional index into this list.",
    ),
  criteria: z
    .object({ true: z.string(), false: z.string() })
    .optional()
    .describe("noul only (optional): what a yes and a no mean, to sharpen calibration."),
});

/**
 * `questions` as MCP callers send it. The array of `questionShape` is the
 * canonical form and what the schema advertises first; a lone question, a JSON
 * string, or an id -> question map are accepted too (see `normalizeQuestions`)
 * because not every model can emit an array argument.
 */
const questionsDescription =
  "All questions you have about this state - batch them. An array of {type, question, options|levels|criteria}; " +
  "if you cannot send an array, send one question object or a JSON string of the array.";

/**
 * The `questions` schema advertised to the caller, chosen by
 * `JEV_QUESTIONS_INPUT`. The default `any` is a union, which some models'
 * tool-calling cannot read; the others advertise one plain shape. Whatever is
 * advertised, `normalizeQuestions` still accepts every spelling.
 *
 *   any     array | one question | JSON string | id -> question map (default)
 *   array   an array of questions only
 *   single  one question object per call (pair with JEV_MAX_QUESTIONS=1)
 *   string  a JSON string of the array
 */
export function questionsInputFor(env: Record<string, string | undefined>): z.ZodTypeAny {
  switch (env.JEV_QUESTIONS_INPUT?.trim().toLowerCase()) {
    case "array":
      return z.array(questionShape).min(1).describe("All questions you have about this state - batch them.");
    case "single":
      return questionShape.describe("The one question to answer about this state. One question per call.");
    case "string":
      return z.string().describe("A JSON string of an array of {type, question, options|levels|criteria}.");
    default:
      return z
        .union([
          z.array(z.union([questionShape, z.record(z.string(), z.unknown()), z.string()])).min(1),
          questionShape,
          z.string(),
          z.record(z.string(), z.unknown()),
        ])
        .describe(questionsDescription);
  }
}

/** The `source` argument as MCP callers send it. */
export const sourceShape = z
  .object({
    file: z.string().describe("Path to a text file, relative to the server's working directory."),
    head: z.number().int().positive().optional().describe("Judge only the first N lines."),
    tail: z.number().int().positive().optional().describe("Judge only the last N lines (logs)."),
    lines: z.string().optional().describe('Judge only this inclusive line range, e.g. "120-180".'),
    grep: z.string().optional().describe("Regex: judge only the matching lines."),
    context: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("With grep: lines of context around each hit."),
  })
  .describe(
    "A file for the server to read and judge, so its content never passes through this " +
      "conversation. Narrow it with tail/head/lines/grep.",
  );

/** The model a call will be judged with, and the screening limits that follow. */
export function limitsFor(
  ctx: ToolContext,
  model: string | undefined,
): { limits: ScreenLimits; model: string | undefined } {
  const effective = model ?? defaultModel(ctx.env);
  return { limits: { profile: profileFor(effective, ctx.backend.name, ctx.env) }, model: effective };
}

/** Resolve a `source` within the model's state budget; null when none was given. */
export async function resolveForCall(
  ctx: ToolContext,
  source: Source | undefined,
  model: string | undefined,
  questions: Question[],
  framing = "",
  /** Characters the caller adds around the state once this resolves (the gate's action and question). */
  reserveChars = 0,
): Promise<Resolved | null> {
  if (!source) return null;
  const profile = limitsFor(ctx, model).limits.profile!;
  return resolveSource(source, {
    roots: await ctx.listRoots(),
    allowPaths: allowedPaths(ctx.env),
    redact: !isLocalBackend(ctx.env),
    // Room for the framing text, the source header and the cut marker too.
    maxChars: Math.max(0, stateBudget(profile, questions) * 4 - framing.length - reserveChars - SOURCE_OVERHEAD_CHARS),
  });
}

/** A tool result that is an error, not a verdict. */
export function errorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message =
    error instanceof SourceError || error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Frame text plus a resolved source, as the single state the judge reads. */
export function joinState(framing: string | undefined, resolved: Resolved | null): string {
  if (!resolved) return framing ?? "";
  const header = `--- source: ${resolved.origin} ---`;
  return framing ? `${framing}\n\n${header}\n${resolved.text}` : `${header}\n${resolved.text}`;
}
