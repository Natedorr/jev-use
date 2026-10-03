/**
 * The bulk-relevance engine behind `jev_filter` (no MCP in here): turn a set
 * of items — files, a glob, the lines of one file, saved grep hits — into one
 * judgment each, and return only the survivors. The items never pass through
 * the agent's context; only the ids that matter do.
 *
 * One item per Jev call (the state is that item's excerpt, the question is
 * the same for every item), run with bounded concurrency. Paths, redaction
 * and the per-item size budget come from `sources.ts` and `models.ts`.
 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { JevBackend } from "./backends/types.js";
import { judge } from "./judge.js";
import { stateBudget, type ModelProfile } from "./models.js";
import type { Question } from "./protocol.js";
import { redactSecrets } from "./redact.js";
import {
  readItems,
  resolveSource,
  ScopeError,
  SourceError,
  validateExcerpt,
  type EachMode,
  type Source,
  type SourceContext,
} from "./sources.js";

const execFileAsync = promisify(execFile);

/** Most items one call may judge; above this the agent must narrow with grep/glob first. */
export const MAX_FILTER_ITEMS = 500;
export const DEFAULT_FILTER_CONCURRENCY = 4;
const DEFAULT_HEAD = 80;
const DEFAULT_MIN_P = 0.5;
const DEFAULT_RANKED_TOP_K = 20;
const EXAMPLES_PER_LABEL = 3;
/** Escalated ids listed in a result; the rest are only counted in `escalatedMore`. */
const MAX_ESCALATED_LISTED = 50;
/** At most this many progress notifications per call. */
const PROGRESS_STEPS = 20;
/** Characters kept free for the item header and the truncation marker. */
const ITEM_OVERHEAD_CHARS = 300;

/** What Jev sees of each file item. Default: its first 80 lines. */
export type Excerpt = Pick<Source, "head" | "tail" | "lines" | "grep" | "context">;

/** Exactly one of these names the items. */
export type FilterItems =
  | { paths: string[] }
  | { glob: string }
  | { file: string; each: EachMode }
  | { grepOutput: string };

export interface FilterRequest {
  items: FilterItems;
  /** A yes/no relevance question asked of every item. */
  question?: string;
  /** Or a choice question: items are counted per option. */
  choice?: { question: string; options: string[] | Record<string, string> };
  excerpt?: Excerpt;
  return?: "matches" | "ranked" | "counts";
  minP?: number;
  topK?: number;
  model?: string;
}

export interface FilterEnv {
  backend: JevBackend;
  roots: string[];
  allowPaths?: string[];
  redact: boolean;
  profile: ModelProfile;
  concurrency?: number;
  maxItems?: number;
  /** Called as items finish, for MCP progress notifications. */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

export type FilterResult =
  | {
      matches: string[];
      judged: number;
      /** Items Jev handed back as unsure or unjudgeable — not in `matches`; look at these yourself. */
      escalated: string[];
      escalatedMore?: number;
      skipped?: { item: string; why: string }[];
      truncated?: number;
      hint?: string;
    }
  | {
      ranked: { item: string; p: number }[];
      judged: number;
      escalated: string[];
      escalatedMore?: number;
      skipped?: { item: string; why: string }[];
      truncated?: number;
      hint?: string;
    }
  | {
      counts: Record<string, number>;
      examples: Record<string, string[]>;
      judged: number;
      escalated: string[];
      escalatedMore?: number;
      skipped?: { item: string; why: string }[];
      truncated?: number;
      hint?: string;
    };

interface Item {
  id: string;
  /** The text Jev judges; throws SourceError to skip the item. */
  load: (maxChars: number) => Promise<{ text: string; truncated: boolean }>;
}

/** A glob (`**`, `*`, `?`, `{a,b}`) as a regex over `/`-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) out += "\\{";
      else {
        out += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map(escapeRegExp)
          .join("|")})`;
        i = end;
      }
    } else out += escapeRegExp(c);
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^$()|[\]\\{}*?]/g, "\\$&");
}

/** Every file under `root` that git would not ignore; a plain walk when it is no repo. */
async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    const { stdout: deleted } = await execFileAsync("git", ["ls-files", "-d", "-z"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    const gone = new Set(deleted.split("\0").filter(Boolean));
    return stdout.split("\0").filter((file) => file && !gone.has(file));
  } catch {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) found.push(relative(root, full).split("\\").join("/"));
      }
    };
    await walk(root);
    return found;
  }
}

/** Matching files as `{id, path}`: the id is root-relative unless another root has the same name. */
async function expandGlob(glob: string, roots: string[]): Promise<{ id: string; path: string }[]> {
  const pattern = globToRegExp(glob.replace(/^\.\//, ""));
  const found: { id: string; path: string }[] = [];
  const ids = new Set<string>();
  const seenPaths = new Set<string>();
  for (const root of roots) {
    const matched = (await listFiles(root)).filter((file) => pattern.test(file)).sort();
    for (const file of matched) {
      const path = join(root, file);
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      const id = ids.has(file) ? path : file;
      ids.add(id);
      found.push({ id, path });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** `path:line:text` — the shape of `grep -n`; a Windows drive prefix is part of the path. */
const GREP_HIT = /^((?:[A-Za-z]:)?[^:]+):(\d+):(.*)$/;

function cut(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: `${text.slice(0, maxChars)}\n[… item cut to fit the model's state budget …]`, truncated: true }
    : { text, truncated: false };
}

async function collectItems(
  request: FilterRequest,
  env: FilterEnv,
  sourceCtx: (maxChars: number) => SourceContext,
  limit: number,
): Promise<Item[]> {
  const { items } = request;
  const tooMany = (count: number | string): SourceError =>
    new SourceError(
      `${count} items is over the ${limit}-item limit; narrow the set first with Grep/Glob, then filter what is left.`,
    );
  const fileItems = (files: { id: string; path: string }[]): Item[] => {
    if (files.length > limit) throw tooMany(files.length);
    const excerpt: Excerpt = request.excerpt ?? { head: DEFAULT_HEAD };
    return files.map(({ id, path }) => ({
      id,
      load: async (maxChars) => {
        const resolved = await resolveSource({ file: path, ...excerpt }, sourceCtx(maxChars));
        return { text: resolved.text || "[no lines matched]", truncated: resolved.truncated };
      },
    }));
  };
  const textItems = (ids: string[], texts: string[]): Item[] =>
    texts.map((text, i) => ({
      id: ids[i],
      load: async (maxChars) => cut(env.redact ? redactSecrets(text) : text, maxChars),
    }));

  if ("paths" in items) return fileItems(items.paths.map((path) => ({ id: path, path })));
  if ("glob" in items) return fileItems(await expandGlob(items.glob, env.roots));
  if ("file" in items) {
    const { items: texts, over } = await readItems(items.file, items.each, sourceCtx(0), limit);
    if (over) throw tooMany(`More than ${limit}`);
    return textItems(
      texts.map((_, i) => `${items.file}#${i + 1}`),
      texts,
    );
  }
  const { items: lines, over } = await readItems(items.grepOutput, "jsonl", sourceCtx(0), limit); // "jsonl" = non-blank lines
  if (over) throw tooMany(`More than ${limit}`);
  const hits = lines;
  const parsed = hits.map((line) => GREP_HIT.exec(line));
  return textItems(
    hits.map((line, i) => (parsed[i] ? `${parsed[i]![1]}:${parsed[i]![2]}` : `${items.grepOutput}#${i + 1}`)),
    hits.map((line, i) => (parsed[i] ? parsed[i]![3] : line)),
  );
}

/** Run `work` over `count` indices with at most `width` in flight, in order of start. */
async function pool(count: number, width: number, work: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) await work(next++);
  };
  await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
}

function listed<T extends { escalated: string[] }>(base: T): T {
  return { ...base, escalated: base.escalated.slice(0, MAX_ESCALATED_LISTED) };
}

/** Judge every item against the question and return the survivors, ranking or counts. */
export async function runFilter(request: FilterRequest, env: FilterEnv): Promise<FilterResult> {
  if (!request.question === !request.choice) {
    throw new SourceError("Give exactly one of `question` (yes/no relevance) or `choice`.");
  }
  const mode = request.return ?? (request.choice ? "counts" : "matches");
  if (mode === "counts" && !request.choice) {
    throw new SourceError('return "counts" needs a `choice` question.');
  }
  if (mode !== "counts" && !request.question) {
    throw new SourceError(`return "${mode}" needs a \`question\`; \`choice\` returns counts.`);
  }
  validateExcerpt(request.excerpt);
  const limit = env.maxItems ?? MAX_FILTER_ITEMS;
  const questions: Question[] = [
    request.choice
      ? { id: "q", type: "choice", question: request.choice.question, options: request.choice.options }
      : { id: "q", type: "noul", question: request.question! },
  ];
  // Per item: room for the question set (nimble re-reads it per question), the header and the cut marker.
  const maxChars = Math.max(0, stateBudget(env.profile, questions) * 4 - ITEM_OVERHEAD_CHARS);
  const sourceCtx = (budget: number): SourceContext => ({
    roots: env.roots,
    allowPaths: env.allowPaths,
    redact: env.redact,
    maxChars: budget || maxChars,
  });

  const items = await collectItems(request, env, sourceCtx, limit);
  const total = items.length;

  const verdicts: ({ answer: number | string | null; escalate: boolean; hint?: string } | undefined)[] =
    new Array(total);
  const skipped: { item: string; why: string }[] = [];
  let truncated = 0;
  let done = 0;
  const progressEvery = Math.max(1, Math.ceil(total / PROGRESS_STEPS));
  await pool(total, Math.max(1, env.concurrency ?? DEFAULT_FILTER_CONCURRENCY), async (i) => {
    const item = items[i];
    try {
      const loaded = await item.load(maxChars);
      if (loaded.truncated) truncated++;
      const result = await judge(
        env.backend,
        { state: `--- item: ${item.id} ---\n${loaded.text}`, questions, model: request.model },
        { profile: env.profile },
      );
      verdicts[i] = result.verdicts[0];
    } catch (error) {
      // Leaving the allowed roots refuses the whole call; an unreadable item is just skipped.
      if (error instanceof ScopeError) throw error;
      skipped.push({ item: item.id, why: error instanceof Error ? error.message : String(error) });
    }
    done++;
    if (done === total || done % progressEvery === 0) await env.onProgress?.(done, total);
  });

  const base = { judged: 0, escalated: [] as string[] };
  const p: (number | undefined)[] = [];
  const labels: (string | undefined)[] = [];
  let firstHint: string | undefined;
  items.forEach((item, i) => {
    const v = verdicts[i];
    if (!v) return;
    base.judged++;
    if (v.escalate) {
      base.escalated.push(item.id);
      firstHint ??= v.hint;
    } else if (typeof v.answer === "number") p[i] = v.answer;
    else if (typeof v.answer === "string") labels[i] = v.answer;
  });
  const escalatedMore = base.escalated.length - MAX_ESCALATED_LISTED;
  const extras = {
    ...(escalatedMore > 0 ? { escalatedMore } : {}),
    ...(skipped.length > 0 ? { skipped: skipped.sort((a, b) => a.item.localeCompare(b.item)) } : {}),
    ...(truncated > 0 ? { truncated } : {}),
    // Only worth saying when nothing at all was judged — otherwise ids are enough.
    ...(base.judged > 0 && base.escalated.length === base.judged && firstHint ? { hint: firstHint } : {}),
  };

  if (mode === "counts") {
    const counts: Record<string, number> = {};
    const examples: Record<string, string[]> = {};
    items.forEach((item, i) => {
      const label = labels[i];
      if (label === undefined) return;
      counts[label] = (counts[label] ?? 0) + 1;
      const list = (examples[label] ??= []);
      if (list.length < EXAMPLES_PER_LABEL) list.push(item.id);
    });
    return { counts, examples, ...listed(base), ...extras };
  }

  const scored = items
    .map((item, i) => ({ item: item.id, p: p[i], order: i }))
    .filter((entry): entry is { item: string; p: number; order: number } => entry.p !== undefined);
  const threshold = request.minP ?? (mode === "matches" ? DEFAULT_MIN_P : 0);
  const kept = scored.filter((entry) => entry.p >= threshold);
  const byRank = [...kept].sort((a, b) => b.p - a.p || a.order - b.order);
  if (mode === "ranked") {
    const top = byRank.slice(0, request.topK ?? DEFAULT_RANKED_TOP_K);
    return { ranked: top.map(({ item, p: score }) => ({ item, p: score })), ...listed(base), ...extras };
  }
  // matches keep input order; top_k keeps the highest-scoring ones, still in input order.
  const chosen =
    request.topK === undefined ? kept : byRank.slice(0, request.topK).sort((a, b) => a.order - b.order);
  return { matches: chosen.map((entry) => entry.item), ...listed(base), ...extras };
}
