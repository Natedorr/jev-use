/**
 * Model profiles: what each judge model can take in one call. The 30k state
 * ceiling is right for hosted Jev (64k context) and wrong for local models —
 * nimble scores every question with the state AND the whole question set
 * inside an 8,192-token window, so a 20k-token state would pass the generic
 * screen and then fail or be truncated on the model.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, effectiveEnv } from "./config.js";
import { DEFAULT_MAX_STATE_TOKENS, estimateTokens, type Question } from "./protocol.js";

const USER_MODELS_PATH = join(CONFIG_PATH, "..", "models.json");

export interface ModelProfile {
  /** Total context window, in tokens. */
  contextTokens: number;
  /** Most questions one call may carry. */
  maxQuestions: number;
  /** Most options one choice question may carry. */
  maxOptions: number;
  vision: boolean;
  /** Largest serialized request body the model's server accepts. */
  maxBodyBytes?: number;
  /**
   * The model prompts once per question with the state AND the whole question
   * set in every prompt, so the question set eats the state's budget.
   */
  questionSetInPrompt?: boolean;
}

/** Fields a models.json entry may set; anything else (notes, typos) is ignored. */
const NUMBER_FIELDS = ["contextTokens", "maxQuestions", "maxOptions", "maxBodyBytes"] as const;
const BOOLEAN_FIELDS = ["vision", "questionSetInPrompt"] as const;

type Entry = Partial<ModelProfile>;

/** Keep only well-typed, positive fields from one raw JSON entry. */
function cleanEntry(raw: unknown): Entry {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const entry = raw as Record<string, unknown>;
  for (const key of NUMBER_FIELDS) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof entry[key] === "boolean") out[key] = entry[key];
  }
  return out;
}

interface ModelTable {
  defaults: Entry;
  models: Map<string, Entry>;
}

/** Read one models.json; missing or broken = empty, like the config file. */
function readTable(path: string): { defaults: Entry; models: Record<string, Entry> } {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const models: Record<string, Entry> = {};
    const declared = raw?.models;
    if (declared && typeof declared === "object" && !Array.isArray(declared)) {
      for (const [name, entry] of Object.entries(declared)) models[name.toLowerCase()] = cleanEntry(entry);
    }
    return { defaults: cleanEntry(raw?.defaults), models };
  } catch {
    return { defaults: {}, models: {} };
  }
}

const BUNDLED_PATH = fileURLToPath(new URL("../models.json", import.meta.url));
const tableCache = new Map<string, ModelTable>();

/**
 * The model table: the bundled models.json, with the user's file layered on
 * top (`JEV_MODELS_FILE`, else ~/.config/jev-use/models.json). A user entry
 * merges over the bundled one of the same name field by field, so a user file
 * can change one number or add a model without restating the rest.
 */
export function loadModelTable(env: Record<string, string | undefined> = effectiveEnv()): ModelTable {
  const userPath = env.JEV_MODELS_FILE || USER_MODELS_PATH;
  const cached = tableCache.get(userPath);
  if (cached) return cached;
  const bundled = readTable(BUNDLED_PATH);
  const user = readTable(userPath);
  const models = new Map<string, Entry>(Object.entries(bundled.models));
  for (const [name, entry] of Object.entries(user.models)) models.set(name, { ...models.get(name), ...entry });
  const table = { defaults: { ...bundled.defaults, ...user.defaults }, models };
  tableCache.set(userPath, table);
  return table;
}

/** The entry whose name is the longest prefix of the model, if any. */
function matchEntry(table: ModelTable, name: string): Entry | undefined {
  let best: string | undefined;
  for (const key of table.models.keys()) {
    if (name.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : table.models.get(best);
}

/** The hosted fallback if models.json is missing or has no defaults. */
const FALLBACK: ModelProfile = {
  contextTokens: 64_000,
  maxQuestions: Infinity,
  maxOptions: Infinity,
  vision: false,
};

/** Tokens held back for the instruction text around state and questions. */
const PROMPT_MARGIN_TOKENS = 512;

/** A positive integer env override, or undefined when unset or malformed. */
function envInt(env: Record<string, string | undefined>, name: string): number | undefined {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** An on/off env override, or undefined when unset or unrecognised. */
function envFlag(env: Record<string, string | undefined>, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined) return undefined;
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return undefined;
}

/**
 * The profile for a model: its entry in the model table (models.json), then
 * any env (or config-file) override on top. The overrides are for when a model changes
 * faster than this table does, and apply to every model, known or not:
 *
 *   JEV_VISION=on|off          force whether the model can read images
 *   JEV_MAX_QUESTIONS=N        questions per call (1 = one question per call)
 *   JEV_MAX_OPTIONS=N          options per choice/score question
 *   JEV_MAX_BODY_BYTES=N       largest request body the server accepts
 *   JEV_CONTEXT_TOKENS=N       context window; ignored for hosted `jev*`
 */
export function profileFor(
  model: string | undefined,
  _backendName: string,
  env: Record<string, string | undefined> = effectiveEnv(),
): ModelProfile {
  const name = (model ?? "").toLowerCase();
  const table = loadModelTable(env);
  const entry = matchEntry(table, name);
  let profile: ModelProfile = { ...FALLBACK, ...table.defaults, ...entry };
  if (!entry) {
    const window = envInt(env, "JEV_CONTEXT_TOKENS");
    if (window) profile = { ...profile, contextTokens: window };
  }
  const maxQuestions = envInt(env, "JEV_MAX_QUESTIONS");
  const maxOptions = envInt(env, "JEV_MAX_OPTIONS");
  const maxBodyBytes = envInt(env, "JEV_MAX_BODY_BYTES");
  const vision = envFlag(env, "JEV_VISION");
  return {
    ...profile,
    ...(maxQuestions ? { maxQuestions } : {}),
    ...(maxOptions ? { maxOptions } : {}),
    ...(maxBodyBytes ? { maxBodyBytes } : {}),
    ...(vision !== undefined ? { vision } : {}),
  };
}

/** The token budget left for the state once the questions are accounted for. */
export function stateBudget(profile: ModelProfile, questions: Question[]): number {
  const questionTokens = profile.questionSetInPrompt ? estimateTokens(questions) : 0;
  const room = profile.contextTokens - questionTokens - PROMPT_MARGIN_TOKENS;
  return Math.max(0, Math.min(DEFAULT_MAX_STATE_TOKENS, room));
}

/** The model a server will judge with when a call names none. */
export function defaultModel(
  env: Record<string, string | undefined> = effectiveEnv(),
): string | undefined {
  return env.JEV_MODEL ?? env.TYPESAFE_DEFAULT_MODEL;
}
