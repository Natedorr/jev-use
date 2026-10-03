/**
 * The process-watching engine behind `jev_wait` (no MCP in here): block until
 * an already-running process — attached by output file and/or pid — is ready,
 * has failed, or is gone, and return a small status instead of making the
 * agent poll with `cat`.
 *
 * Liveness is deterministic (`process.kill(pid, 0)`, no model call). Jev is
 * asked only when new output has appeared since the last check, or once when
 * the process has exited; each ask is ONE batched call over the tail.
 */

import { stat } from "node:fs/promises";
import type { JevBackend } from "./backends/types.js";
import { judge } from "./judge.js";
import { stateBudget, type ModelProfile } from "./models.js";
import type { Question } from "./protocol.js";
import { resolveSource, scopedPath, SourceError } from "./sources.js";

export const WAIT_STATUS = { timeout: 0, ready: 1, failed: 2, exited: 3, escalate: 4 } as const;
export type WaitLabel = keyof typeof WAIT_STATUS;

export const DEFAULT_WAIT_TIMEOUT_S = 120;
/** Kept under typical MCP client tool timeouts so the agent can simply call again. */
export const MAX_WAIT_TIMEOUT_S = 600;
export const DEFAULT_WAIT_TAIL = 150;
export const DEFAULT_IDLE_S = 30;
const DEFAULT_POLL_MS = 1000;
const MIN_P = 0.5;
/** Progress notifications are sent at most this often. */
const PROGRESS_EVERY_MS = 5000;
/** Characters kept free for the source header and the cut marker. */
const OVERHEAD_CHARS = 300;

export interface WaitRequest {
  /** The background task's output file. */
  outputFile?: string;
  pid?: number;
  /** Yes/no: is the process ready? */
  until?: string;
  /** Yes/no: has it failed? */
  failIf?: string;
  timeoutS?: number;
  /** Lines of output Jev sees per check. */
  tail?: number;
  /** With no pid: seconds of silence before one "finished or stuck?" check. */
  idleS?: number;
  model?: string;
}

export interface WaitEnv {
  backend: JevBackend;
  roots: string[];
  allowPaths?: string[];
  redact: boolean;
  profile: ModelProfile;
  signal?: AbortSignal;
  pollMs?: number;
  onProgress?: (elapsedS: number, timeoutS: number) => void | Promise<void>;
}

export interface WaitResult {
  status: 0 | 1 | 2 | 3 | 4;
  label: WaitLabel;
  /** Absent when no pid was given. */
  alive?: boolean;
  waited_s: number;
  /** How many times Jev was asked. */
  checks: number;
  /** For `exited`: Jev's read of the final output. */
  outcome?: "success" | "failure" | "unclear";
  hint?: string;
}

/** Whether `pid` names a live process. EPERM means it exists but is not ours. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("jev_wait was cancelled."));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("jev_wait was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const OUTCOMES = ["success", "failure", "unclear"];

export async function runWait(request: WaitRequest, env: WaitEnv): Promise<WaitResult> {
  const { outputFile, pid } = request;
  if (outputFile === undefined && pid === undefined) {
    throw new SourceError("Give `output_file` and/or `pid` to attach to.");
  }
  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
    throw new SourceError("`pid` must be a positive integer.");
  }
  if ((request.until || request.failIf) && outputFile === undefined) {
    throw new SourceError("`until` and `fail_if` read the process's output; give `output_file` too.");
  }
  const timeoutS = Math.min(Math.max(request.timeoutS ?? DEFAULT_WAIT_TIMEOUT_S, 1), MAX_WAIT_TIMEOUT_S);
  const tail = request.tail ?? DEFAULT_WAIT_TAIL;
  const idleMs = (request.idleS ?? DEFAULT_IDLE_S) * 1000;
  const pollMs = env.pollMs ?? DEFAULT_POLL_MS;
  // Resolve once: fails early for a missing file or one outside the allowed roots.
  const sourceCtx = (maxChars: number) => ({
    roots: env.roots,
    allowPaths: env.allowPaths,
    redact: env.redact,
    maxChars,
  });
  const path = outputFile === undefined ? undefined : (await scopedPath(outputFile, sourceCtx(0))).path;

  const started = Date.now();
  const deadline = started + timeoutS * 1000;
  let checks = 0;
  let lastSize = -1;
  let lastGrowth = started;
  let lastProgress = started;
  const waited = (): number => Math.round((Date.now() - started) / 100) / 10;

  /** One batched Jev call over the tail; the questions it answers are named by `ask`. */
  const check = async (ask: {
    until: boolean;
    failIf: boolean;
    outcome: boolean;
    finished: boolean;
  }) => {
    const questions: Question[] = [];
    if (ask.until && request.until) questions.push({ id: "until", type: "noul", question: request.until });
    if (ask.failIf && request.failIf) questions.push({ id: "fail", type: "noul", question: request.failIf });
    if (ask.finished) {
      questions.push({
        id: "finished",
        type: "choice",
        question: "Has this process finished, is it still working, or is it stuck?",
        options: ["finished", "working", "stuck"],
      });
    }
    if (ask.outcome) {
      questions.push({
        id: "outcome",
        type: "choice",
        question: "Judging by the final output, did the process succeed or fail?",
        options: OUTCOMES,
      });
    }
    const maxChars = Math.max(0, stateBudget(env.profile, questions) * 4 - OVERHEAD_CHARS);
    const resolved = await resolveSource({ file: path!, tail }, sourceCtx(maxChars));
    checks++;
    const result = await judge(
      env.backend,
      { state: `--- process output: ${resolved.origin} ---\n${resolved.text}`, questions, model: request.model },
      { profile: env.profile },
    );
    const byId = new Map<string, (typeof result.verdicts)[number]>();
    questions.forEach((q, i) => byId.set(q.id!, result.verdicts[i]));
    return byId;
  };

  /** Resolves "late" if the deadline passes first; rejects on abort. Jev calls can be slow. */
  const guarded = <T>(work: Promise<T>): Promise<T | "late"> =>
    new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        env.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error("jev_wait was cancelled."));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve("late");
      }, Math.max(0, deadline - Date.now()));
      env.signal?.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });

  /** Set when Jev was unsure on a chunk; reported instead of `timeout` if nothing clearer follows. */
  let unsureHint: { hint?: string } | undefined;

  const done = (label: WaitLabel, extra: Partial<WaitResult> = {}, alive?: boolean): WaitResult => ({
    status: WAIT_STATUS[label],
    label,
    ...(alive === undefined ? {} : { alive }),
    waited_s: waited(),
    checks,
    ...extra,
  });

  const timedOut = (alive?: boolean): WaitResult =>
    unsureHint ? done("escalate", unsureHint, alive) : done("timeout", {}, alive);

  const yes = (v: { answer: number | string | null; escalate: boolean } | undefined): boolean =>
    !!v && !v.escalate && typeof v.answer === "number" && v.answer >= MIN_P;

  for (;;) {
    if (env.signal?.aborted) throw new Error("jev_wait was cancelled.");
    const alive = pid === undefined ? undefined : isAlive(pid);
    const exited = alive === false;
    let size = path === undefined || lastSize < 0 ? 0 : lastSize;
    let missing = false;
    if (path !== undefined) {
      try {
        size = (await stat(path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing = true; // deleted mid-wait: nothing to read, liveness still counts
      }
    }
    const grew = !missing && size !== lastSize && (size > 0 || lastSize >= 0);
    if (!missing && size !== lastSize) {
      lastSize = size;
      lastGrowth = Date.now();
    }

    const asks = !!(request.until || request.failIf);
    if (path !== undefined && !missing && (asks || exited || pid === undefined) && size > 0) {
      const idle = pid === undefined && Date.now() - lastGrowth >= idleMs;
      if ((grew && asks) || exited || idle) {
        const checked = await guarded(
          check({
            until: grew || exited,
            failIf: grew || exited,
            outcome: exited || idle,
            finished: idle && !exited,
          }),
        );
        if (checked === "late") return timedOut(alive);
        const verdicts = checked;
        const outcomeOf = (): WaitResult["outcome"] => {
          const v = verdicts.get("outcome");
          return v && !v.escalate && OUTCOMES.includes(v.answer as string)
            ? (v.answer as "success" | "failure" | "unclear")
            : "unclear";
        };
        const decisive = [verdicts.get("until"), verdicts.get("fail")].filter(Boolean);
        if (yes(verdicts.get("fail"))) return done("failed", {}, alive);
        if (yes(verdicts.get("until"))) return done("ready", {}, alive);
        if (exited) return done("exited", { outcome: outcomeOf() }, alive);
        if (idle) {
          const finished = verdicts.get("finished");
          lastGrowth = Date.now(); // ask again only after another quiet spell
          if (finished && !finished.escalate && finished.answer === "finished") {
            return done("exited", { outcome: outcomeOf() }, alive);
          }
          if (!finished || finished.escalate || finished.answer === "stuck") {
            return done("escalate", finished?.hint ? { hint: finished.hint } : {}, alive);
          }
        }
        // Keep waiting: a later chunk may be clear. Reported at the deadline if not.
        const unsure = decisive.find((v) => v!.escalate);
        unsureHint = unsure ? (unsure.hint ? { hint: unsure.hint } : {}) : undefined;
      }
    } else if (exited) {
      return done("exited", {}, alive);
    }

    const now = Date.now();
    if (now >= deadline) return timedOut(alive);
    if (env.onProgress && now - lastProgress >= PROGRESS_EVERY_MS) {
      lastProgress = now;
      await env.onProgress(Math.round((now - started) / 1000), timeoutS);
    }
    await sleep(Math.min(pollMs, deadline - now), env.signal);
  }
}
