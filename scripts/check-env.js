#!/usr/bin/env node

/**
 * Environment validation script for Create Image MCP Server.
 * Resolves configuration exactly the way the server does (src/env.js):
 * real environment variables first, then <cwd>/.env, then ~/.env.
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { resolveEnv, envFilePaths } from "../src/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const KNOWN_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"];

function checkApiKey(entry) {
  if (!entry || !entry.value) {
    console.error("❌ OPENAI_API_KEY: MISSING");
    console.error("   Get a key from https://platform.openai.com/api-keys and either export it,");
    console.error("   pass it in your MCP client config, or add OPENAI_API_KEY=... to .env or ~/.env");
    return false;
  }
  if (entry.value === "your_api_key_here") {
    console.error(`❌ OPENAI_API_KEY: placeholder value (from ${entry.source})`);
    return false;
  }
  if (entry.value.length < 20) {
    console.error(`❌ OPENAI_API_KEY: too short to be a valid key (from ${entry.source})`);
    return false;
  }
  console.log(`✅ OPENAI_API_KEY: set (from ${entry.source})`);
  return true;
}

function checkModel(entry) {
  if (!entry || !entry.value) {
    console.log(`ℹ️  OPENAI_IMAGE_MODEL: not set (default: ${KNOWN_MODELS[0]})`);
  } else if (KNOWN_MODELS.includes(entry.value) || KNOWN_MODELS.some((m) => entry.value.startsWith(`${m}-`))) {
    console.log(`✅ OPENAI_IMAGE_MODEL: ${entry.value} (from ${entry.source})`);
  } else {
    console.log(`⚠️  OPENAI_IMAGE_MODEL: ${entry.value} (from ${entry.source}) is not a GPT Image 2.5 model; the server will still use it as the default`);
  }
}

function checkNodeVersion() {
  const required = packageJson.engines?.node;
  const match = required?.match(/>=(\d+)/);
  if (!match) return true;
  const currentMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (currentMajor >= parseInt(match[1], 10)) {
    console.log(`✅ Node.js ${process.version} (requires ${required})`);
    return true;
  }
  console.error(`❌ Node.js ${process.version} is too old (requires ${required})`);
  return false;
}

console.log("=".repeat(60));
console.log("  Create Image MCP Server - Environment Validation");
console.log("=".repeat(60));

for (const path of envFilePaths()) {
  console.log(`${existsSync(path) ? "📄" : "  "} ${path}${existsSync(path) ? "" : " (not found)"}`);
}
console.log("");

const env = resolveEnv();
const keyOk = checkApiKey(env.OPENAI_API_KEY);
checkModel(env.OPENAI_IMAGE_MODEL);
const nodeOk = checkNodeVersion();

console.log("\n" + "=".repeat(60));
if (keyOk && nodeOk) {
  console.log("✅ Environment validation PASSED");
  console.log("=".repeat(60));
  process.exit(0);
} else {
  console.log("❌ Environment validation FAILED");
  console.log("=".repeat(60));
  process.exit(1);
}
