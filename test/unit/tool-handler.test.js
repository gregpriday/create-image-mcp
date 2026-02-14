import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, statSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import mime from "mime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "..", "fixtures");

// Ensure fixtures directory exists
if (!existsSync(fixturesDir)) {
  mkdirSync(fixturesDir, { recursive: true });
}

// Create a tiny valid PNG for testing (1x1 pixel)
const TINY_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

const TINY_PNG_PATH = join(fixturesDir, "test-image.png");
const TINY_JPEG_PATH = join(fixturesDir, "test-image.jpg");
writeFileSync(TINY_PNG_PATH, TINY_PNG_BUFFER);
writeFileSync(TINY_JPEG_PATH, TINY_PNG_BUFFER); // Same bytes, different extension for mime detection

// Default output path for tests that need one
const DEFAULT_OUTPUT = join(fixturesDir, "test-output.png");

// Standalone readImageFile (mirrors src/index.js without needing OPENAI_API_KEY)
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function readImageFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Input image file not found: ${filePath}`);
  }
  const stats = statSync(filePath);
  if (stats.size > MAX_IMAGE_SIZE) {
    throw new Error(`Input image exceeds 20MB limit: ${filePath} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
  }
  const mimeType = mime.getType(filePath);
  if (!mimeType || !SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
    throw new Error(`Unsupported image type for ${filePath}. Supported: ${SUPPORTED_IMAGE_TYPES.join(", ")}`);
  }
  const data = readFileSync(filePath);
  return { data, mimeType };
}

// Mock OpenAI API
class MockOpenAI {
  constructor(options = {}) {
    this.callCount = 0;
    this.lastRequest = null;
    this.lastEndpoint = null;
    this.errors = options.errors || [];

    // Default: return a single image
    const defaultResponse = MockOpenAI.defaultImageResponse();
    this.generateResponses = options.generateResponses || [defaultResponse];
    this.editResponses = options.editResponses || [defaultResponse];

    this.images = {
      generate: async (params) => {
        this.lastRequest = params;
        this.lastEndpoint = "generate";
        this.callCount++;

        if (this.errors.length > 0 && this.callCount <= this.errors.length) {
          throw this.errors[this.callCount - 1];
        }

        const idx = Math.min(this.callCount - 1 - this.errors.length, this.generateResponses.length - 1);
        return this.generateResponses[idx];
      },
      edit: async (params) => {
        this.lastRequest = params;
        this.lastEndpoint = "edit";
        this.callCount++;

        if (this.errors.length > 0 && this.callCount <= this.errors.length) {
          throw this.errors[this.callCount - 1];
        }

        const idx = Math.min(this.callCount - 1 - this.errors.length, this.editResponses.length - 1);
        return this.editResponses[idx];
      },
    };
  }

  static defaultImageResponse(count = 1) {
    const data = [];
    for (let i = 0; i < count; i++) {
      data.push({
        b64_json: TINY_PNG_BUFFER.toString("base64"),
      });
    }
    return { data };
  }

  static emptyResponse() {
    return { data: [] };
  }

  static noImageResponse() {
    return { data: [{}] };
  }
}

/**
 * Simulates the handleCreateImage logic from src/index.js for unit testing.
 * Mirrors the production code so we can test without starting the server.
 */
async function handleCreateImage(args, mockAPI) {
  const {
    prompt,
    input_images: inputImages,
    output_file: outputFile,
    size = "1024x1024",
    quality = "auto",
    background = "auto",
    number_of_images: numberOfImages = 1,
    output_mime_type: outputMimeType = "image/png",
    system_message_file: systemMessageFile,
  } = args;

  const VALID_SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"];
  const VALID_QUALITIES = ["low", "medium", "high", "auto"];
  const VALID_BACKGROUNDS = ["transparent", "opaque", "auto"];
  const VALID_OUTPUT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

  // Input validation for prompt
  if (!prompt) {
    throw new Error("Missing required parameter: prompt");
  }
  if (typeof prompt !== "string") {
    throw new Error("Prompt must be a string");
  }
  if (prompt.trim().length === 0) {
    throw new Error("Prompt cannot be empty");
  }
  if (prompt.length > 32000) {
    throw new Error("Prompt exceeds maximum length of 32000 characters");
  }

  // Input validation for system_message_file
  let systemMessage = null;
  if (systemMessageFile !== undefined && systemMessageFile !== null) {
    if (typeof systemMessageFile !== "string") {
      throw new Error("system_message_file must be a string");
    }
    if (systemMessageFile.trim().length === 0) {
      throw new Error("system_message_file cannot be empty");
    }
    if (!existsSync(systemMessageFile)) {
      throw new Error(`System message file not found: ${systemMessageFile}`);
    }
    systemMessage = readFileSync(systemMessageFile, "utf-8");
    if (systemMessage.length > 4000) {
      systemMessage = systemMessage.slice(0, 4000);
    }
  }

  // Input validation for input_images
  if (inputImages !== undefined && inputImages !== null) {
    if (!Array.isArray(inputImages)) {
      throw new Error("input_images must be an array of file paths");
    }
    if (inputImages.length === 0) {
      throw new Error("input_images cannot be an empty array");
    }
    for (const imgPath of inputImages) {
      if (typeof imgPath !== "string" || imgPath.trim().length === 0) {
        throw new Error("Each input_images entry must be a non-empty string file path");
      }
    }
  }

  // Input validation for output_file (required)
  if (!outputFile) {
    throw new Error("Missing required parameter: output_file");
  }
  if (typeof outputFile !== "string") {
    throw new Error("output_file must be a string");
  }
  if (outputFile.trim().length === 0) {
    throw new Error("output_file cannot be empty");
  }

  if (!VALID_SIZES.includes(size)) {
    throw new Error(`size must be one of: ${VALID_SIZES.join(", ")}. Got: ${size}`);
  }
  if (!VALID_QUALITIES.includes(quality)) {
    throw new Error(`quality must be one of: ${VALID_QUALITIES.join(", ")}. Got: ${quality}`);
  }
  if (!VALID_BACKGROUNDS.includes(background)) {
    throw new Error(`background must be one of: ${VALID_BACKGROUNDS.join(", ")}. Got: ${background}`);
  }
  if (!Number.isInteger(numberOfImages) || numberOfImages < 1 || numberOfImages > 4) {
    throw new Error(`number_of_images must be an integer between 1 and 4. Got: ${numberOfImages}`);
  }
  if (!VALID_OUTPUT_MIME_TYPES.includes(outputMimeType)) {
    throw new Error(`output_mime_type must be one of: ${VALID_OUTPUT_MIME_TYPES.join(", ")}. Got: ${outputMimeType}`);
  }

  try {
    // Map output_mime_type to OpenAI output_format
    const outputFormatMap = {
      "image/png": "png",
      "image/jpeg": "jpeg",
      "image/webp": "webp",
    };
    const outputFormat = outputFormatMap[outputMimeType];

    // Prepend system message to prompt if provided
    const effectivePrompt = systemMessage && systemMessage.trim().length > 0
      ? `${systemMessage.trim()}\n\n${prompt}`
      : prompt;

    const hasInputImages = inputImages && inputImages.length > 0;

    // Read input images if provided
    let imageData = [];
    if (hasInputImages) {
      for (const imgPath of inputImages) {
        imageData.push(readImageFile(imgPath));
      }
    }

    const outputImages = [];

    let result;
    if (hasInputImages) {
      result = await mockAPI.images.edit({
        model: "gpt-image-1.5",
        image: imageData.length === 1 ? imageData[0] : imageData,
        prompt: effectivePrompt,
        size,
        n: numberOfImages,
      });
    } else {
      result = await mockAPI.images.generate({
        model: "gpt-image-1.5",
        prompt: effectivePrompt,
        size,
        quality,
        background,
        output_format: outputFormat,
        n: numberOfImages,
      });
    }

    if (result.data) {
      for (const entry of result.data) {
        if (entry.b64_json) {
          outputImages.push({
            data: entry.b64_json,
            mimeType: outputMimeType,
          });
        }
      }
    }

    if (outputImages.length === 0) {
      return {
        content: [{ type: "text", text: "[NO_IMAGE] No image was generated. The model may have declined the request." }],
      };
    }

    // Save images to disk
    const savedFiles = [];
    const ext = extname(outputFile);
    const baseName = outputFile.slice(0, outputFile.length - ext.length);
    const outputDir = dirname(outputFile);
    if (outputDir && !existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    for (let i = 0; i < outputImages.length; i++) {
      const fileName = outputImages.length === 1 ? outputFile : `${baseName}_${i + 1}${ext}`;
      const buffer = Buffer.from(outputImages[i].data, "base64");
      writeFileSync(fileName, buffer);
      savedFiles.push({
        path: fileName,
        mimeType: outputImages[i].mimeType,
        size: buffer.length,
      });
    }

    // Build text-only response with file paths and metadata
    const lines = [];
    for (const file of savedFiles) {
      const sizeKB = (file.size / 1024).toFixed(1);
      lines.push(`Image saved to: ${file.path} (${sizeKB} KB, ${file.mimeType})`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (error) {
    const errorMessage = error.message || "Image generation failed";
    const lowerMessage = errorMessage.toLowerCase();

    if (lowerMessage.includes("api key") || lowerMessage.includes("authentication") || lowerMessage.includes("unauthorized")) {
      throw new Error(`[AUTH_ERROR] Invalid or missing API key: ${errorMessage}`);
    } else if (lowerMessage.includes("quota") || lowerMessage.includes("rate limit") || lowerMessage.includes("billing")) {
      throw new Error(`[QUOTA_ERROR] API quota exceeded: ${errorMessage}`);
    } else if (lowerMessage.includes("timeout")) {
      throw new Error(`[TIMEOUT_ERROR] Request timed out: ${errorMessage}`);
    } else if (lowerMessage.includes("safety") || lowerMessage.includes("blocked") || lowerMessage.includes("content_policy")) {
      throw new Error(`[SAFETY_ERROR] Request blocked by safety filters: ${errorMessage}`);
    } else {
      throw new Error(`[API_ERROR] OpenAI API error: ${errorMessage}`);
    }
  }
}

// Helper to clean up output files after tests
function cleanup(...paths) {
  for (const p of paths) {
    if (existsSync(p)) unlinkSync(p);
  }
}

// ─── Input Validation Tests ───

describe("Input Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should reject missing prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ output_file: DEFAULT_OUTPUT }, mockAPI),
      /Missing required parameter: prompt/
    );
  });

  it("should reject null prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: null, output_file: DEFAULT_OUTPUT }, mockAPI),
      /Missing required parameter: prompt/
    );
  });

  it("should reject undefined prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: undefined, output_file: DEFAULT_OUTPUT }, mockAPI),
      /Missing required parameter: prompt/
    );
  });

  it("should reject non-string prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: 123, output_file: DEFAULT_OUTPUT }, mockAPI),
      /Prompt must be a string/
    );
  });

  it("should reject empty string prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "   ", output_file: DEFAULT_OUTPUT }, mockAPI),
      /Prompt cannot be empty/
    );
  });

  it("should reject prompt exceeding max length", async () => {
    const longPrompt = "x".repeat(32001);
    await assert.rejects(
      () => handleCreateImage({ prompt: longPrompt, output_file: DEFAULT_OUTPUT }, mockAPI),
      /Prompt exceeds maximum length of 32000 characters/
    );
  });

  it("should accept prompt at max length boundary", async () => {
    const maxPrompt = "x".repeat(32000);
    try {
      const result = await handleCreateImage({ prompt: maxPrompt, output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.ok(result.content.length > 0);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should reject missing output_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test" }, mockAPI),
      /Missing required parameter: output_file/
    );
  });

  it("should reject null output_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: null }, mockAPI),
      /Missing required parameter: output_file/
    );
  });
});

// ─── Input Images Validation ───

describe("Input Images Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should reject non-array input_images", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: "not-array" }, mockAPI),
      /input_images must be an array/
    );
  });

  it("should reject empty input_images array", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [] }, mockAPI),
      /input_images cannot be an empty array/
    );
  });

  it("should reject input_images with non-string entries", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [123] }, mockAPI),
      /Each input_images entry must be a non-empty string/
    );
  });

  it("should reject input_images with empty string entries", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: ["  "] }, mockAPI),
      /Each input_images entry must be a non-empty string/
    );
  });

  it("should accept valid input_images with existing files", async () => {
    try {
      const result = await handleCreateImage(
        { prompt: "edit this image", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH] },
        mockAPI
      );
      assert.ok(result.content.length > 0);
      // Should have used edit endpoint
      assert.strictEqual(mockAPI.lastEndpoint, "edit");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should accept multiple input images", async () => {
    try {
      const result = await handleCreateImage(
        { prompt: "combine these", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH, TINY_JPEG_PATH] },
        mockAPI
      );
      assert.ok(result.content.length > 0);
      assert.strictEqual(mockAPI.lastEndpoint, "edit");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should use generate endpoint when no input_images", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.strictEqual(mockAPI.lastEndpoint, "generate");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Output File Validation ───

describe("Output File Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should reject non-string output_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: 123 }, mockAPI),
      /output_file must be a string/
    );
  });

  it("should reject empty output_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: "  " }, mockAPI),
      /output_file cannot be empty/
    );
  });

  it("should save image to output_file and return text response", async () => {
    const outputPath = join(fixturesDir, "output-test.png");
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: outputPath },
        mockAPI
      );
      assert.ok(existsSync(outputPath));
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.ok(result.content[0].text.includes("Image saved to:"));
      assert.ok(result.content[0].text.includes(outputPath));
      assert.ok(result.content[0].text.includes("KB"));
      assert.ok(result.content[0].text.includes("image/png"));
    } finally {
      cleanup(outputPath);
    }
  });

  it("should not return base64 image data in response", async () => {
    const outputPath = join(fixturesDir, "no-base64-test.png");
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: outputPath },
        mockAPI
      );
      const imageContent = result.content.find(c => c.type === "image");
      assert.strictEqual(imageContent, undefined);
    } finally {
      cleanup(outputPath);
    }
  });

  it("should number multiple output files", async () => {
    const mockMulti = new MockOpenAI({
      generateResponses: [MockOpenAI.defaultImageResponse(2)],
    });
    const outputPath = join(fixturesDir, "multi-output.png");
    const file1 = join(fixturesDir, "multi-output_1.png");
    const file2 = join(fixturesDir, "multi-output_2.png");
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: outputPath, number_of_images: 2 },
        mockMulti
      );
      assert.ok(result.content[0].text.includes("multi-output_1.png"));
      assert.ok(result.content[0].text.includes("multi-output_2.png"));
      assert.ok(existsSync(file1));
      assert.ok(existsSync(file2));
    } finally {
      cleanup(file1, file2);
    }
  });
});

// ─── Size Validation ───

describe("Size Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should accept all valid sizes", async () => {
    const sizes = ["1024x1024", "1024x1536", "1536x1024", "auto"];
    for (const s of sizes) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, size: s }, mockAPI);
        assert.ok(result.content.length > 0, `Failed for size: ${s}`);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should reject invalid size", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, size: "512x512" }, mockAPI),
      /size must be one of/
    );
  });

  it("should default to 1024x1024", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.size, "1024x1024");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Quality Validation ───

describe("Quality Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should accept all valid qualities", async () => {
    for (const q of ["low", "medium", "high", "auto"]) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, quality: q }, mockAPI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should reject invalid quality", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, quality: "hd" }, mockAPI),
      /quality must be one of/
    );
  });

  it("should default to auto", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.quality, "auto");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Background Validation ───

describe("Background Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should accept all valid backgrounds", async () => {
    for (const bg of ["transparent", "opaque", "auto"]) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, background: bg }, mockAPI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should reject invalid background", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, background: "none" }, mockAPI),
      /background must be one of/
    );
  });

  it("should default to auto", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.background, "auto");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── System Message File Tests ───

const SYSTEM_MSG_PATH = join(fixturesDir, "system-message.txt");
const SYSTEM_MSG_WHITESPACE_PATH = join(fixturesDir, "system-message-whitespace.txt");
const SYSTEM_MSG_LONG_PATH = join(fixturesDir, "system-message-long.txt");

describe("System Message File", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should prepend file contents to prompt", async () => {
    writeFileSync(SYSTEM_MSG_PATH, "Always use flat vector style.");
    try {
      await handleCreateImage({
        prompt: "A red circle",
        output_file: DEFAULT_OUTPUT,
        system_message_file: SYSTEM_MSG_PATH,
      }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.prompt, "Always use flat vector style.\n\nA red circle");
    } finally {
      cleanup(DEFAULT_OUTPUT, SYSTEM_MSG_PATH);
    }
  });

  it("should not modify prompt when system_message_file is not provided", async () => {
    try {
      await handleCreateImage({ prompt: "A red circle", output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.prompt, "A red circle");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should not modify prompt when file contains only whitespace", async () => {
    writeFileSync(SYSTEM_MSG_WHITESPACE_PATH, "   \n  \n  ");
    try {
      await handleCreateImage({
        prompt: "A red circle",
        output_file: DEFAULT_OUTPUT,
        system_message_file: SYSTEM_MSG_WHITESPACE_PATH,
      }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.prompt, "A red circle");
    } finally {
      cleanup(DEFAULT_OUTPUT, SYSTEM_MSG_WHITESPACE_PATH);
    }
  });

  it("should trim file contents before prepending", async () => {
    writeFileSync(SYSTEM_MSG_PATH, "  Use watercolor style.  \n");
    try {
      await handleCreateImage({
        prompt: "A red circle",
        output_file: DEFAULT_OUTPUT,
        system_message_file: SYSTEM_MSG_PATH,
      }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.prompt, "Use watercolor style.\n\nA red circle");
    } finally {
      cleanup(DEFAULT_OUTPUT, SYSTEM_MSG_PATH);
    }
  });

  it("should reject non-string system_message_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, system_message_file: 123 }, mockAPI),
      /system_message_file must be a string/
    );
  });

  it("should reject empty system_message_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, system_message_file: "  " }, mockAPI),
      /system_message_file cannot be empty/
    );
  });

  it("should reject non-existent file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, system_message_file: "/nonexistent/file.txt" }, mockAPI),
      /System message file not found/
    );
  });

  it("should truncate file contents exceeding 4000 characters", async () => {
    const longContent = "A".repeat(5000);
    writeFileSync(SYSTEM_MSG_LONG_PATH, longContent);
    try {
      await handleCreateImage({
        prompt: "A red circle",
        output_file: DEFAULT_OUTPUT,
        system_message_file: SYSTEM_MSG_LONG_PATH,
      }, mockAPI);
      const expectedPrefix = "A".repeat(4000);
      assert.ok(mockAPI.lastRequest.prompt.startsWith(expectedPrefix));
      assert.ok(mockAPI.lastRequest.prompt.endsWith("\n\nA red circle"));
    } finally {
      cleanup(DEFAULT_OUTPUT, SYSTEM_MSG_LONG_PATH);
    }
  });

  it("should prepend file contents when using edit endpoint", async () => {
    writeFileSync(SYSTEM_MSG_PATH, "Use oil painting style.");
    try {
      await handleCreateImage({
        prompt: "Make it blue",
        output_file: DEFAULT_OUTPUT,
        input_images: [TINY_PNG_PATH],
        system_message_file: SYSTEM_MSG_PATH,
      }, mockAPI);
      assert.strictEqual(mockAPI.lastEndpoint, "edit");
      assert.strictEqual(mockAPI.lastRequest.prompt, "Use oil painting style.\n\nMake it blue");
    } finally {
      cleanup(DEFAULT_OUTPUT, SYSTEM_MSG_PATH);
    }
  });
});

// ─── Number of Images Validation ───

describe("Number of Images Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should accept values 1-4", async () => {
    for (let n = 1; n <= 4; n++) {
      const mock = new MockOpenAI({
        generateResponses: [MockOpenAI.defaultImageResponse(n)],
      });
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: n }, mock);
        assert.ok(result.content.length > 0);
      } finally {
        // Clean up numbered files
        cleanup(DEFAULT_OUTPUT);
        for (let i = 1; i <= n; i++) {
          cleanup(join(fixturesDir, `test-output_${i}.png`));
        }
      }
    }
  });

  it("should reject 0", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 0 }, mockAPI),
      /number_of_images must be an integer between 1 and 4/
    );
  });

  it("should reject 5", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 5 }, mockAPI),
      /number_of_images must be an integer between 1 and 4/
    );
  });

  it("should reject non-integer", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 1.5 }, mockAPI),
      /number_of_images must be an integer between 1 and 4/
    );
  });

  it("should pass n to API request", async () => {
    const mock = new MockOpenAI({
      generateResponses: [MockOpenAI.defaultImageResponse(2)],
    });
    const file1 = join(fixturesDir, "test-output_1.png");
    const file2 = join(fixturesDir, "test-output_2.png");
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 2 }, mock);
      assert.strictEqual(mock.lastRequest.n, 2);
    } finally {
      cleanup(file1, file2);
    }
  });
});

// ─── Output MIME Type Validation ───

describe("Output MIME Type Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should accept image/png, image/jpeg, and image/webp", async () => {
    for (const mt of ["image/png", "image/jpeg", "image/webp"]) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, output_mime_type: mt }, mockAPI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should reject invalid mime type", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, output_mime_type: "image/gif" }, mockAPI),
      /output_mime_type must be one of/
    );
  });

  it("should map output_mime_type to output_format in API request", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, output_mime_type: "image/jpeg" }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.output_format, "jpeg");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should default to png", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.output_format, "png");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Successful Response Tests ───

describe("Successful Responses", () => {
  it("should return text-only response with file path", async () => {
    const mockAPI = new MockOpenAI();
    const outputPath = join(fixturesDir, "success-test.png");
    try {
      const result = await handleCreateImage({ prompt: "A mountain landscape", output_file: outputPath }, mockAPI);

      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.ok(result.content[0].text.includes("Image saved to:"));
      assert.ok(result.content[0].text.includes("image/png"));
      assert.ok(existsSync(outputPath));
    } finally {
      cleanup(outputPath);
    }
  });

  it("should handle empty response (no images)", async () => {
    const mockAPI = new MockOpenAI({
      generateResponses: [MockOpenAI.emptyResponse()],
    });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);

    assert.strictEqual(result.content.length, 1);
    assert.ok(result.content[0].text.includes("[NO_IMAGE]"));
    assert.ok(result.content[0].text.includes("model may have declined"));
  });

  it("should handle response with no b64_json", async () => {
    const mockAPI = new MockOpenAI({
      generateResponses: [MockOpenAI.noImageResponse()],
    });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);

    assert.strictEqual(result.content.length, 1);
    assert.ok(result.content[0].text.includes("[NO_IMAGE]"));
  });

  it("should save multiple images with numbered filenames", async () => {
    const mockAPI = new MockOpenAI({
      generateResponses: [MockOpenAI.defaultImageResponse(3)],
    });
    const outputPath = join(fixturesDir, "multi-success.png");
    const files = [
      join(fixturesDir, "multi-success_1.png"),
      join(fixturesDir, "multi-success_2.png"),
      join(fixturesDir, "multi-success_3.png"),
    ];
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: outputPath, number_of_images: 3 }, mockAPI);

      assert.strictEqual(result.content.length, 1);
      for (const f of files) {
        assert.ok(result.content[0].text.includes(f.split("/").pop()));
        assert.ok(existsSync(f));
      }
    } finally {
      cleanup(...files);
    }
  });

  it("should pass all config parameters to API", async () => {
    const mockAPI = new MockOpenAI();
    const outputPath = join(fixturesDir, "config-test.png");
    try {
      await handleCreateImage({
        prompt: "test",
        output_file: outputPath,
        size: "1536x1024",
        quality: "high",
        background: "transparent",
        output_mime_type: "image/jpeg",
      }, mockAPI);

      const req = mockAPI.lastRequest;
      assert.strictEqual(req.size, "1536x1024");
      assert.strictEqual(req.quality, "high");
      assert.strictEqual(req.background, "transparent");
      assert.strictEqual(req.output_format, "jpeg");
      assert.strictEqual(req.model, "gpt-image-1.5");
    } finally {
      cleanup(outputPath);
    }
  });

  it("should use edit endpoint when input_images provided", async () => {
    const mockAPI = new MockOpenAI();
    const outputPath = join(fixturesDir, "edit-test.png");
    try {
      await handleCreateImage({
        prompt: "edit this",
        output_file: outputPath,
        input_images: [TINY_PNG_PATH],
      }, mockAPI);

      assert.strictEqual(mockAPI.lastEndpoint, "edit");
      assert.ok(mockAPI.lastRequest.image);
    } finally {
      cleanup(outputPath);
    }
  });
});

// ─── Error Handling Tests ───

describe("Error Handling", () => {
  it("should categorize auth errors", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("Invalid api key provided")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI),
      /\[AUTH_ERROR\]/
    );
  });

  it("should categorize authentication errors", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("Authentication failed")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI),
      /\[AUTH_ERROR\]/
    );
  });

  it("should categorize quota errors", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("Quota exceeded for this project")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI),
      /\[QUOTA_ERROR\]/
    );
  });

  it("should categorize rate limit errors", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("Rate limit reached")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI),
      /\[QUOTA_ERROR\]/
    );
  });

  it("should categorize billing errors", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("Billing hard limit reached")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI),
      /\[QUOTA_ERROR\]/
    );
  });

  it("should categorize timeout errors", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("Request timeout after 30s")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI),
      /\[TIMEOUT_ERROR\]/
    );
  });

  it("should categorize safety errors", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("Content blocked by safety filters")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI),
      /\[SAFETY_ERROR\]/
    );
  });

  it("should categorize content_policy errors", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("content_policy_violation")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI),
      /\[SAFETY_ERROR\]/
    );
  });

  it("should categorize generic errors", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("Something went wrong")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI),
      /\[API_ERROR\]/
    );
  });
});

// ─── Edge Cases ───

describe("Edge Cases", () => {
  it("should handle special characters in prompt", async () => {
    const mockAPI = new MockOpenAI();
    try {
      const result = await handleCreateImage(
        { prompt: 'A "quoted" image with <html> & special chars!', output_file: DEFAULT_OUTPUT },
        mockAPI
      );
      assert.ok(result.content.length > 0);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should handle unicode in prompt", async () => {
    const mockAPI = new MockOpenAI();
    try {
      const result = await handleCreateImage(
        { prompt: "An image of a dragon", output_file: DEFAULT_OUTPUT },
        mockAPI
      );
      assert.ok(result.content.length > 0);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── readImageFile Tests ───

describe("readImageFile", () => {
  it("should throw for non-existent file", () => {
    assert.throws(
      () => readImageFile("/nonexistent/image.png"),
      /Input image file not found/
    );
  });

  it("should throw for unsupported file type", () => {
    const txtPath = join(fixturesDir, "test.txt");
    writeFileSync(txtPath, "not an image");
    try {
      assert.throws(
        () => readImageFile(txtPath),
        /Unsupported image type/
      );
    } finally {
      unlinkSync(txtPath);
    }
  });

  it("should read a valid PNG file", () => {
    const result = readImageFile(TINY_PNG_PATH);
    assert.strictEqual(result.mimeType, "image/png");
    assert.ok(result.data.length > 0);
  });

  it("should read a valid JPEG file", () => {
    const result = readImageFile(TINY_JPEG_PATH);
    assert.strictEqual(result.mimeType, "image/jpeg");
    assert.ok(result.data.length > 0);
  });
});
