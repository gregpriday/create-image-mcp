/**
 * Environment loading shared by the server and scripts/check-env.js.
 *
 * Precedence: real environment variables → <cwd>/.env → ~/.env.
 * Only ENV_FILE_KEYS are taken from .env files, so a project's .env can't set
 * things like OPENAI_BASE_URL and redirect the API key to another host.
 * dotenv's parse() is used instead of config() because it never writes to
 * stdout, which is reserved for MCP messages.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse } from "dotenv";

export const ENV_FILE_KEYS = ["OPENAI_API_KEY", "OPENAI_IMAGE_MODEL"];

export function envFilePaths(cwd = process.cwd(), home = homedir()) {
  return [join(cwd, ".env"), join(home, ".env")];
}

/**
 * Resolve each allowed key to its value and where it came from.
 * @returns {Record<string, { value: string, source: string }>}
 */
export function resolveEnv({ env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  const resolved = {};
  for (const key of ENV_FILE_KEYS) {
    if (env[key] !== undefined) {
      resolved[key] = { value: env[key], source: "environment" };
    }
  }
  for (const path of envFilePaths(cwd, home)) {
    let parsed;
    try {
      parsed = parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    for (const key of ENV_FILE_KEYS) {
      if (resolved[key] === undefined && parsed[key] !== undefined) {
        resolved[key] = { value: parsed[key], source: path };
      }
    }
  }
  return resolved;
}

/**
 * Copy allowed keys from .env files into process.env without overriding
 * variables that are already set.
 */
export function loadEnvFiles() {
  for (const [key, { value, source }] of Object.entries(resolveEnv())) {
    if (source !== "environment") {
      process.env[key] = value;
    }
  }
}
