import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_FILTER_CONCURRENCY, MAX_FILTER_ITEMS, runFilter, type FilterItems } from "../filter.js";
import { allowedPaths, isLocalBackend, SourceError } from "../sources.js";
import { errorResult, limitsFor, type ToolContext } from "./context.js";

export function registerFilter(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "jev_filter",
    {
      title: "Filter many items by meaning with Jev",
      description:
        "Rank or filter MANY items (files, grep hits, log lines, test failures) by one question and get " +
        "back only the survivors. " +
        "Use after Grep/Glob narrowed the candidates: Grep -l, then jev_filter(paths, \"Does this handle session expiry?\"), " +
        "then Read only the matches. Also for triage: `choice` over a log's lines or blocks gives counts " +
        "(flaky / real_failure / infra). " +
        "Don't Read the items first and never call Jev once per item. " +
        "Give exactly one of paths, glob, file+each, grep_output, and exactly one of `question` " +
        "(matches or ranked) or `choice` (counts). " +
        `At most ${MAX_FILTER_ITEMS} items. ` +
        "Ids in `escalated` are ones Jev was unsure of: look at those yourself.",
      inputSchema: {
        paths: z.array(z.string()).optional().describe("Explicit file list, e.g. from `grep -l`."),
        glob: z
          .string()
          .optional()
          .describe("Glob such as src/**/*.ts, expanded on the server, honouring .gitignore."),
        file: z.string().optional().describe("One file whose lines/records/blocks are the items; needs `each`."),
        each: z.enum(["line", "jsonl", "block"]).optional().describe("With `file`: what one item is."),
        grep_output: z
          .string()
          .optional()
          .describe("A saved `grep -n` output file (path:line:text); each hit is one item."),
        question: z.string().optional().describe("Yes/no question asked of every item, phrased about the item."),
        choice: z
          .object({
            question: z.string(),
            options: z.union([z.array(z.string()), z.record(z.string(), z.string())]),
          })
          .optional()
          .describe("Instead of `question`: pick one option per item; the result is counts per option."),
        excerpt: z
          .object({
            head: z.number().int().positive().optional(),
            tail: z.number().int().positive().optional(),
            lines: z.string().optional(),
            grep: z.string().optional(),
            context: z.number().int().min(0).optional(),
          })
          .optional()
          .describe(
            "What Jev sees of each FILE item (default: first 80 lines). A `grep` excerpt with " +
              "context shows just the relevant windows. Ignored for file+each and grep_output.",
          ),
        return: z
          .enum(["matches", "ranked", "counts"])
          .optional()
          .describe("matches (default for `question`, input order), ranked ({item, p} by p), counts (for `choice`)."),
        min_p: z.number().min(0).max(1).optional().describe("Keep items with p >= this. Default 0.5 for matches."),
        top_k: z.number().int().positive().optional().describe("Keep at most this many (ranked defaults to 20)."),
        model: z.string().optional().describe("Backend model override."),
      },
    },
    async (args, extra) => {
      try {
        const named = [
          args.paths && "paths",
          args.glob && "glob",
          args.file && "file",
          args.grep_output && "grep_output",
        ].filter(Boolean);
        if (named.length !== 1) {
          throw new SourceError("Give exactly one of paths, glob, file (with each), or grep_output.");
        }
        let items: FilterItems;
        if (args.paths) items = { paths: args.paths };
        else if (args.glob) items = { glob: args.glob };
        else if (args.file) {
          if (!args.each) throw new SourceError("`file` needs `each`: line, jsonl or block.");
          items = { file: args.file, each: args.each };
        } else items = { grepOutput: args.grep_output! };

        const { limits } = limitsFor(ctx, args.model);
        const concurrency = Number(ctx.env.JEV_FILTER_CONCURRENCY);
        const progressToken = extra._meta?.progressToken;
        const result = await runFilter(
          {
            items,
            question: args.question,
            choice: args.choice,
            excerpt: args.excerpt,
            return: args.return,
            minP: args.min_p,
            topK: args.top_k,
            model: args.model,
          },
          {
            backend: ctx.backend,
            roots: await ctx.listRoots(),
            allowPaths: allowedPaths(ctx.env),
            redact: !isLocalBackend(ctx.env),
            profile: limits.profile!,
            concurrency: concurrency > 0 ? concurrency : DEFAULT_FILTER_CONCURRENCY,
            onProgress:
              progressToken === undefined
                ? undefined
                : (progress, total) =>
                    extra.sendNotification({
                      method: "notifications/progress",
                      params: { progressToken, progress, total },
                    }),
          },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
