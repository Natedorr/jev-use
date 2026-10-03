/**
 * Optional config file: ~/.config/jev-use/config.json
 *
 * Flat keys with the same names as the env vars:
 *
 *   {
 *     "JEV_BACKEND": "typesafe",
 *     "TYPESAFE_BASE_URL": "http://your-host:port",
 *     "JEV_MODEL": "your-model",
 *     "TYPESAFE_API_KEY": "***",
 *     "JEV_TIMEOUT_MS": 60000
 *   }
 *
 * Precedence: real environment variables win, then this file, then code
 * defaults. This matters for SDK-launched agents, where process env can be
 * lost: the file keeps backend resolution working without it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".config", "jev-use", "config.json");

/** Parse the config file into env-var-shaped entries; missing/broken = {}. */
export function readConfig(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" || typeof value === "number") {
        out[key] = String(value);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Config file first, real environment on top so it always wins. */
export function effectiveEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...readConfig(), ...env };
}
