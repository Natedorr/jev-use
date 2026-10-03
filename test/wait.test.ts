/**
 * jev_wait: the engine against real child processes and a content-keyed
 * backend that counts calls. No network.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendRequest, BackendResponse, JevBackend } from "../src/backends/types.js";
import { profileFor } from "../src/models.js";
import { serializeState } from "../src/protocol.js";
import { runWait, type WaitEnv } from "../src/wait.js";

/** READY → until yes; FATAL → fail yes; UNSURE → unsure; choices: DONE → finished/success, else working/failure. */
class ByContent implements JevBackend {
  readonly name = "mock";
  calls = 0;
  async judge(request: BackendRequest): Promise<BackendResponse> {
    this.calls++;
    const state = serializeState(request.state);
    return {
      answers: request.questions.map((q) => {
        if (q.type === "choice") {
          const opts = Array.isArray(q.options) ? q.options : Object.keys(q.options!);
          const pick = opts.includes("finished")
            ? state.includes("DONE") ? "finished" : "working"
            : state.includes("BOOM") ? "failure" : "success";
          return { answer: pick, distribution: { [pick]: 0.95 }, confidence: 0.95 };
        }
        if (state.includes("UNSURE")) return { answer: 0.5, confidence: 0.1 };
        const hit = q.question.includes("fail") ? state.includes("FATAL") : state.includes("READY");
        return { answer: hit ? 0.95 : 0.05, confidence: 0.95 };
      }),
      model: "mock",
    };
  }
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

function dir(): string {
  return mkdtempSync(join(tmpdir(), "jev-wait-"));
}

/** A real child that appends `lines` to a file after `afterMs`, then lives `liveMs` more. */
function child(file: string, line: string, afterMs: number, liveMs: number): ChildProcess {
  const code =
    `const fs=require("fs");setTimeout(()=>{fs.appendFileSync(${JSON.stringify(file)},${JSON.stringify(line + "\n")})},${afterMs});` +
    `setTimeout(()=>{},${liveMs});`;
  const proc = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
  children.push(proc);
  return proc;
}

function env(root: string, backend: JevBackend, extra: Partial<WaitEnv> = {}): WaitEnv {
  return { backend, roots: [root], redact: false, profile: profileFor("jev-latest", "mock"), pollMs: 50, ...extra };
}

const Q = { until: "Is it ready?", failIf: "Did it fail?" };

describe("runWait", () => {
  it("returns ready when the output matches `until`", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "starting\n");
    const proc = child(log, "READY listening on 3000", 300, 5000);
    const result = await runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 10 }, env(root, new ByContent()));
    expect(result).toMatchObject({ status: 1, label: "ready", alive: true });
  });

  it("returns failed when the output matches `fail_if`", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "starting\n");
    const proc = child(log, "FATAL crash", 300, 5000);
    const result = await runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 10 }, env(root, new ByContent()));
    expect(result).toMatchObject({ status: 2, label: "failed" });
  });

  it("returns exited with Jev's outcome once the process is gone", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "starting\n");
    const proc = child(log, "BOOM bad thing", 100, 0);
    const result = await runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 10 }, env(root, new ByContent()));
    expect(result).toMatchObject({ status: 3, label: "exited", alive: false, outcome: "failure" });
  });

  it("times out while the process keeps running quietly", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "starting\n");
    const proc = child(log, "still going", 100, 5000);
    const result = await runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 1 }, env(root, new ByContent()));
    expect(result).toMatchObject({ status: 0, label: "timeout", alive: true });
  });

  it("keeps waiting after an unsure chunk, and a later clear chunk wins", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "UNSURE what is this\n");
    const proc = child(log, "READY now", 500, 5000);
    const result = await runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 10, tail: 1 }, env(root, new ByContent()));
    expect(result).toMatchObject({ status: 1, label: "ready" });
  });

  it("escalates at the deadline when the last chunk left Jev unsure", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "UNSURE what is this\n");
    const proc = child(log, "x", 20000, 20000);
    const result = await runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 1 }, env(root, new ByContent()));
    expect(result).toMatchObject({ status: 4, label: "escalate", alive: true });
  });

  it("returns at the deadline even when the backend is slow", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "starting\n");
    const proc = child(log, "x", 20000, 20000);
    const hang: JevBackend = { name: "hang", judge: () => new Promise(() => {}) };
    const t0 = Date.now();
    const result = await runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 1 }, env(root, hang));
    expect(result.label).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("aborts while a backend call is in flight", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "starting\n");
    const proc = child(log, "x", 20000, 20000);
    const hang: JevBackend = { name: "hang", judge: () => new Promise(() => {}) };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(
      runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 30 }, env(root, hang, { signal: controller.signal })),
    ).rejects.toThrow(/cancelled/);
  });

  it("survives the output file being deleted and reports exited", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "starting\n");
    const proc = child(log, "x", 100, 600);
    setTimeout(() => rmSync(log), 200);
    const result = await runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 10 }, env(root, new ByContent()));
    expect(result).toMatchObject({ status: 3, label: "exited", alive: false });
  });

  it("calls the backend once per new chunk, never while the output is unchanged", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "starting\n");
    const proc = child(log, "idle", 5000, 5000);
    const backend = new ByContent();
    const waiting = runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 2 }, env(root, backend));
    setTimeout(() => appendFileSync(log, "more output\n"), 700);
    const result = await waiting;
    expect(result.label).toBe("timeout");
    expect(backend.calls).toBe(2); // the initial output, then the one append
    expect(result.checks).toBe(2);
  });

  it("with only a pid it waits for exit and never calls Jev", async () => {
    const root = dir();
    const proc = child(join(root, "unused"), "x", 100, 200);
    const backend = new ByContent();
    const result = await runWait({ pid: proc.pid, timeoutS: 10 }, env(root, backend));
    expect(result).toMatchObject({ status: 3, label: "exited", alive: false, checks: 0 });
    expect(backend.calls).toBe(0);
  });

  it("without a pid, asks once after the output goes quiet and reports finished", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "DONE all work complete\n");
    const backend = new ByContent();
    const result = await runWait({ outputFile: log, idleS: 0.2, timeoutS: 5 }, env(root, backend));
    expect(result).toMatchObject({ status: 3, label: "exited", outcome: "success" });
    expect(backend.calls).toBe(1);
  });

  it("stops when aborted", async () => {
    const root = dir();
    const log = join(root, "out.log");
    writeFileSync(log, "starting\n");
    const proc = child(log, "x", 5000, 5000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(
      runWait({ outputFile: log, pid: proc.pid, ...Q, timeoutS: 30 }, env(root, new ByContent(), { signal: controller.signal })),
    ).rejects.toThrow(/cancelled/);
  });

  it("refuses bad input", async () => {
    const root = dir();
    await expect(runWait({}, env(root, new ByContent()))).rejects.toThrow(/output_file/);
    await expect(runWait({ pid: process.pid, until: "ready?" }, env(root, new ByContent()))).rejects.toThrow(/output_file/);
    await expect(runWait({ outputFile: join(root, "nope.log") }, env(root, new ByContent()))).rejects.toThrow(/no such file/);
  });
});
