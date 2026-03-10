#!/usr/bin/env node

/**
 * Environment validation script for Create Image MCP Server
 * Validates all required environment variables and provides remediation steps
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { homedir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const REQUIRED_ENV_VARS = [
  {
    name: "OPENAI_API_KEY",
    description: "OpenAI API key for GPT Image generation",
    remediation: "Get your API key from: https://platform.openai.com/api-keys",
    validator: (value) => {
      if (!value || value === "your_api_key_here") {
        return "API key appears to be a placeholder value";
      }
      if (value.length < 20) {
        return "API key appears to be too short (likely invalid)";
      }
      return null;
    },
  },
];

const OPTIONAL_ENV_VARS = [
  {
    name: "NODE_ENV",
    description: "Node environment (development, production, test)",
    default: "development",
  },
];

function checkEnvFile() {
  const envPath = join(projectRoot, ".env");
  const homeEnvPath = join(homedir(), ".env");

  console.log("🔍 Checking environment configuration...\n");

  const hasProjectEnv = existsSync(envPath);
  const hasHomeEnv = existsSync(homeEnvPath);

  if (hasProjectEnv) {
    console.log("✅ .env file exists (project)");
  }
  if (hasHomeEnv) {
    console.log("✅ .env file exists (home directory)");
  }
  if (!hasProjectEnv && !hasHomeEnv) {
    return false;
  }

  return true;
}

function parseEnvFile(filePath) {
  try {
    const envContent = readFileSync(filePath, "utf-8");
    const envVars = {};

    envContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key) {
          envVars[key.trim()] = valueParts.join("=").trim();
        }
      }
    });

    return envVars;
  } catch (error) {
    console.error(`❌ ERROR: Failed to read ${filePath}: ${error.message}`);
    return null;
  }
}

function loadEnvFile() {
  const envPath = join(projectRoot, ".env");
  const homeEnvPath = join(homedir(), ".env");
  let merged = {};
  let hadError = false;

  // Load home .env first (lower priority)
  if (existsSync(homeEnvPath)) {
    const homeVars = parseEnvFile(homeEnvPath);
    if (homeVars === null) {
      hadError = true;
    } else {
      Object.assign(merged, homeVars);
    }
  }

  // Load project .env second (higher priority, overrides home)
  if (existsSync(envPath)) {
    const projectVars = parseEnvFile(envPath);
    if (projectVars === null) {
      hadError = true;
    } else {
      Object.assign(merged, projectVars);
    }
  }

  if (hadError && Object.keys(merged).length === 0) {
    return null;
  }

  return merged;
}

function validateRequiredVars(envVars, hasEnvFile) {
  console.log("\n🔐 Validating required environment variables...\n");

  let allValid = true;

  for (const envVar of REQUIRED_ENV_VARS) {
    const value = envVars[envVar.name] || process.env[envVar.name];

    if (!value) {
      console.error(`❌ ${envVar.name}: MISSING`);
      console.error(`   Description: ${envVar.description}`);
      console.error(`   Remediation: ${envVar.remediation}`);

      // Only suggest .env file if it doesn't exist
      if (!hasEnvFile) {
        console.error(`   Or: Create a .env file with ${envVar.name}=your_value`);
      }
      console.error("");
      allValid = false;
      continue;
    }

    // Run custom validator if provided
    if (envVar.validator) {
      const validationError = envVar.validator(value);
      if (validationError) {
        console.error(`⚠️  ${envVar.name}: INVALID`);
        console.error(`   Issue: ${validationError}`);
        console.error(`   Remediation: ${envVar.remediation}\n`);
        allValid = false;
        continue;
      }
    }

    console.log(`✅ ${envVar.name}: OK (${value.substring(0, 4)}...)`);
  }

  return allValid;
}

function checkOptionalVars(envVars) {
  console.log("\n📋 Checking optional environment variables...\n");

  for (const envVar of OPTIONAL_ENV_VARS) {
    const value = envVars[envVar.name] || process.env[envVar.name];

    if (!value) {
      console.log(`ℹ️  ${envVar.name}: Not set (default: ${envVar.default})`);
    } else {
      console.log(`✅ ${envVar.name}: ${value}`);
    }
  }
}

function checkNodeVersion() {
  console.log("\n🔧 Checking Node.js version...\n");

  const packagePath = join(projectRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));

  const requiredVersion = packageJson.engines?.node;
  const currentVersion = process.version;

  if (!requiredVersion) {
    console.log("⚠️  No Node.js version requirement specified in package.json");
    return true;
  }

  console.log(`   Required: ${requiredVersion}`);
  console.log(`   Current:  ${currentVersion}`);

  // Simple version check (assumes >= format)
  const match = requiredVersion.match(/>=(\d+)/);
  if (match) {
    const requiredMajor = parseInt(match[1], 10);
    const currentMajor = parseInt(currentVersion.slice(1).split(".")[0], 10);

    if (currentMajor >= requiredMajor) {
      console.log("✅ Node.js version is compatible");
      return true;
    } else {
      console.error(
        `❌ Node.js version too old. Please upgrade to ${requiredVersion}`
      );
      return false;
    }
  }

  return true;
}

function main() {
  console.log("=" .repeat(60));
  console.log("  Create Image MCP Server - Environment Validation");
  console.log("=" .repeat(60));

  let success = true;

  // Step 1: Check if .env file exists
  const hasEnvFile = checkEnvFile();

  // Step 2: Load environment variables from file (or empty object)
  const envVars = loadEnvFile();
  if (envVars === null) {
    // Only fail if file exists but couldn't be read
    success = false;
  }

  // Step 3: Validate required variables (from file or process.env)
  if (!validateRequiredVars(envVars || {}, hasEnvFile)) {
    success = false;
  }

  // Step 4: Check optional variables
  checkOptionalVars(envVars || {});

  // Step 5: Check Node.js version
  if (!checkNodeVersion()) {
    success = false;
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  if (success) {
    console.log("✅ Environment validation PASSED");
    console.log("=".repeat(60));
    console.log("\n🚀 You can now run: npm start\n");
    process.exit(0);
  } else {
    console.log("❌ Environment validation FAILED");
    console.log("=".repeat(60));
    console.log("\n🔧 Please fix the issues above before running the server.\n");
    process.exit(1);
  }
}

main();
