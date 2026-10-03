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
