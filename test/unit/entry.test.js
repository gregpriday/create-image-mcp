import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, symlinkSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "index.js");

// Empty directory used as both HOME and cwd, so no real .env is ever read
const sandbox = mkdtempSync(join(tmpdir(), "create-image-sandbox-"));
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));

// Minimal env: only what Node needs to run, plus the variables under test
function childEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: sandbox, ...extra };
}

// Start the server, wait for its startup line on stderr, then stop it
function startsServer(entryPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath], {
      cwd: sandbox,
      env: childEnv({ OPENAI_API_KEY: "sk-test-key-for-startup-only" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Server did not start. stderr: ${stderr}`));
    }, 10000);
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stderr.includes("running on stdio")) {
        clearTimeout(timer);
        child.kill();
        resolve(true);
      }
    });
    child.on("error", reject);
  });
}

describe("Entry point detection", () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "create-image-entry-"));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("should start the server when run directly", async () => {
    assert.ok(await startsServer(serverPath));
  });

  it("should start the server through a renamed symlink (npm link / npx)", async () => {
    const link = join(dir, "some-other-name");
    symlinkSync(serverPath, link);
    assert.ok(await startsServer(link));
  });

  it("should not start the server when imported", () => {
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(serverPath)}).then(() => console.log("imported"))`,
    ], { cwd: sandbox, env: childEnv(), encoding: "utf-8", timeout: 10000 });
    assert.strictEqual(output.trim(), "imported");
  });
});

describe("OPENAI_IMAGE_MODEL override", () => {
  it("should become the default model and appear in the schema enum", () => {
    const script = `
      const m = await import(${JSON.stringify(serverPath)});
      const tool = (await m.listToolsHandler()).tools[0];
      console.log(JSON.stringify({ model: m.IMAGE_MODEL, enumValues: tool.inputSchema.properties.model.enum, description: tool.description }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: sandbox,
      env: childEnv({ OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare-2026-09-08" }),
      encoding: "utf-8",
      timeout: 10000,
    });
    const { model, enumValues, description } = JSON.parse(output);
    assert.strictEqual(model, "gpt-image-2.5-flare-2026-09-08");
    assert.deepStrictEqual(enumValues, ["gpt-image-2.5-flare-2026-09-08", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]);
    assert.ok(description.includes("Default: 'gpt-image-2.5-flare-2026-09-08'"));
  });
});
