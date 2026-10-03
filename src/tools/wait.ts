import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allowedPaths, isLocalBackend } from "../sources.js";
import { DEFAULT_IDLE_S, DEFAULT_WAIT_TAIL, DEFAULT_WAIT_TIMEOUT_S, MAX_WAIT_TIMEOUT_S, runWait } from "../wait.js";
import { errorResult, limitsFor, type ToolContext } from "./context.js";

export function registerWait(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "jev_wait",
    {
      title: "Wait for a running process with Jev",
      description:
        "Block until a background process is ready, failed or gone, and return one small status. " +
        "Use after starting a dev server, build or long job with background Bash: pass its `output_file` " +
        "(and `pid`) with `until` / `fail_if` questions. " +
        "Don't poll with cat and sleep. With only `pid` it is a free is-it-alive wait. " +
        "Returns {status, label, alive, waited_s, checks}: 1 ready, 2 failed, 3 exited (`outcome`: " +
        "success|failure|unclear), 0 timeout (still running: call again), 4 escalate (read the output yourself). " +
        `timeout_s defaults to ${DEFAULT_WAIT_TIMEOUT_S}, max ${MAX_WAIT_TIMEOUT_S}.`,
      inputSchema: {
        output_file: z.string().optional().describe("The background task's output file."),
        pid: z.number().int().positive().optional().describe("Process id, for the liveness check."),
        until: z
          .string()
          .optional()
          .describe('Yes/no question for "ready", e.g. "Is the server listening and ready for requests?"'),
        fail_if: z
          .string()
          .optional()
          .describe('Yes/no question for "failed", e.g. "Has it crashed or hit a fatal error?"'),
        timeout_s: z.number().positive().optional().describe("Give up waiting after this many seconds."),
        tail: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Lines of output Jev sees per check (default ${DEFAULT_WAIT_TAIL}).`),
        idle_s: z
          .number()
          .positive()
          .optional()
          .describe(
            `Without a pid: seconds of silence before Jev is asked whether it finished or is stuck (default ${DEFAULT_IDLE_S}).`,
          ),
        model: z.string().optional().describe("Backend model override."),
      },
    },
    async (args, extra) => {
      try {
        const { limits } = limitsFor(ctx, args.model);
        const progressToken = extra._meta?.progressToken;
        const result = await runWait(
          {
            outputFile: args.output_file,
            pid: args.pid,
            until: args.until,
            failIf: args.fail_if,
            timeoutS: args.timeout_s,
            tail: args.tail,
            idleS: args.idle_s,
            model: args.model,
          },
          {
            backend: ctx.backend,
            roots: await ctx.listRoots(),
            allowPaths: allowedPaths(ctx.env),
            redact: !isLocalBackend(ctx.env),
            profile: limits.profile!,
            signal: extra.signal,
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
