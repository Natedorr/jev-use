import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBackend } from "../src/backends/mock.js";
import { toNativeBody } from "../src/backends/native.js";
import { loadImages, sniffImageType } from "../src/images.js";
import { createServer } from "../src/server.js";

const fixtures = join(import.meta.dirname, "fixtures");
const ask = [{ id: "blank", type: "noul", question: "Is the page blank?" }];
const question = { id: "q", type: "noul" as const, question: "Is it blank?" };

/** A temp root holding the fixtures, a text file, and a sibling dir outside the root. */
function workspace() {
  const base = mkdtempSync(join(tmpdir(), "jev-images-"));
  const root = join(base, "root");
  mkdirSync(root);
  copyFileSync(join(fixtures, "tiny.png"), join(root, "shot.png"));
  copyFileSync(join(fixtures, "tiny.jpg"), join(root, "shot.jpg"));
  writeFileSync(join(root, "notes.txt"), "not an image");
  copyFileSync(join(fixtures, "tiny.png"), join(base, "outside.png"));
  return { base, root };
}

async function connect(backend: MockBackend, root: string, env: Record<string, string> = {}) {
  const server = createServer(backend, { root, env });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

const textOf = (res: unknown) =>
  (res as { content: { text: string }[] }).content[0].text;

describe("wire body", () => {
  it("includes images only when given", () => {
    expect(toNativeBody("s", [question], "m")).not.toHaveProperty("images");
    expect(toNativeBody("s", [question], "m", [])).not.toHaveProperty("images");
    expect(toNativeBody("s", [question], "m", ["AAAA"]).images).toEqual(["AAAA"]);
  });
});

describe("sniffImageType", () => {
  it("reads the fixtures' magic bytes", async () => {
    const { root } = workspace();
    const loaded = await loadImages(["shot.png", "shot.jpg"], { roots: [root] });
    expect(sniffImageType(Buffer.from(loaded.data[0], "base64"))).toBe("png");
    expect(sniffImageType(Buffer.from(loaded.data[1], "base64"))).toBe("jpeg");
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImageType(Buffer.from("GIF89a"))).toBeNull();
  });
});

describe("loadImages", () => {
  it("round-trips the file bytes through base64", async () => {
    const { root } = workspace();
    const { readFileSync } = await import("node:fs");
    const loaded = await loadImages(["shot.png"], { roots: [root] });
    expect(Buffer.from(loaded.data[0], "base64").equals(readFileSync(join(fixtures, "tiny.png")))).toBe(true);
    expect(loaded.origins[0]).toMatch(/^shot\.png \(png, \d+ bytes\)$/);
  });

  it("refuses a non-image file", async () => {
    const { root } = workspace();
    await expect(loadImages(["notes.txt"], { roots: [root] })).rejects.toThrow(/not a PNG, JPEG or WebP/);
  });

  it("refuses a path outside the root", async () => {
    const { root } = workspace();
    await expect(loadImages(["../outside.png"], { roots: [root] })).rejects.toThrow(/outside the allowed paths/);
  });

  it("allows it with allowPaths", async () => {
    const { base, root } = workspace();
    await expect(loadImages(["../outside.png"], { roots: [root], allowPaths: [base] })).resolves.toBeTruthy();
  });
});

describe("jev_judge images", () => {
  const vision = { JEV_VISION_MODEL: "clef-flash" };

  it("sends the images to the vision model and echoes the paths read", async () => {
    const { root } = workspace();
    const backend = new MockBackend();
    let model: string | undefined;
    const original = backend.judge.bind(backend);
    backend.judge = async (request) => {
      model = request.model;
      return original(request);
    };
    const client = await connect(backend, root, vision);
    const res = await client.callTool({
      name: "jev_judge",
      arguments: { images: ["shot.png", "shot.jpg"], questions: ask },
    });
    const parsed = JSON.parse(textOf(res));
    expect(backend.lastImageCount).toBe(2);
    expect(model).toBe("clef-flash");
    expect(parsed.verdicts[0].escalate).toBe(false);
    expect(parsed.images).toHaveLength(2);
    // The pixels never come back in the result.
    expect(textOf(res)).not.toContain(
      (await loadImages(["shot.png"], { roots: [root] })).data[0],
    );
  });

  it("an explicit model wins over JEV_VISION_MODEL", async () => {
    const { root } = workspace();
    const backend = new MockBackend();
    let model: string | undefined;
    const original = backend.judge.bind(backend);
    backend.judge = async (request) => {
      model = request.model;
      return original(request);
    };
    const client = await connect(backend, root, vision);
    await client.callTool({
      name: "jev_judge",
      arguments: { images: ["shot.png"], questions: ask, model: "clef-flash:9b" },
    });
    expect(model).toBe("clef-flash:9b");
  });

  it("hands everything back as no_vision with zero backend calls when no vision model is set", async () => {
    const { root } = workspace();
    const backend = new MockBackend();
    let calls = 0;
    const original = backend.judge.bind(backend);
    backend.judge = async (request) => {
      calls++;
      return original(request);
    };
    const client = await connect(backend, root);
    const res = await client.callTool({
      name: "jev_judge",
      arguments: { images: ["shot.png"], questions: ask },
    });
    const parsed = JSON.parse(textOf(res));
    expect(calls).toBe(0);
    expect(parsed.verdicts[0]).toMatchObject({ escalate: true, reason: "no_vision" });
    expect(parsed.verdicts[0].hint).toContain("JEV_VISION_MODEL=clef-flash");
  });

  it("hands back no_vision without reading the files", async () => {
    const { root } = workspace();
    const client = await connect(new MockBackend(), root);
    const res = await client.callTool({
      name: "jev_judge",
      arguments: { images: ["missing.png"], questions: ask },
    });
    expect(JSON.parse(textOf(res)).verdicts[0].reason).toBe("no_vision");
  });

  it("hands back no_vision on a backend with no image wire", async () => {
    const { root } = workspace();
    const backend = new MockBackend();
    Object.defineProperty(backend, "supportsImages", { value: false });
    const client = await connect(backend, root, vision);
    const res = await client.callTool({
      name: "jev_judge",
      arguments: { images: ["shot.png"], questions: ask },
    });
    expect(JSON.parse(textOf(res)).verdicts[0].reason).toBe("no_vision");
    expect(backend.lastImageCount).toBe(0);
  });

  it("errors on a non-image path and an out-of-root path", async () => {
    const { root } = workspace();
    const client = await connect(new MockBackend(), root, vision);
    for (const images of [["notes.txt"], ["../outside.png"]]) {
      const res = await client.callTool({ name: "jev_judge", arguments: { images, questions: ask } });
      expect((res as { isError?: boolean }).isError).toBe(true);
    }
  });
});
