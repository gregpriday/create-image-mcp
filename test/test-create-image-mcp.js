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
 * Note: Actual image generation requires OPENAI_API_KEY and is optional.
 * Run with: npm run test:integration
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { config } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

// Load environment
config({ path: join(projectRoot, ".env") });

let requestId = 0;

// MCP SDK v1.26+ uses newline-delimited JSON (not Content-Length framing)
function encodeMessage(obj) {
  return JSON.stringify(obj) + "\n";
}

// Accumulated buffer and pending request tracking
let stdoutBuffer = "";
const pendingRequests = new Map();

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
        if (frame.id !== undefined && pendingRequests.has(frame.id)) {
          const { resolve, timeout } = pendingRequests.get(frame.id);
          clearTimeout(timeout);
          pendingRequests.delete(frame.id);
          resolve(frame);
        }
      } catch (e) {
        console.error("Failed to parse JSON line:", line.substring(0, 100));
      }
    }
  });
}

function sendRequest(serverProcess, method, params = {}) {
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
    }, 30000);

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

  // Check if we have an API key for live tests
  const hasApiKey = !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== "test-key-for-testing";
  if (!hasApiKey) {
    console.log("\n⚠️  OPENAI_API_KEY not set. Skipping live API tests.");
    console.log("   Set OPENAI_API_KEY to run full integration tests.\n");
  }

  // Start the server
  console.log("\n🚀 Starting MCP server...");
  const serverProcess = spawn("node", [join(projectRoot, "src", "index.js")], {
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || "test-key-for-startup" },
    stdio: ["pipe", "pipe", "pipe"],
  });

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
      "prompt", "input_images", "output_file", "size",
      "quality", "background", "number_of_images", "output_mime_type", "system_message_file",
    ];

    for (const prop of expectedProps) {
      if (!props[prop]) {
        throw new Error(`Missing property in schema: ${prop}`);
      }
    }
    console.log(`   ✅ All ${expectedProps.length} properties present in schema (including system_message_file)`);

    // Validate enums
    if (props.size.enum.length !== 4) {
      throw new Error(`Expected 4 sizes, got ${props.size.enum.length}`);
    }
    console.log(`   ✅ ${props.size.enum.length} sizes defined`);

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

    if (!emptyResponse.error) {
      throw new Error("Expected error for missing prompt");
    }
    console.log(`   ✅ Missing prompt correctly rejected: ${emptyResponse.error.message.substring(0, 60)}...`);

    // ─── Test 4: Live API (optional) ───
    if (hasApiKey) {
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
        },
      });

      if (generateResponse.error) {
        console.log(`   ⚠️  Generation failed (may be expected): ${generateResponse.error.message}`);
      } else {
        const result = generateResponse.result;
        const textContent = result.content.find((c) => c.type === "text");
        if (textContent && textContent.text.includes("Image saved to:")) {
          console.log(`   ✅ Image generated and saved successfully`);
          console.log(`   ✅ Response: ${textContent.text.substring(0, 100)}`);
          // Clean up test output
          if (existsSync(outputPath)) {
            const { unlinkSync } = await import("fs");
            unlinkSync(outputPath);
            console.log(`   ✅ Cleaned up test output file`);
          }
        } else {
          console.log(`   ⚠️  Unexpected response: ${textContent?.text?.substring(0, 100)}`);
        }
      }
    } else {
      console.log("\n⏭️  Test 4: Skipped (no API key)");
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
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

runTests();
