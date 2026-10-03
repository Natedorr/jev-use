/**
 * MCP round trip: a real client handshakes with the real server over a
 * linked in-memory transport, lists tools, and calls both of them.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBackend } from "../src/backends/mock.js";
import {
  ESTIMATED_CONFIDENCE_THRESHOLD,
  estimateTokens,
  REPORTED_CONFIDENCE_THRESHOLD,
} from "../src/protocol.js";
import { createServer } from "../src/server.js";

async function connectedClient(backend = new MockBackend()) {
  const server = createServer(backend);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("MCP server", () => {
  it("exposes exactly jev_judge and jev_gate", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["jev_gate", "jev_judge"]);
  });

  /**
   * The tool description is what an LLM reads before every call, and it used to
   * hard-code "Default 0.75" while the engine escalated below 0.4/0.5. Pin it to
   * the constants the engine applies — both numbers, plus the field that says
   * which one a verdict was judged against.
   */
  it("documents the thresholds and the verdict shape the engine produces", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const judgeTool = tools.tools.find((t) => t.name === "jev_judge")!;
    const documented = (
      judgeTool.inputSchema.properties as {
        confidence_threshold: { description: string };
      }
    ).confidence_threshold.description;
    expect(documented).toContain(String(REPORTED_CONFIDENCE_THRESHOLD));
    expect(documented).toContain(String(ESTIMATED_CONFIDENCE_THRESHOLD));
    expect(documented).toContain("confidenceFrom");
    expect(judgeTool.description).toContain("confidenceFrom");
    const gateTool = tools.tools.find((t) => t.name === "jev_gate")!;
    expect(gateTool.description).toContain("confidenceFrom");
  });

  it("answers a jev_judge call end to end", async () => {
    const client = await connectedClient(
      new MockBackend({
        pass: { answer: 0.97 },
        next: {
          answer: "commit",
          distribution: { commit: 0.92, debug: 0.08 },
          confidence: 0.92,
        },
      }),
    );
    const res = await client.callTool({
      name: "jev_judge",
      arguments: {
        state: "CI: 128 tests passed, 0 failed",
        questions: [
          { id: "pass", type: "noul", question: "Did all tests pass?" },
          {
            id: "next",
            type: "choice",
            question: "Next step?",
            options: ["commit", "debug"],
          },
        ],
      },
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.escalated).toBe(false);
    expect(parsed.verdicts[0].answer).toBe(0.97);
    expect(parsed.verdicts[1].answer).toBe("commit");
  });

  it("carries escalation through a jev_judge call", async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "jev_judge",
      arguments: {
        state: "some state",
        questions: [
          { type: "choice", question: "Write a commit message for this diff" },
        ],
      },
    });
    const parsed = JSON.parse(
      (res.content as { type: string; text: string }[])[0].text,
    );
    expect(parsed.escalated).toBe(true);
    expect(parsed.verdicts[0].reason).toBe("open_ended");
  });

  it("answers a jev_gate call", async () => {
    const client = await connectedClient(
      new MockBackend({
        gate: {
          answer: "allow",
          distribution: { allow: 0.95, deny: 0.05 },
          confidence: 0.95,
        },
      }),
    );
    const res = await client.callTool({
      name: "jev_gate",
      arguments: {
        state: "running the project's own test suite",
        tool: "Bash",
        input: "npm test",
      },
    });
    const parsed = JSON.parse(
      (res.content as { type: string; text: string }[])[0].text,
    );
    expect(parsed.decision).toBe("allow");
  });
});

describe("source on jev_judge", () => {
  /** A backend that records the state it was asked to judge. */
  function recording(script = {}) {
    const backend = new MockBackend(script);
    const seen: string[] = [];
    const original = backend.judge.bind(backend);
    backend.judge = async (request) => {
      seen.push(String(request.state));
      return original(request);
    };
    return { backend, seen };
  }

  async function withFile(
    content: string,
    backend = new MockBackend(),
    env: Record<string, string> = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), "jev-server-"));
    writeFileSync(join(root, "run.log"), content);
    const server = createServer(backend, { root, env });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    return client;
  }

  const askFailed = [{ id: "failed", type: "noul", question: "Did the run fail?" }];
  const textOf = (res: unknown) =>
    JSON.parse((res as { content: { text: string }[] }).content[0].text);

  it("judges a file by reference and reports what was read", async () => {
    const { backend, seen } = recording({ failed: { answer: 0.9 } });
    const client = await withFile("step 1 ok\nstep 2 FAILED\n", backend);
    const res = await client.callTool({
      name: "jev_judge",
      arguments: { source: { file: "run.log", tail: 1 }, questions: askFailed },
    });
    const parsed = textOf(res);
    expect(parsed.verdicts[0].answer).toBe(0.9);
    expect(parsed.source).toEqual({ origin: "run.log tail 1", truncated: false });
    expect(seen[0]).toContain("step 2 FAILED");
    expect(seen[0]).not.toContain("step 1 ok");
  });

  it("uses state as framing text when both are given", async () => {
    const { backend, seen } = recording();
    const client = await withFile("hello\n", backend);
    await client.callTool({
      name: "jev_judge",
      arguments: { state: "CI log follows", source: { file: "run.log" }, questions: askFailed },
    });
    expect(seen[0]).toBe("CI log follows\n\n--- source: run.log ---\nhello");
  });

  it("errors when neither state nor source is given", async () => {
    const client = await withFile("x\n");
    const res = await client.callTool({ name: "jev_judge", arguments: { questions: askFailed } });
    expect(res.isError).toBe(true);
  });

  it("returns an error, not a verdict, for a path outside the root", async () => {
    const client = await withFile("x\n");
    const res = await client.callTool({
      name: "jev_judge",
      arguments: { source: { file: "../nope.log" }, questions: askFailed },
    });
    expect(res.isError).toBe(true);
  });

  it("cuts a source to fit nimble's budget and says so", async () => {
    const { backend, seen } = recording();
    const client = await withFile("x".repeat(100_000), backend, { JEV_MODEL: "nimble" });
    const res = await client.callTool({
      name: "jev_judge",
      arguments: { source: { file: "run.log" }, questions: askFailed },
    });
    const parsed = textOf(res);
    expect(parsed.source.truncated).toBe(true);
    expect(parsed.verdicts[0].reason).not.toBe("oversized");
    expect(seen[0].length).toBeLessThan(32_000);
  });
});

describe("source on jev_gate", () => {
  it("leaves room for the action and the gate question in nimble's budget", async () => {
    const backend = new MockBackend({
      gate: { answer: "allow", distribution: { allow: 0.95, deny: 0.05 }, confidence: 0.95 },
    });
    const seen: string[] = [];
    const original = backend.judge.bind(backend);
    backend.judge = async (request) => {
      seen.push(String(request.state));
      return original(request);
    };
    const root = mkdtempSync(join(tmpdir(), "jev-gate-"));
    writeFileSync(join(root, "run.log"), "x".repeat(100_000));
    const server = createServer(backend, { root, env: { JEV_MODEL: "nimble" } });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);

    const res = await client.callTool({
      name: "jev_gate",
      arguments: {
        state: "deploying",
        source: { file: "run.log" },
        tool: "Bash",
        input: "y".repeat(6_000),
      },
    });
    const parsed = JSON.parse((res.content as { text: string }[])[0].text);
    expect(parsed.decision).toBe("allow");
    expect(parsed.source.truncated).toBe(true);
    expect(estimateTokens(seen[0])).toBeLessThan(8_192 - 512);
  });
});
