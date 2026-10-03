/**
 * Sources: a reference to data (a file and a slice of it) turned into the
 * state string a judgment reads, on the server side — so the data never passes
 * through the agent's context. The MCP server runs locally over stdio, so it
 * can read what the agent points at.
 *
 * Everything here is bounded: paths stay inside the allowed roots, large
 * files are streamed (never loaded whole), and the result is cut to the
 * model's state budget with a marker rather than sent to overflow.
 */

import { createReadStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { effectiveEnv } from "./config.js";
import { redactSecrets } from "./redact.js";

/** One reference. The union stays open: bulk (`paths`/`glob`) and images extend it. */
export type Source = {
  file: string;
  /** First N lines. */
  head?: number;
  /** Last N lines. */
  tail?: number;
  /** Inclusive 1-based range, "120-180" (or "120" for one line). */
  lines?: string;
  /** Regex; keep matching lines only. */
  grep?: string;
  /** Lines of context around each grep hit. */
  context?: number;
};

export interface SourceContext {
  /** Relative paths resolve here, and paths may not leave it. */
  root: string;
  /** Extra directories paths may live in (`JEV_ALLOW_PATHS`). */
  allowPaths?: string[];
  /** Redact credentials from the text — set when the backend is remote. */
  redact: boolean;
  /** Longest text, in characters, the model's state budget allows. */
  maxChars: number;
}

export interface Resolved {
  text: string;
  /** What was read, e.g. "build.log tail 200". */
  origin: string;
  truncated: boolean;
}

/** An error the caller should see as an error, not as a verdict. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/** `JEV_ALLOW_PATHS`, split on the platform's path delimiter. */
export function allowedPaths(
  env: Record<string, string | undefined> = effectiveEnv(),
): string[] {
  return (env.JEV_ALLOW_PATHS ?? "").split(delimiter).filter(Boolean);
}

const BASE_URL_VARS: Record<string, string> = {
  typesafe: "TYPESAFE_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
  vercel: "AI_GATEWAY_BASE_URL",
};

/**
 * Is the judge on this machine or its private network? Then resolved text
 * need not be redacted before it is sent. A hosted backend (no base URL set,
 * or a public host) is remote. Which backend is in play follows the same
 * order `createBackend` uses.
 */
export function isLocalBackend(
  env: Record<string, string | undefined> = effectiveEnv(),
): boolean {
  const forced = env.JEV_BACKEND?.toLowerCase();
  if (forced === "mock") return true;
  let name = forced && forced !== "auto" ? forced : undefined;
  name ??=
    env.TYPESAFE_API_KEY || env.TYPESAFE_AI_API_KEY || env.TYPESAFE_BASE_URL
      ? "typesafe"
      : env.OPENROUTER_API_KEY
        ? "openrouter"
        : env.AI_GATEWAY_API_KEY
          ? "vercel"
          : "typesafe";
  const url = env[BASE_URL_VARS[name] ?? "TYPESAFE_BASE_URL"];
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  );
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve `file` and refuse it unless it really lives under an allowed root. */
async function scopedPath(file: string, ctx: SourceContext): Promise<string> {
  const candidate = resolve(ctx.root, file);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new SourceError(`Cannot read ${file}: no such file.`);
  }
  const roots = [ctx.root, ...(ctx.allowPaths ?? [])];
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(resolve(root));
    } catch {
      continue;
    }
    if (within(realRoot, real)) return real;
  }
  throw new SourceError(
    `${file} is outside the allowed paths (${ctx.root}); set JEV_ALLOW_PATHS to widen the scope.`,
  );
}

async function refuseBinary(path: string, name: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, bytesRead).includes(0)) {
      throw new SourceError(
        `${name} looks binary; only text files can be judged by reference.`,
      );
    }
  } finally {
    await handle.close();
  }
}

function parseRange(spec: string): [number, number] {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec);
  if (!match) throw new SourceError(`lines must look like "120-180", got "${spec}".`);
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (start < 1 || end < start) throw new SourceError(`lines range "${spec}" is empty.`);
  return [start, end];
}

function positive(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new SourceError(`${name} must be a positive integer.`);
  }
  return value;
}

/** The last `count` lines, read backwards from the end in chunks. */
async function readTail(
  path: string,
  count: number,
  maxChars: number,
): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const chunkSize = 64 * 1024;
    let position = size;
    let buffered = Buffer.alloc(0);
    let newlines = 0;
    // One more newline than lines wanted guarantees a whole first line.
    while (position > 0 && newlines <= count && buffered.length <= maxChars * 4) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      buffered = Buffer.concat([chunk, buffered]);
      newlines = 0;
      for (const byte of buffered) if (byte === 10) newlines++;
    }
    const lines = buffered.toString("utf8").split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-count);
  } finally {
    await handle.close();
  }
}

/** Stream the file's lines through the selectors, keeping memory bounded. */
async function streamLines(
  path: string,
  src: Source,
  head: number | undefined,
  tail: number | undefined,
  maxChars: number,
): Promise<{ lines: string[]; capped: boolean }> {
  const range = src.lines ? parseRange(src.lines) : undefined;
  let pattern: RegExp | undefined;
  if (src.grep !== undefined) {
    try {
      pattern = new RegExp(src.grep);
    } catch {
      throw new SourceError(`grep is not a valid regex: ${src.grep}`);
    }
  }
  const context = Math.max(0, src.context ?? 0);

  const kept: string[] = [];
  let keptChars = 0;
  let capped = false;
  const before: string[] = [];
  let afterLeft = 0;
  let lastKept = 0;
  let keptLines = 0;
  let gap = false;

  const keep = (line: string, number: number): void => {
    if (gap && kept.length > 0 && number > lastKept + 1) kept.push("--");
    gap = false;
    kept.push(line);
    keptLines++;
    keptChars += line.length + 1;
    lastKept = number;
    if (tail !== undefined && kept.length > tail) {
      const dropped = kept.shift()!;
      keptChars -= dropped.length + 1;
      if (dropped !== "--") keptLines--;
    }
  };

  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let number = 0;
  try {
    for await (const line of reader) {
      number++;
      if (range) {
        if (number < range[0]) continue;
        if (number > range[1]) break;
      }
      if (pattern) {
        if (pattern.test(line)) {
          gap = true;
          if (context > 0) {
            const first = number - before.length;
            before.forEach((previous, i) => keep(previous, first + i));
            before.length = 0;
          }
          keep(line, number);
          afterLeft = context;
        } else if (afterLeft > 0) {
          afterLeft--;
          keep(line, number);
        } else if (context > 0) {
          before.push(line);
          if (before.length > context) before.shift();
        }
      } else {
        keep(line, number);
      }
      // A keep-the-head selection stops as soon as it has enough; a tail keeps
      // rolling, bounded by its line count.
      if (tail === undefined) {
        if (head !== undefined && keptLines >= head) break;
        if (keptChars > maxChars) {
          capped = true;
          break;
        }
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  const lines = head !== undefined && tail === undefined ? kept.slice(0, head) : kept;
  return { lines, capped };
}

/** Turn a reference into text for the judge. */
export async function resolveSource(
  src: Source,
  ctx: SourceContext,
): Promise<Resolved> {
  if (!src || typeof src.file !== "string" || !src.file) {
    throw new SourceError("source needs a `file`.");
  }
  const head = positive("head", src.head);
  const tail = positive("tail", src.tail);
  if (head !== undefined && tail !== undefined) {
    throw new SourceError("Give head or tail, not both.");
  }

  const path = await scopedPath(src.file, ctx);
  if (!(await stat(path)).isFile()) throw new SourceError(`${src.file} is not a file.`);
  await refuseBinary(path, src.file);

  let lines: string[];
  let capped = false;
  if (tail !== undefined && !src.lines && src.grep === undefined) {
    lines = await readTail(path, tail, ctx.maxChars);
  } else {
    ({ lines, capped } = await streamLines(path, src, head, tail, ctx.maxChars));
  }

  let text = lines.join("\n");
  let truncated = capped;
  if (text.length > ctx.maxChars) {
    truncated = true;
    text =
      tail !== undefined
        ? `[… start cut to fit the model's state budget …]\n` +
          text.slice(text.length - ctx.maxChars)
        : text.slice(0, ctx.maxChars) +
          `\n[… cut to fit the model's state budget; narrow with tail, lines or grep …]`;
  } else if (capped) {
    text += `\n[… cut to fit the model's state budget; narrow with tail, lines or grep …]`;
  }
  if (ctx.redact) text = redactSecrets(text);

  const parts = [relative(ctx.root, path) || src.file];
  if (src.lines) parts.push(`lines ${src.lines.trim()}`);
  if (src.grep !== undefined) {
    parts.push(`grep /${src.grep}/` + (src.context ? ` ±${src.context}` : ""));
  }
  if (head !== undefined) parts.push(`head ${head}`);
  if (tail !== undefined) parts.push(`tail ${tail}`);
  return { text, origin: parts.join(" "), truncated };
}
