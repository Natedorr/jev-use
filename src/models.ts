/**
 * Model profiles: what each judge model can take in one call. The 30k state
 * ceiling is right for hosted Jev (64k context) and wrong for local models —
 * nimble scores every question with the state AND the whole question set
 * inside an 8,192-token window, so a 20k-token state would pass the generic
 * screen and then fail or be truncated on the model.
 */

import { effectiveEnv } from "./config.js";
import { DEFAULT_MAX_STATE_TOKENS, estimateTokens, type Question } from "./protocol.js";

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

/** Today's numbers: hosted Jev, 64k context with at most 30k for the state. */
const HOSTED: ModelProfile = {
  contextTokens: 64_000,
  maxQuestions: Infinity,
  maxOptions: Infinity,
  vision: false,
};

const NIMBLE: ModelProfile = {
  contextTokens: 8_192,
  maxQuestions: 64,
  maxOptions: 26,
  vision: false,
  maxBodyBytes: 64 * 1024,
  questionSetInPrompt: true,
};

/**
 * Ollama's /v1/systemone takes 1-64 questions and 2-26 options per choice or
 * score question, for every decision model (docs/ollama-*.md).
 */
const OLLAMA_LIMITS = { maxQuestions: 64, maxOptions: 26 };

/** Clef and Clef-Flash are both multimodal. */
const CLEF: ModelProfile = { ...HOSTED, ...OLLAMA_LIMITS, vision: true };

/** Tev1 is text-only and was trained on 2-24 options, so stay inside that. */
const TEV1: ModelProfile = { ...HOSTED, ...OLLAMA_LIMITS, maxOptions: 24 };

/** Tokens held back for the instruction text around state and questions. */
const PROMPT_MARGIN_TOKENS = 512;

/**
 * The profile for a model. Unknown models get today's numbers, whose context
 * `JEV_CONTEXT_TOKENS` can override.
 */
export function profileFor(
  model: string | undefined,
  _backendName: string,
  env: Record<string, string | undefined> = effectiveEnv(),
): ModelProfile {
  const name = (model ?? "").toLowerCase();
  if (name.startsWith("nimble")) return NIMBLE;
  if (name.startsWith("clef")) return CLEF;
  if (name.startsWith("tev1")) return TEV1;
  const override = Number(env.JEV_CONTEXT_TOKENS);
  if (!name.startsWith("jev") && Number.isFinite(override) && override > 0) {
    return { ...HOSTED, contextTokens: override };
  }
  return HOSTED;
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
