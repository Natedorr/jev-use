import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  allowedPaths,
  isLocalBackend,
  resolveSource,
  SourceError,
  type SourceContext,
} from "../src/sources.js";

let root: string;
let ctx: SourceContext;
const numbered = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jev-sources-"));
  writeFileSync(join(root, "build.log"), numbered(1000));
  writeFileSync(
    join(root, "app.log"),
    "ok\nERROR boom\nafter\nfine\nfine\nfine\nERROR again\nend\n",
  );
  writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
  writeFileSync(join(root, "secret.txt"), "deploy with --token abc123secret now\n");
  ctx = { roots: [root], redact: false, maxChars: 100_000 };
});

describe("resolveSource", () => {
  it("reads head, tail and a line range", async () => {
    const head = await resolveSource({ file: "build.log", head: 3 }, ctx);
    expect(head.text).toBe("line 1\nline 2\nline 3");
    expect(head.origin).toBe("build.log head 3");

    const tail = await resolveSource({ file: "build.log", tail: 2 }, ctx);
    expect(tail.text).toBe("line 999\nline 1000");

    const range = await resolveSource({ file: "build.log", lines: "120-122" }, ctx);
    expect(range.text).toBe("line 120\nline 121\nline 122");
  });

  it("greps with context and marks gaps", async () => {
    const hit = await resolveSource({ file: "app.log", grep: "ERROR", context: 1 }, ctx);
    expect(hit.text).toBe("ok\nERROR boom\nafter\n--\nfine\nERROR again\nend");
  });

  it("refuses paths that leave the root", async () => {
    await expect(resolveSource({ file: "../outside.txt" }, ctx)).rejects.toThrow(SourceError);
    await expect(resolveSource({ file: join(tmpdir(), "x.txt") }, ctx)).rejects.toThrow(
      SourceError,
    );
  });

  it("accepts a directory whose name merely starts with two dots", async () => {
    mkdirSync(join(root, "..cache"), { recursive: true });
    writeFileSync(join(root, "..cache", "x.txt"), "inside\n");
    const got = await resolveSource({ file: "..cache/x.txt" }, ctx);
    expect(got.text).toBe("inside");
  });

  it("stops at head lines even with grep context gaps", async () => {
    const got = await resolveSource({ file: "app.log", grep: "ERROR", context: 1, head: 3 }, ctx);
    expect(got.text).toBe("ok\nERROR boom\nafter");
  });

  it("refuses a symlink that escapes the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "jev-outside-"));
    writeFileSync(join(outside, "private.txt"), "nope\n");
    try {
      symlinkSync(join(outside, "private.txt"), join(root, "link.txt"));
    } catch {
      return; // symlinks need privileges on some Windows setups
    }
    await expect(resolveSource({ file: "link.txt" }, ctx)).rejects.toThrow(/outside/);
  });

  it("widens scope with allowPaths", async () => {
    const other = mkdtempSync(join(tmpdir(), "jev-other-"));
    mkdirSync(join(other, "d"));
    writeFileSync(join(other, "d", "x.log"), "hello\n");
    const res = await resolveSource(
      { file: join(other, "d", "x.log") },
      { ...ctx, allowPaths: [other] },
    );
    expect(res.text).toBe("hello");
  });

  it("refuses binary files", async () => {
    await expect(resolveSource({ file: "blob.bin" }, ctx)).rejects.toThrow(/binary/);
  });

  it("cuts to the budget with a marker: head keeps the start, tail keeps the end", async () => {
    const small = { ...ctx, maxChars: 200 };
    const whole = await resolveSource({ file: "build.log" }, small);
    expect(whole.truncated).toBe(true);
    expect(whole.text.startsWith("line 1\n")).toBe(true);
    expect(whole.text).toContain("cut to fit");

    const tail = await resolveSource({ file: "build.log", tail: 500 }, small);
    expect(tail.truncated).toBe(true);
    expect(tail.text.endsWith("line 1000")).toBe(true);
    expect(tail.text).toContain("cut to fit");
  });

  it("redacts for a remote backend and not for a local one", async () => {
    const remote = await resolveSource({ file: "secret.txt" }, { ...ctx, redact: true });
    expect(remote.text).not.toContain("abc123secret");
    const local = await resolveSource({ file: "secret.txt" }, { ...ctx, redact: false });
    expect(local.text).toContain("abc123secret");
  });

  it("rejects bad arguments", async () => {
    await expect(resolveSource({ file: "build.log", head: 1, tail: 1 }, ctx)).rejects.toThrow(
      /not both/,
    );
    await expect(resolveSource({ file: "build.log", lines: "nope" }, ctx)).rejects.toThrow(
      /lines/,
    );
    await expect(resolveSource({ file: "build.log", grep: "(" }, ctx)).rejects.toThrow(/regex/);
  });
});

describe("isLocalBackend", () => {
  it("treats loopback and private hosts as local", () => {
    for (const url of [
      "http://localhost:11434",
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
      "http://192.168.1.5:1234",
      "http://10.0.0.7",
      "http://172.20.0.1",
      "http://box.local:1",
    ]) {
      expect(isLocalBackend({ TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: url })).toBe(true);
    }
  });

  it("treats hosted and unset backends as remote", () => {
    expect(isLocalBackend({ TYPESAFE_API_KEY: "k" })).toBe(false);
    expect(
      isLocalBackend({ TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "https://api.example.com" }),
    ).toBe(false);
    expect(
      isLocalBackend({ TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://172.32.0.1" }),
    ).toBe(false);
    expect(isLocalBackend({ OPENROUTER_API_KEY: "k" })).toBe(false);
  });

  it("follows the backend actually selected", () => {
    expect(
      isLocalBackend({
        JEV_BACKEND: "openrouter",
        OPENROUTER_API_KEY: "k",
        TYPESAFE_BASE_URL: "http://localhost:1",
      }),
    ).toBe(false);
    expect(isLocalBackend({ JEV_BACKEND: "mock" })).toBe(true);
  });
});

describe("allowedPaths", () => {
  it("splits on the platform delimiter", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    expect(allowedPaths({ JEV_ALLOW_PATHS: `a${sep}b` })).toEqual(["a", "b"]);
    expect(allowedPaths({})).toEqual([]);
  });
});
