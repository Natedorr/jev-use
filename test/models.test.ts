import { describe, expect, it } from "vitest";
import { screenQuestions } from "../src/dispatch.js";
import { profileFor, stateBudget } from "../src/models.js";
import type { Question } from "../src/protocol.js";

const question: Question = { type: "noul", question: "Did it fail?" };
const tokens = (n: number) => "x".repeat(n * 4);

describe("profileFor", () => {
  it("knows the local models", () => {
    expect(profileFor("nimble:9b", "typesafe", {})).toMatchObject({
      contextTokens: 8192,
      maxQuestions: 64,
      maxOptions: 26,
      vision: false,
      maxBodyBytes: 65536,
    });
    expect(profileFor("clef-flash", "typesafe", {})).toMatchObject({
      contextTokens: 64_000,
      vision: true,
    });
  });

  it("falls back to today's numbers, overridable for unknown models", () => {
    expect(profileFor(undefined, "typesafe", {}).contextTokens).toBe(64_000);
    expect(
      profileFor("jev-latest", "typesafe", { JEV_CONTEXT_TOKENS: "4000" }).contextTokens,
    ).toBe(64_000);
    expect(
      profileFor("mystery", "typesafe", { JEV_CONTEXT_TOKENS: "4000" }).contextTokens,
    ).toBe(4000);
  });
});

describe("env overrides", () => {
  it("force vision on or off for any model", () => {
    expect(profileFor("mystery", "typesafe", { JEV_VISION: "on" }).vision).toBe(true);
    expect(profileFor("clef", "typesafe", { JEV_VISION: "off" }).vision).toBe(false);
    expect(profileFor("clef", "typesafe", { JEV_VISION: "maybe" }).vision).toBe(true);
  });
  it("force the question and option limits, ignoring junk", () => {
    const p = profileFor("jev-latest", "typesafe", { JEV_MAX_QUESTIONS: "1", JEV_MAX_OPTIONS: "8" });
    expect([p.maxQuestions, p.maxOptions]).toEqual([1, 8]);
    expect(profileFor("nimble", "typesafe", { JEV_MAX_QUESTIONS: "0" }).maxQuestions).toBe(64);
    expect(profileFor("nimble", "typesafe", { JEV_MAX_QUESTIONS: "x" }).maxQuestions).toBe(64);
  });
});

describe("state budget", () => {
  it("keeps hosted at 30k and shrinks nimble by the question set", () => {
    expect(stateBudget(profileFor(undefined, "typesafe", {}), [question])).toBe(30_000);
    const nimble = stateBudget(profileFor("nimble", "typesafe", {}), [question]);
    expect(nimble).toBeLessThan(8192);
    const many = Array.from({ length: 40 }, () => question);
    expect(stateBudget(profileFor("nimble", "typesafe", {}), many)).toBeLessThan(nimble);
  });

  it("hands back a 12k-token state on nimble but accepts it on hosted", () => {
    const state = tokens(12_000);
    const nimble = screenQuestions(state, [question], {
      profile: profileFor("nimble", "typesafe", {}),
    });
    expect(nimble.oversized).toBe(true);
    expect(nimble.handedBack[0].verdict.hint).toContain("source.tail");
    const hosted = screenQuestions(state, [question], {
      profile: profileFor(undefined, "typesafe", {}),
    });
    expect(hosted.oversized).toBeUndefined();
    expect(hosted.sendable).toHaveLength(1);
  });

  it("enforces the nimble body size, question count and option count", () => {
    const profile = profileFor("nimble", "typesafe", {});
    // few tokens by the 4-chars estimate, but over 64 KiB in bytes
    expect(screenQuestions("é".repeat(40_000), [question], { profile }).oversized).toBe(true);

    const many = Array.from({ length: 70 }, (_, i) => ({ ...question, id: `q${i}` }));
    const res = screenQuestions("short", many, { profile });
    expect(res.sendable).toHaveLength(64);
    expect(res.handedBack).toHaveLength(6);
    expect(res.handedBack[0].verdict.reason).toBe("oversized");

    const options = Array.from({ length: 27 }, (_, i) => `o${i}`);
    const wide = screenQuestions("short", [{ type: "choice", question: "pick", options }], {
      profile,
    });
    expect(wide.handedBack[0].verdict.reason).toBe("oversized");
  });
});

import { questionsInputFor } from "../src/tools/context.js";

describe("JEV_QUESTIONS_INPUT", () => {
  const one = { type: "noul", question: "ok?" };
  it("advertises one plain shape when forced", () => {
    expect(questionsInputFor({ JEV_QUESTIONS_INPUT: "array" }).safeParse([one]).success).toBe(true);
    expect(questionsInputFor({ JEV_QUESTIONS_INPUT: "array" }).safeParse(one).success).toBe(false);
    expect(questionsInputFor({ JEV_QUESTIONS_INPUT: "single" }).safeParse(one).success).toBe(true);
    expect(questionsInputFor({ JEV_QUESTIONS_INPUT: "string" }).safeParse("[]").success).toBe(true);
  });
  it("accepts every spelling by default", () => {
    const schema = questionsInputFor({});
    for (const input of [[one], one, JSON.stringify([one]), { a: one }]) {
      expect(schema.safeParse(input).success).toBe(true);
    }
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("models.json", () => {
  const userFile = (body: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), "jev-models-")), "models.json");
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return { JEV_MODELS_FILE: path };
  };

  it("loads the bundled table", () => {
    expect(profileFor("nimble", "typesafe", {}).contextTokens).toBe(8192);
    expect(profileFor("clef-flash", "typesafe", {}).vision).toBe(true);
    expect(profileFor("tev1:0.8b", "typesafe", {}).maxOptions).toBe(24);
  });

  it("lets a user file add a model and merge over a bundled one", () => {
    const env = userFile({
      models: { "my-model": { contextTokens: 4096, vision: true, maxQuestions: 1 }, nimble: { maxQuestions: 8 } },
    });
    expect(profileFor("my-model-7b", "typesafe", env)).toMatchObject({ contextTokens: 4096, vision: true, maxQuestions: 1 });
    const nimble = profileFor("nimble", "typesafe", env);
    expect([nimble.maxQuestions, nimble.contextTokens]).toEqual([8, 8192]);
  });

  it("prefers the longest matching prefix", () => {
    const env = userFile({ models: { "clef-flash": { vision: false } } });
    expect(profileFor("clef-flash", "typesafe", env).vision).toBe(false);
    expect(profileFor("clef", "typesafe", env).vision).toBe(true);
  });

  it("ignores a broken user file and bad fields; env overrides still win", () => {
    expect(profileFor("nimble", "typesafe", userFile("{nope")).contextTokens).toBe(8192);
    const env = userFile({ models: { nimble: { contextTokens: "big", maxOptions: -3, notes: "x" } } });
    expect(profileFor("nimble", "typesafe", env)).toMatchObject({ contextTokens: 8192, maxOptions: 26 });
    expect(profileFor("nimble", "typesafe", { ...env, JEV_MAX_OPTIONS: "5" }).maxOptions).toBe(5);
  });
});
