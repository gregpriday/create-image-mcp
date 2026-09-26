#!/usr/bin/env node

/**
 * Integration test for the Create Image MCP Server.
 *
 * Tests the full MCP protocol lifecycle:
 * 1. Server startup
 * 2. Initialize handshake
 * 3. List tools
 * 4. Validate tool schema
 *
 * Live image generation costs money, so it only runs when CREATE_IMAGE_LIVE_TEST=1
 * and OPENAI_API_KEY are both set.
 * Run with: npm run test:integration (or CREATE_IMAGE_LIVE_TEST=1 npm run test:integration)
 */

import { spawn } from "child_process";
import { existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

let requestId = 0;

// MCP SDK v1.26+ uses newline-delimited JSON (not Content-Length framing)
function encodeMessage(obj) {
  return JSON.stringify(obj) + "\n";
}

// Accumulated buffer and pending request tracking
let stdoutBuffer = "";
const pendingRequests = new Map();
const protocolErrors = [];

function rejectAllPending(error) {
  for (const { reject, timeout } of pendingRequests.values()) {
    clearTimeout(timeout);
    reject(error);
  }
  pendingRequests.clear();
}

function setupStdoutHandler(serverProcess) {
  serverProcess.stdout.on("data", (data) => {
    stdoutBuffer += data.toString();

    // Parse newline-delimited JSON messages
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const frame = JSON.parse(line);
        if (frame?.jsonrpc !== "2.0") {
          protocolErrors.push(line.substring(0, 200));
          continue;
        }
        if (frame.id !== undefined && pendingRequests.has(frame.id)) {
          const { resolve, timeout } = pendingRequests.get(frame.id);
          clearTimeout(timeout);
          pendingRequests.delete(frame.id);
          resolve(frame);
        }
      } catch (e) {
        // Anything on stdout that isn't a JSON-RPC message breaks MCP clients
        protocolErrors.push(line.substring(0, 200));
      }
    }
  });
}

function sendRequest(serverProcess, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} (id: ${id})`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timeout });
    serverProcess.stdin.write(encodeMessage(request));
  });
}

function sendNotification(serverProcess, method, params = {}) {
  const notification = {
    jsonrpc: "2.0",
    method,
    params,
  };
  serverProcess.stdin.write(encodeMessage(notification));
}

async function runTests() {
  console.log("=".repeat(60));
  console.log("  Create Image MCP Server - Integration Tests");
  console.log("=".repeat(60));

  // Live generation is opt-in because it bills the API key
  const runLive = process.env.CREATE_IMAGE_LIVE_TEST === "1";
  if (runLive && !process.env.OPENAI_API_KEY) {
    console.error("\n❌ CREATE_IMAGE_LIVE_TEST=1 requires OPENAI_API_KEY in the environment.");
    process.exitCode = 1;
    return;
  }
  if (!runLive) {
    console.log("\nℹ️  Skipping live generation. Set CREATE_IMAGE_LIVE_TEST=1 and OPENAI_API_KEY to run it (costs a few cents).\n");
  }

  // Start the server
  console.log("\n🚀 Starting MCP server...");
  const serverProcess = spawn("node", [join(projectRoot, "src", "index.js")], {
    env: { ...process.env, OPENAI_API_KEY: runLive ? process.env.OPENAI_API_KEY : "test-key-for-startup" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  serverProcess.on("error", (error) => rejectAllPending(new Error(`Server failed to start: ${error.message}`)));
  serverProcess.on("exit", (code, signal) => rejectAllPending(new Error(`Server exited early (code ${code}, signal ${signal})`)));

  let stderrOutput = "";
  serverProcess.stderr.on("data", (data) => {
    stderrOutput += data.toString();
  });

  setupStdoutHandler(serverProcess);

  // Wait for server startup
  await new Promise((resolve) => setTimeout(resolve, 1500));

  try {
    // ─── Test 1: Initialize ───
    console.log("\n📡 Test 1: MCP Initialize handshake...");
    const initResponse = await sendRequest(serverProcess, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });

    if (initResponse.error) {
      throw new Error(`Initialize failed: ${JSON.stringify(initResponse.error)}`);
    }

    console.log(`   ✅ Server: ${initResponse.result.serverInfo.name} v${initResponse.result.serverInfo.version}`);
    console.log(`   ✅ Protocol: ${initResponse.result.protocolVersion}`);
    console.log(`   ✅ Capabilities: tools=${!!initResponse.result.capabilities.tools}`);

    // Send initialized notification
    sendNotification(serverProcess, "notifications/initialized");
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ─── Test 2: List Tools ───
    console.log("\n🔧 Test 2: List available tools...");
    const toolsResponse = await sendRequest(serverProcess, "tools/list");

    if (toolsResponse.error) {
      throw new Error(`List tools failed: ${JSON.stringify(toolsResponse.error)}`);
    }

    const tools = toolsResponse.result.tools;
    console.log(`   ✅ Found ${tools.length} tool(s)`);

    const createImageTool = tools.find((t) => t.name === "create_image");
    if (!createImageTool) {
      throw new Error("create_image tool not found");
    }
    console.log(`   ✅ create_image tool found`);

    // Validate schema
    const props = createImageTool.inputSchema.properties;
    const expectedProps = [
      "prompt", "model", "style", "input_images", "output_file", "size",
      "quality", "background", "number_of_images", "output_mime_type", "output_compression",
      "moderation", "system_message_file", "mask", "input_fidelity",
    ];

    for (const prop of expectedProps) {
      if (!props[prop]) {
        throw new Error(`Missing property in schema: ${prop}`);
      }
    }
    // Also check no unexpected properties
    const actualProps = Object.keys(props);
    for (const prop of actualProps) {
      if (!expectedProps.includes(prop)) {
        throw new Error(`Unexpected property in schema: ${prop}`);
      }
    }
    console.log(`   ✅ All ${expectedProps.length} properties present in schema`);

    // Validate model options
    for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"]) {
      if (!props.model.enum.includes(model)) {
        throw new Error(`Model enum missing ${model}`);
      }
    }
    console.log(`   ✅ Models: ${props.model.enum.join(", ")}`);

    if (props.size.default !== "1024x1024") {
      throw new Error(`Expected default size 1024x1024, got ${props.size.default}`);
    }
    console.log(`   ✅ Default size is 1024x1024`);

    if (props.quality.default !== "auto") {
      throw new Error(`Expected default quality auto, got ${props.quality.default}`);
    }
    console.log(`   ✅ Default quality is auto`);

    if (props.number_of_images.default !== 1) {
      throw new Error(`Expected default number_of_images 1, got ${props.number_of_images.default}`);
    }
    console.log(`   ✅ Default number_of_images is 1`);

    // Validate description includes trigger phrases
    const desc = createImageTool.description;
    const requiredPhrases = ["create an image", "edit an image", "draw"];
    for (const phrase of requiredPhrases) {
      if (!desc.includes(phrase)) {
        throw new Error(`Description missing trigger phrase: "${phrase}"`);
      }
    }
    console.log(`   ✅ Description includes all trigger phrases`);

    // ─── Test 3: Input Validation ───
    console.log("\n🔒 Test 3: Input validation (missing prompt)...");
    const emptyResponse = await sendRequest(serverProcess, "tools/call", {
      name: "create_image",
      arguments: {},
    });

    // Validation errors are now returned as tool results with isError: true (not protocol errors)
    if (emptyResponse.error) {
      throw new Error("Expected tool-level error (isError), not protocol error");
    }
    const toolResult = emptyResponse.result;
    if (!toolResult.isError) {
      throw new Error("Expected isError: true for missing prompt");
    }
    const errorText = toolResult.content[0].text;
    if (!errorText.includes("Missing required parameter: prompt")) {
      throw new Error(`Unexpected error text: ${errorText}`);
    }
    console.log(`   ✅ Missing prompt correctly rejected as tool error: ${errorText.substring(0, 60)}...`);

    if (protocolErrors.length > 0) {
      throw new Error(`Server wrote non-JSON to stdout: ${protocolErrors.join(" | ")}`);
    }
    console.log("   ✅ stdout carried only JSON-RPC messages");

    // ─── Test 4: Live API (optional) ───
    if (runLive) {
      console.log("\n🎨 Test 4: Live image generation...");
      console.log("   (This may take 10-30 seconds...)");

      const outputPath = join(projectRoot, "test", "fixtures", "integration-test-output.png");
      const generateResponse = await sendRequest(serverProcess, "tools/call", {
        name: "create_image",
        arguments: {
          prompt: "A simple red circle on a white background",
          output_file: outputPath,
          size: "1024x1024",
          quality: "low",
          model: "gpt-image-2.5-flare",
        },
      }, 300000);

      if (generateResponse.error) {
        throw new Error(`Live generation returned a protocol error: ${generateResponse.error.message}`);
      } else {
        const result = generateResponse.result;
        const textContent = result.content.find((c) => c.type === "text");
        if (result.isError) {
          throw new Error(`Live generation failed: ${textContent?.text}`);
        }
        if (textContent && textContent.text.includes("Image saved to:")) {
          try {
            if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
              throw new Error(`Response claimed success but ${outputPath} is missing or empty`);
            }
            console.log(`   ✅ Image generated and saved (${statSync(outputPath).size} bytes)`);
            console.log(`   ✅ Response: ${textContent.text.substring(0, 160)}`);
          } finally {
            if (existsSync(outputPath)) unlinkSync(outputPath);
          }
        } else {
          throw new Error(`Unexpected response: ${textContent?.text?.substring(0, 100)}`);
        }
      }
    } else {
      console.log("\n⏭️  Test 4: Skipped (live generation not enabled)");
    }

    // Re-check after the live call: logging during generation must not reach stdout either
    if (protocolErrors.length > 0) {
      throw new Error(`Server wrote non-JSON to stdout: ${protocolErrors.join(" | ")}`);
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("✅ All integration tests PASSED");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("\n❌ Integration test FAILED:", error.message);
    if (stderrOutput) {
      console.error("\n📋 Server stderr output:");
      console.error(stderrOutput);
    }
    process.exitCode = 1;
  } finally {
    // Clean up
    serverProcess.removeAllListeners("exit");
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

runTests();
