/**
 * jev_filter: the engine over a content-keyed backend, plus a round trip
 * through the MCP server. No network.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BackendRequest, BackendResponse, JevBackend } from "../src/backends/types.js";
import { globToRegExp, runFilter, type FilterEnv, type FilterRequest } from "../src/filter.js";
import { profileFor } from "../src/models.js";
import { serializeState } from "../src/protocol.js";
import { createServer } from "../src/server.js";

/** Answers by what the item says: KEEP → 0.9, MAYBE → unsure, else 0.1; choices by FLAKY. */
class ByContent implements JevBackend {
  readonly name = "mock";
  seen: string[] = [];
  async judge(request: BackendRequest): Promise<BackendResponse> {
    const state = serializeState(request.state);
    this.seen.push(state);
    return {
      answers: request.questions.map((q) => {
        if (q.type === "choice") {
          const label = state.includes("FLAKY") ? "flaky" : "real_failure";
          return {
            answer: label,
            distribution: { flaky: 0.1, real_failure: 0.1, [label]: 0.9 },
            confidence: 0.9,
          };
        }
        if (state.includes("MAYBE")) return { answer: 0.5, confidence: 0.1 };
        return { answer: state.includes("KEEP") ? 0.9 : 0.1, confidence: 0.95 };
      }),
      model: "mock",
    };
  }
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jev-filter-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function env(
  root: string,
  backend: JevBackend = new ByContent(),
  extra: Partial<FilterEnv> = {},
): FilterEnv {
  return { backend, roots: [root], redact: false, profile: profileFor("jev-latest", "mock"), ...extra };
}

const ask = (extra: Partial<FilterRequest> = {}): Partial<FilterRequest> => ({
  question: "Is this relevant?",
  ...extra,
});

const matchesOf = (result: unknown) => (result as { matches: string[] }).matches;

describe("runFilter", () => {
  const files = {
    "a.ts": "KEEP a",
    "b.ts": "other b",
    "c.ts": "KEEP c",
    "d.ts": "MAYBE d",
  };

  it("returns matches in input order and lists escalations by id", async () => {
    const root = project(files);
    const result = await runFilter(
      { items: { paths: ["c.ts", "a.ts", "b.ts", "d.ts"] }, ...ask() },
      env(root),
    );
    expect(result).toEqual({ matches: ["c.ts", "a.ts"], judged: 4, escalated: ["d.ts"] });
  });

  it("ranks by p with input order as the tiebreak, capped at top_k", async () => {
    const root = project(files);
    const result = await runFilter(
      { items: { paths: ["b.ts", "a.ts", "c.ts"] }, ...ask({ return: "ranked", topK: 2 }) },
      env(root),
    );
    expect(result).toMatchObject({
      ranked: [
        { item: "a.ts", p: 0.9 },
        { item: "c.ts", p: 0.9 },
      ],
    });
  });

  it("applies min_p, and top_k keeps the best while preserving input order", async () => {
    const root = project(files);
    const all = { items: { paths: ["a.ts", "b.ts", "c.ts"] } };
    expect(matchesOf(await runFilter({ ...all, ...ask({ minP: 0.95 }) }, env(root)))).toEqual([]);
    expect(
      matchesOf(await runFilter({ ...all, ...ask({ minP: 0, topK: 2 }) }, env(root))),
    ).toEqual(["a.ts", "c.ts"]);
  });

  it("counts a choice question with examples", async () => {
    const root = project({ "t1.log": "FLAKY one", "t2.log": "FLAKY two", "t3.log": "boom" });
    const result = await runFilter(
      {
        items: { paths: ["t1.log", "t2.log", "t3.log"] },
        choice: { question: "Why did it fail?", options: ["flaky", "real_failure"] },
      },
      env(root),
    );
    expect(result).toMatchObject({
      counts: { flaky: 2, real_failure: 1 },
      examples: { flaky: ["t1.log", "t2.log"], real_failure: ["t3.log"] },
      judged: 3,
    });
  });

  it("refuses more items than the cap, telling the agent to narrow", async () => {
    const root = project({ "x.txt": "KEEP" });
    await expect(
      runFilter(
        { items: { paths: ["x.txt", "x.txt", "x.txt"] }, ...ask() },
        env(root, undefined, { maxItems: 2 }),
      ),
    ).rejects.toThrow(/narrow the set first/);
  });

  it("cuts an oversized excerpt per item and says so", async () => {
    const root = project({ "big.ts": "KEEP\n" + "x".repeat(200_000) });
    const backend = new ByContent();
    const result = await runFilter({ items: { paths: ["big.ts"] }, ...ask() }, env(root, backend));
    expect(result).toMatchObject({ matches: ["big.ts"], truncated: 1 });
    expect(backend.seen[0]).toContain("cut to fit");
  });

  it("shows the excerpt's grep windows, not the whole file", async () => {
    const root = project({ "s.ts": "noise\nnoise\nKEEP session\nnoise\nnoise\n" });
    const backend = new ByContent();
    await runFilter(
      { items: { paths: ["s.ts"] }, ...ask({ excerpt: { grep: "session", context: 1 } }) },
      env(root, backend),
    );
    expect(backend.seen[0]).toBe("--- item: s.ts ---\nnoise\nKEEP session\nnoise");
  });

  it("skips an unreadable item but refuses one outside the root", async () => {
    const root = project({ "a.ts": "KEEP", "bin.dat": "\0\0\0" });
    const result = await runFilter(
      { items: { paths: ["a.ts", "missing.ts", "bin.dat"] }, ...ask() },
      env(root),
    );
    expect(result).toMatchObject({ matches: ["a.ts"], judged: 1 });
    expect((result as { skipped: { item: string }[] }).skipped.map((s) => s.item)).toEqual([
      "bin.dat",
      "missing.ts",
    ]);
    const outside = project({ "secret.txt": "KEEP" });
    await expect(
      runFilter({ items: { paths: [join(outside, "secret.txt")] }, ...ask() }, env(root)),
    ).rejects.toThrow(/outside the allowed paths/);
    // A relative escape resolves outside the root too (or is not found); never judged.
    const escaped = await runFilter({ items: { paths: ["../escape.txt"] }, ...ask() }, env(root));
    expect(escaped).toMatchObject({ judged: 0 });
  });

  it("does not follow a symlink out of the root", async () => {
    const outside = project({ "secret.txt": "KEEP" });
    const root = project({});
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    } catch {
      return; // symlinks need privileges on some Windows setups
    }
    await expect(
      runFilter({ items: { paths: ["link.txt"] }, ...ask() }, env(root)),
    ).rejects.toThrow(/outside the allowed paths/);
  });

  it("expands a glob honouring .gitignore", async () => {
    const root = project({
      ".gitignore": "ignored/\n",
      "src/a.ts": "KEEP",
      "src/deep/b.ts": "KEEP",
      "ignored/c.ts": "KEEP",
      "src/readme.md": "KEEP",
    });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const result = await runFilter({ items: { glob: "**/*.ts" }, ...ask() }, env(root));
    expect(matchesOf(result)).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });

  describe("each", () => {
    it("splits lines, tolerating CRLF and a trailing blank line", async () => {
      const root = project({ "out.log": "KEEP one\r\nskip two\r\nKEEP three\r\n\r\n" });
      const result = await runFilter(
        { items: { file: "out.log", each: "line" }, ...ask() },
        env(root),
      );
      expect(result).toMatchObject({ matches: ["out.log#1", "out.log#3"], judged: 3 });
    });

    it("splits JSONL, skipping blank records", async () => {
      const root = project({ "ev.jsonl": '{"m":"KEEP"}\n\n{"m":"no"}\n' });
      const result = await runFilter(
        { items: { file: "ev.jsonl", each: "jsonl" }, ...ask() },
        env(root),
      );
      expect(result).toMatchObject({ matches: ["ev.jsonl#1"], judged: 2 });
    });

    it("splits blank-line separated blocks", async () => {
      const root = project({ "b.txt": "KEEP a\nmore a\n\n\nno b\n\nKEEP c" });
      const backend = new ByContent();
      const result = await runFilter(
        { items: { file: "b.txt", each: "block" }, ...ask() },
        env(root, backend),
      );
      expect(result).toMatchObject({ matches: ["b.txt#1", "b.txt#3"], judged: 3 });
      expect(backend.seen.join("|")).toContain("KEEP a\nmore a");
    });

    it("errors past the item cap", async () => {
      const root = project({ "many.log": "KEEP\n".repeat(50) });
      await expect(
        runFilter(
          { items: { file: "many.log", each: "line" }, ...ask() },
          env(root, undefined, { maxItems: 10 }),
        ),
      ).rejects.toThrow(/narrow the set first/);
    });

    it("reads saved grep output as path:line items", async () => {
      const root = project({ "hits.txt": "src/a.ts:12:KEEP session\nC:\\x\\b.ts:3:nothing\n" });
      const result = await runFilter({ items: { grepOutput: "hits.txt" }, ...ask() }, env(root));
      expect(result).toMatchObject({ matches: ["src/a.ts:12"], judged: 2 });
    });
  });

  it("reports progress and honours the concurrency bound", async () => {
    const root = project(files);
    let active = 0;
    let peak = 0;
    const backend = new ByContent();
    const inner = backend.judge.bind(backend);
    backend.judge = async (r) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return inner(r);
    };
    const progress: number[] = [];
    await runFilter(
      { items: { paths: Object.keys(files) }, ...ask() },
      env(root, backend, { concurrency: 2, onProgress: (done) => void progress.push(done) }),
    );
    expect(peak).toBe(2);
    expect(progress).toEqual([1, 2, 3, 4]);
  });

  it("rejects a bad excerpt regex or range once instead of skipping every item", async () => {
    const root = project(files);
    const items = { paths: ["a.ts", "b.ts"] };
    await expect(
      runFilter({ items, ...ask({ excerpt: { grep: "(" } }) }, env(root)),
    ).rejects.toThrow(/not a valid regex/);
    await expect(
      runFilter({ items, ...ask({ excerpt: { lines: "nope" } }) }, env(root)),
    ).rejects.toThrow(/lines must look like/);
  });

  it("skips a directory among the paths instead of failing the call", async () => {
    const root = project(files);
    mkdirSync(join(root, "adir"));
    const result = await runFilter({ items: { paths: ["a.ts", "adir"] }, ...ask() }, env(root));
    expect(matchesOf(result)).toEqual(["a.ts"]);
    expect(result).toMatchObject({ skipped: [{ item: "adir" }] });
  });

  it("keeps same-named glob matches from different roots apart", async () => {
    const one = project({ "src/a.ts": "KEEP one" });
    const two = project({ "src/a.ts": "KEEP two" });
    const backend = new ByContent();
    const result = await runFilter(
      { items: { glob: "src/*.ts" }, ...ask() },
      { ...env(one, backend), roots: [one, two] },
    );
    expect(matchesOf(result)).toEqual([join(two, "src/a.ts"), "src/a.ts"].sort());
    expect(backend.seen.some((s) => s.includes("KEEP two"))).toBe(true);
  });

  it("leaves files deleted from the working tree out of a glob", async () => {
    const root = project({ "a.ts": "KEEP", "gone.ts": "KEEP" });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    rmSync(join(root, "gone.ts"));
    const result = await runFilter({ items: { glob: "*.ts" }, ...ask() }, env(root));
    expect(result).toEqual({ matches: ["a.ts"], judged: 1, escalated: [] });
  });

  it("keeps a blank-line-heavy grep output within the item cap", async () => {
    const root = project({ "hits.txt": "a.ts:1:KEEP\n\n\n\n\nb.ts:2:no\n" });
    const result = await runFilter(
      { items: { grepOutput: "hits.txt" }, ...ask() },
      env(root, undefined, { maxItems: 2 }),
    );
    expect(result).toMatchObject({ matches: ["a.ts:1"], judged: 2 });
  });

  it("lists at most 50 escalated ids and counts the rest", async () => {
    const names: Record<string, string> = {};
    for (let i = 0; i < 60; i++) names[`m${i}.ts`] = "MAYBE";
    const root = project(names);
    const result = (await runFilter({ items: { glob: "*.ts" }, ...ask() }, env(root))) as {
      escalated: string[];
      escalatedMore: number;
      judged: number;
    };
    expect(result.escalated).toHaveLength(50);
    expect(result.escalatedMore).toBe(10);
    expect(result.judged).toBe(60);
  });

  it("throttles progress notifications", async () => {
    const names: Record<string, string> = {};
    for (let i = 0; i < 100; i++) names[`f${i}.ts`] = "KEEP";
    const root = project(names);
    const progress: number[] = [];
    await runFilter(
      { items: { glob: "*.ts" }, ...ask() },
      env(root, undefined, { onProgress: (done) => void progress.push(done) }),
    );
    expect(progress.length).toBeLessThanOrEqual(21);
    expect(progress[progress.length - 1]).toBe(100);
  });

  it("requires exactly one of question and choice", async () => {
    const root = project(files);
    await expect(runFilter({ items: { paths: ["a.ts"] } }, env(root))).rejects.toThrow(
      /exactly one/,
    );
  });
});

describe("globToRegExp", () => {
  it("handles **, *, ? and braces", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/x/y/a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
    expect(globToRegExp("a?.{ts,js}").test("ab.js")).toBe(true);
    expect(globToRegExp("a.ts").test("axts")).toBe(false);
  });
});

describe("jev_filter over MCP", () => {
  it("is listed and answers a round trip", async () => {
    const root = project({ "a.ts": "KEEP a", "b.ts": "other" });
    const server = createServer(new ByContent(), { root, env: { JEV_BACKEND: "mock" } });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("jev_filter");
    const res = await client.callTool({
      name: "jev_filter",
      arguments: { glob: "*.ts", question: "Is this relevant?" },
    });
    const parsed = JSON.parse((res.content as { text: string }[])[0].text);
    expect(parsed).toEqual({ matches: ["a.ts"], judged: 2, escalated: [] });
    const bad = await client.callTool({
      name: "jev_filter",
      arguments: { paths: ["a.ts"], glob: "*.ts", question: "q" },
    });
    expect(bad.isError).toBe(true);
  });
});
