import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveEnv, ENV_FILE_KEYS } from "../../src/env.js";

describe("resolveEnv", () => {
  let root;
  let cwd;
  let home;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "create-image-env-"));
    cwd = join(root, "project");
    home = join(root, "home");
    mkdirSync(cwd);
    mkdirSync(home);
    writeFileSync(join(cwd, ".env"), [
      "OPENAI_API_KEY=cwd-key",
      "OPENAI_BASE_URL=https://attacker.example",
    ].join("\n"));
    writeFileSync(join(home, ".env"), [
      "OPENAI_API_KEY=home-key",
      "OPENAI_IMAGE_MODEL=gpt-image-2.5-flare",
    ].join("\n"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("should prefer real environment variables over .env files", () => {
    const env = resolveEnv({ env: { OPENAI_API_KEY: "env-key" }, cwd, home });
    assert.deepStrictEqual(env.OPENAI_API_KEY, { value: "env-key", source: "environment" });
  });

  it("should prefer the working directory .env over ~/.env", () => {
    const env = resolveEnv({ env: {}, cwd, home });
    assert.strictEqual(env.OPENAI_API_KEY.value, "cwd-key");
    assert.strictEqual(env.OPENAI_API_KEY.source, join(cwd, ".env"));
  });

  it("should fall back to ~/.env for keys the working directory lacks", () => {
    const env = resolveEnv({ env: {}, cwd, home });
    assert.strictEqual(env.OPENAI_IMAGE_MODEL.value, "gpt-image-2.5-flare");
    assert.strictEqual(env.OPENAI_IMAGE_MODEL.source, join(home, ".env"));
  });

  it("should never take keys outside the allowlist from .env files", () => {
    const env = resolveEnv({ env: {}, cwd, home });
    assert.strictEqual(env.OPENAI_BASE_URL, undefined);
    assert.deepStrictEqual(ENV_FILE_KEYS, ["OPENAI_API_KEY", "OPENAI_IMAGE_MODEL"]);
  });

  it("should keep an explicitly empty environment variable instead of reading files", () => {
    const env = resolveEnv({ env: { OPENAI_API_KEY: "" }, cwd, home });
    assert.deepStrictEqual(env.OPENAI_API_KEY, { value: "", source: "environment" });
  });

  it("should tolerate missing .env files", () => {
    const env = resolveEnv({ env: {}, cwd: join(root, "nowhere"), home: join(root, "nobody") });
    assert.deepStrictEqual(env, {});
  });
});
