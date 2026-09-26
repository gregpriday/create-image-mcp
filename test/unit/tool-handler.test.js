import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync, readdirSync, rmdirSync } from "fs";
import { join, extname } from "path";
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";
import {
  handleCreateImage,
  retryWithBackoff,
  readImageFile,
  SIZE_PRESETS,
  VALID_MODELS,
  MAX_INPUT_IMAGES,
  validateSize,
  VALID_QUALITIES,
  VALID_BACKGROUNDS,
  VALID_OUTPUT_MIME_TYPES,
  VALID_INPUT_FIDELITIES,
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_SIZE,
  IMAGE_MODEL,
  getStyle,
  getStyleNames,
  listStyles,
} from "../../src/index.js";

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
// A real 1x1 JPEG: input types are detected from file bytes, not extensions
const TINY_JPEG_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABgYGBgYGCgYGCg4KCgoOEg4ODg4SFxISEhISFxwXFxcXFxccHBwcHBwcHCIiIiIiIicnJycnLCwsLCwsLCwsLP/bAEMBBwcHCwoLEwoKEy4fGh8uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLv/dAAQAAf/aAAwDAQACEQMRAD8A9kooor48+DP/2Q==",
  "base64"
);
writeFileSync(TINY_JPEG_PATH, TINY_JPEG_BUFFER);

// Input fixtures that cleanup() must never delete
const SHARED_FIXTURES = new Set([TINY_PNG_PATH, TINY_JPEG_PATH]);

// Default output path for tests that need one
const DEFAULT_OUTPUT = join(fixturesDir, "test-output.png");

// Mock OpenAI API
class MockOpenAI {
  constructor(options = {}) {
    this.callCount = 0;
    this.lastRequest = null;
    this.lastEndpoint = null;
    this.errors = options.errors || [];

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

// Helper to clean up output files after tests
// Removes each path plus its .png/.jpg/.webp siblings, since the handler
// corrects the output extension to match the format it writes
function cleanup(...paths) {
  for (const p of paths) {
    const base = p.slice(0, p.length - extname(p).length);
    for (const candidate of new Set([p, `${base}.png`, `${base}.jpg`, `${base}.webp`])) {
      if (SHARED_FIXTURES.has(candidate)) continue;
      if (existsSync(candidate)) unlinkSync(candidate);
    }
  }
}

// Helper: assert that a result is a tool error containing the given pattern
function assertToolError(result, pattern) {
  assert.strictEqual(result.isError, true, "Expected isError to be true");
  assert.ok(result.content.length > 0, "Expected error content");
  assert.strictEqual(result.content[0].type, "text");
  if (pattern instanceof RegExp) {
    assert.match(result.content[0].text, pattern);
  } else {
    assert.ok(result.content[0].text.includes(pattern), `Expected "${pattern}" in "${result.content[0].text}"`);
  }
}

// ─── Input Validation Tests ───

describe("Input Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should return tool error for missing prompt", async () => {
    const result = await handleCreateImage({ output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /Missing required parameter: prompt/);
  });

  it("should return tool error for null prompt", async () => {
    const result = await handleCreateImage({ prompt: null, output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /Missing required parameter: prompt/);
  });

  it("should return tool error for non-string prompt", async () => {
    const result = await handleCreateImage({ prompt: 123, output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /Prompt must be a string/);
  });

  it("should return tool error for empty string prompt", async () => {
    const result = await handleCreateImage({ prompt: "   ", output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /Prompt cannot be empty/);
  });

  it("should return tool error for prompt exceeding max length", async () => {
    const longPrompt = "x".repeat(32001);
    const result = await handleCreateImage({ prompt: longPrompt, output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /Prompt exceeds maximum length of 32000 characters/);
  });

  it("should accept prompt at max length boundary", async () => {
    const maxPrompt = "x".repeat(32000);
    try {
      const result = await handleCreateImage({ prompt: maxPrompt, output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.ok(result.content.length > 0);
      assert.strictEqual(result.isError, undefined);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should return tool error for missing output_file", async () => {
    const result = await handleCreateImage({ prompt: "test" }, mockAPI);
    assertToolError(result, /Missing required parameter: output_file/);
  });

  it("should return tool error for null output_file", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: null }, mockAPI);
    assertToolError(result, /Missing required parameter: output_file/);
  });
});

// ─── Input Images Validation ───

describe("Input Images Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should normalize string input_images to array", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: "not-a-real-file.png" }, mockAPI);
    // Should proceed past validation (string gets normalized to ["not-a-real-file.png"])
    // and fail on file read, not on input_images validation
    assert.strictEqual(result.isError, true);
    assert.ok(!result.content[0].text.includes("input_images must be"));
  });

  it("should normalize JSON-encoded array string to array", async () => {
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: DEFAULT_OUTPUT, input_images: JSON.stringify([TINY_PNG_PATH, TINY_JPEG_PATH]) },
        mockAPI
      );
      assert.strictEqual(result.isError, undefined);
      assert.ok(Array.isArray(mockAPI.lastRequest.image));
      assert.strictEqual(mockAPI.lastRequest.image.length, 2);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should return tool error for non-string non-array input_images", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: 123 }, mockAPI);
    assertToolError(result, /input_images must be/);
  });

  it("should return tool error for empty input_images array", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [] }, mockAPI);
    assertToolError(result, /input_images cannot be empty/);
  });

  it("should return tool error for input_images with non-string entries", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [123] }, mockAPI);
    assertToolError(result, /Each input_images entry must be a non-empty string/);
  });

  it("should return tool error for input_images with empty string entries", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: ["  "] }, mockAPI);
    assertToolError(result, /Each input_images entry must be a non-empty string/);
  });

  it("should accept valid input_images with existing files", async () => {
    try {
      const result = await handleCreateImage(
        { prompt: "edit this image", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH] },
        mockAPI
      );
      assert.ok(result.content.length > 0);
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

  it("should return tool error for non-string output_file", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: 123 }, mockAPI);
    assertToolError(result, /output_file must be a string/);
  });

  it("should return tool error for empty output_file", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: "  " }, mockAPI);
    assertToolError(result, /output_file cannot be empty/);
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

  it("should create output directory if it does not exist", async () => {
    const nestedDir = join(fixturesDir, "nested-dir-test");
    const outputPath = join(nestedDir, "output.png");
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: outputPath },
        mockAPI
      );
      assert.ok(existsSync(outputPath));
      assert.ok(result.content[0].text.includes("Image saved to:"));
    } finally {
      cleanup(outputPath);
      if (existsSync(nestedDir)) {
        const { rmdirSync } = await import("fs");
        rmdirSync(nestedDir);
      }
    }
  });
});

// ─── Size Validation ───

describe("Size Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should accept all size presets", async () => {
    for (const s of SIZE_PRESETS) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, size: s }, mockAPI);
        assert.ok(result.content.length > 0, `Failed for size: ${s}`);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should return tool error for invalid size", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, size: "512x512" }, mockAPI);
    assertToolError(result, /between 655,360 and 8,294,400 pixels/);
    assert.strictEqual(mockAPI.callCount, 0);
  });

  it("should pass a valid custom size through to the API", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, size: "1920x1088" }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.size, "1920x1088");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("validateSize should enforce each API limit", () => {
    assert.strictEqual(validateSize("auto"), null);
    assert.strictEqual(validateSize("1024x640"), null);
    assert.strictEqual(validateSize("3840x2160"), null);
    assert.match(validateSize("big"), /WIDTHxHEIGHT/);
    assert.match(validateSize("1000x1000"), /multiples of 16/);
    assert.match(validateSize("4096x2304"), /longest edge/);
    assert.match(validateSize("3840x1024"), /aspect ratio/);
    assert.match(validateSize("1008x640"), /total between/);
    assert.match(validateSize("3840x2176"), /total between/);
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
    for (const q of VALID_QUALITIES) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, quality: q }, mockAPI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should return tool error for invalid quality", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, quality: "hd" }, mockAPI);
    assertToolError(result, /quality must be one of/);
  });

  it("should default to auto", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.quality, "auto");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should pass quality to edit endpoint", async () => {
    try {
      await handleCreateImage({
        prompt: "edit this", output_file: DEFAULT_OUTPUT,
        input_images: [TINY_PNG_PATH], quality: "high",
      }, mockAPI);
      assert.strictEqual(mockAPI.lastEndpoint, "edit");
      assert.strictEqual(mockAPI.lastRequest.quality, "high");
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
    for (const bg of VALID_BACKGROUNDS) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, background: bg }, mockAPI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should return tool error for invalid background", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, background: "none" }, mockAPI);
    assertToolError(result, /background must be one of/);
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

// ─── Cross-field Validation ───

describe("Cross-field Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should reject transparent background with JPEG output", async () => {
    const result = await handleCreateImage({
      prompt: "test", output_file: DEFAULT_OUTPUT,
      background: "transparent", output_mime_type: "image/jpeg",
    }, mockAPI);
    assertToolError(result, /Transparent background requires PNG or WebP/);
  });

  it("should allow transparent background with PNG output", async () => {
    try {
      const result = await handleCreateImage({
        prompt: "test", output_file: DEFAULT_OUTPUT,
        background: "transparent", output_mime_type: "image/png",
      }, mockAPI);
      assert.strictEqual(result.isError, undefined);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should allow transparent background with WebP output", async () => {
    try {
      const result = await handleCreateImage({
        prompt: "test", output_file: DEFAULT_OUTPUT,
        background: "transparent", output_mime_type: "image/webp",
      }, mockAPI);
      assert.strictEqual(result.isError, undefined);
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

  it("should return tool error for non-string system_message_file", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, system_message_file: 123 }, mockAPI);
    assertToolError(result, /system_message_file must be a string/);
  });

  it("should return tool error for empty system_message_file", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, system_message_file: "  " }, mockAPI);
    assertToolError(result, /system_message_file cannot be empty/);
  });

  it("should return tool error for non-existent file", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, system_message_file: "/nonexistent/file.txt" }, mockAPI);
    assertToolError(result, /System message file not found/);
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
        cleanup(DEFAULT_OUTPUT);
        for (let i = 1; i <= n; i++) {
          cleanup(join(fixturesDir, `test-output_${i}.png`));
        }
      }
    }
  });

  it("should return tool error for 0", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 0 }, mockAPI);
    assertToolError(result, /number_of_images must be an integer between 1 and 4/);
  });

  it("should return tool error for 5", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 5 }, mockAPI);
    assertToolError(result, /number_of_images must be an integer between 1 and 4/);
  });

  it("should return tool error for non-integer", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 1.5 }, mockAPI);
    assertToolError(result, /number_of_images must be an integer between 1 and 4/);
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
    for (const mt of VALID_OUTPUT_MIME_TYPES) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, output_mime_type: mt }, mockAPI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should return tool error for invalid mime type", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, output_mime_type: "image/gif" }, mockAPI);
    assertToolError(result, /output_mime_type must be one of/);
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

  it("should pass all config parameters to generate API", async () => {
    const mockAPI = new MockOpenAI();
    const outputPath = join(fixturesDir, "config-test.png");
    try {
      await handleCreateImage({
        prompt: "test",
        output_file: outputPath,
        size: "1536x1024",
        quality: "high",
        background: "transparent",
        output_mime_type: "image/webp",
      }, mockAPI);

      const req = mockAPI.lastRequest;
      assert.strictEqual(req.size, "1536x1024");
      assert.strictEqual(req.quality, "high");
      assert.strictEqual(req.background, "transparent");
      assert.strictEqual(req.output_format, "webp");
      assert.strictEqual(req.model, IMAGE_MODEL);
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
  it("should categorize 401 auth errors", async () => {
    const err = new Error("Unauthorized");
    err.status = 401;
    const mockAPI = new MockOpenAI({ errors: [err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /\[AUTH_ERROR\]/);
  });

  it("should categorize 403 permission errors", async () => {
    const err = new Error("Permission denied");
    err.status = 403;
    const mockAPI = new MockOpenAI({ errors: [err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /\[AUTH_ERROR\]/);
  });

  it("should categorize 429 rate limit errors", async () => {
    const err = new Error("Rate limit exceeded");
    err.status = 429;
    // 429 is retryable, so provide enough errors for all retries
    const mockAPI = new MockOpenAI({ errors: [err, err, err, err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI, { retryDelay: 1 });
    assertToolError(result, /\[QUOTA_ERROR\]/);
  });

  it("should categorize 402 billing errors", async () => {
    const err = new Error("Billing issue");
    err.status = 402;
    const mockAPI = new MockOpenAI({ errors: [err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /\[QUOTA_ERROR\]/);
  });

  it("should categorize 400 content_policy as safety error", async () => {
    const err = new Error("content_policy_violation");
    err.status = 400;
    const mockAPI = new MockOpenAI({ errors: [err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /\[SAFETY_ERROR\]/);
  });

  it("should categorize 400 generic as API error", async () => {
    const err = new Error("Invalid parameter");
    err.status = 400;
    const mockAPI = new MockOpenAI({ errors: [err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /\[API_ERROR\]/);
  });

  it("should categorize 500+ as server error", async () => {
    const err = new Error("Internal server error");
    err.status = 500;
    // 500 is retryable, so provide enough errors for all retries
    const mockAPI = new MockOpenAI({ errors: [err, err, err, err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI, { retryDelay: 1 });
    assertToolError(result, /\[API_ERROR\]/);
  });

  it("should categorize filesystem errors", async () => {
    const err = new Error("Permission denied");
    err.code = "EACCES";
    // Filesystem errors don't have status codes — they'll be retried
    const mockAPI = new MockOpenAI({ errors: [err, err, err, err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI, { retryDelay: 1 });
    assertToolError(result, /\[FILE_ERROR\]/);
  });

  it("should categorize message-based auth errors (not retried)", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("Invalid api key provided")],
    });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /\[AUTH_ERROR\]/);
  });

  it("should categorize message-based safety errors (not retried)", async () => {
    const mockAPI = new MockOpenAI({
      errors: [new Error("content_policy_violation")],
    });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /\[SAFETY_ERROR\]/);
  });

  it("should categorize generic errors after retries exhausted", async () => {
    const err = new Error("Something went wrong");
    const mockAPI = new MockOpenAI({
      errors: [err, err, err, err], // 4 errors = initial + 3 retries
    });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI, { retryDelay: 1 });
    assertToolError(result, /\[API_ERROR\]/);
  });

  it("should categorize timeout errors after retries exhausted", async () => {
    const err = new Error("Request timeout after 30s");
    const mockAPI = new MockOpenAI({
      errors: [err, err, err, err],
    });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI, { retryDelay: 1 });
    assertToolError(result, /\[TIMEOUT_ERROR\]/);
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
        { prompt: "画像を生成してください 🎨 émojis et accénts", output_file: DEFAULT_OUTPUT },
        mockAPI
      );
      assert.ok(result.content.length > 0);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Mask Validation ───

describe("Mask Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should accept edit request without mask", async () => {
    try {
      const result = await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH] },
        mockAPI
      );
      assert.ok(result.content.length > 0);
      assert.strictEqual(mockAPI.lastRequest.mask, undefined);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should return tool error for non-string mask", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], mask: 123 }, mockAPI);
    assertToolError(result, /mask must be a string/);
  });

  it("should return tool error for empty mask", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], mask: "  " }, mockAPI);
    assertToolError(result, /mask cannot be empty/);
  });

  it("should pass mask to edit API when provided", async () => {
    try {
      await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], mask: TINY_PNG_PATH },
        mockAPI
      );
      assert.ok(mockAPI.lastRequest.mask);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should not include mask when omitted", async () => {
    try {
      await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH] },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastRequest.mask, undefined);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Input Fidelity Validation ───

describe("Input Fidelity Validation", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should accept 'high'", async () => {
    try {
      const result = await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], input_fidelity: "high" },
        mockAPI
      );
      assert.ok(result.content.length > 0);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should accept 'low'", async () => {
    try {
      const result = await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], input_fidelity: "low" },
        mockAPI
      );
      assert.ok(result.content.length > 0);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should return tool error for invalid input_fidelity", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], input_fidelity: "medium" }, mockAPI);
    assertToolError(result, /input_fidelity must be one of/);
  });

  it("should pass input_fidelity to API when provided", async () => {
    try {
      await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], input_fidelity: "high" },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastRequest.input_fidelity, "high");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should not include input_fidelity when omitted", async () => {
    try {
      await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH] },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastRequest.input_fidelity, undefined);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Edit Endpoint Parameters ───

describe("Edit Endpoint Parameters", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should pass background to edit call", async () => {
    try {
      await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], background: "transparent" },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastEndpoint, "edit");
      assert.strictEqual(mockAPI.lastRequest.background, "transparent");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should pass output_format to edit call", async () => {
    try {
      await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], output_mime_type: "image/webp" },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastEndpoint, "edit");
      assert.strictEqual(mockAPI.lastRequest.output_format, "webp");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should pass quality to edit call", async () => {
    try {
      await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], quality: "high" },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastEndpoint, "edit");
      assert.strictEqual(mockAPI.lastRequest.quality, "high");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should pass all parameters to edit call", async () => {
    const mock = new MockOpenAI({ editResponses: [MockOpenAI.defaultImageResponse(2)] });
    const file1 = join(fixturesDir, "test-output_1.png");
    const file2 = join(fixturesDir, "test-output_2.png");
    try {
      await handleCreateImage({
        prompt: "edit this",
        output_file: DEFAULT_OUTPUT,
        input_images: [TINY_PNG_PATH],
        size: "1536x1024",
        quality: "high",
        background: "opaque",
        output_mime_type: "image/jpeg",
        number_of_images: 2,
        input_fidelity: "low",
        mask: TINY_PNG_PATH,
      }, mock);

      const req = mock.lastRequest;
      assert.strictEqual(req.size, "1536x1024");
      assert.strictEqual(req.quality, "high");
      assert.strictEqual(req.background, "opaque");
      assert.strictEqual(req.output_format, "jpeg");
      assert.strictEqual(req.n, 2);
      assert.strictEqual(req.input_fidelity, "low");
      assert.ok(req.mask);
      assert.ok(req.image);
    } finally {
      cleanup(file1, file2);
    }
  });

  it("should default background to auto in edit call", async () => {
    try {
      await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH] },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastRequest.background, "auto");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should default output_format to png in edit call", async () => {
    try {
      await handleCreateImage(
        { prompt: "edit this", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH] },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastRequest.output_format, "png");
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
      cleanup(txtPath);
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

// ─── retryWithBackoff Tests ───

describe("retryWithBackoff", () => {
  it("should return result on first success", async () => {
    const result = await retryWithBackoff(() => Promise.resolve("ok"), 3, 1);
    assert.strictEqual(result, "ok");
  });

  it("should retry on dropped connections and succeed", async () => {
    let calls = 0;
    const connectionError = new APIConnectionError({ cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    const result = await retryWithBackoff(() => {
      calls++;
      if (calls < 3) throw connectionError;
      return Promise.resolve("recovered");
    }, 3, 1);
    assert.strictEqual(result, "recovered");
    assert.strictEqual(calls, 3);
  });

  it("should not retry on 401 errors", async () => {
    let calls = 0;
    const err = new Error("Unauthorized");
    err.status = 401;
    await assert.rejects(async () => {
      await retryWithBackoff(() => {
        calls++;
        throw err;
      }, 3, 1);
    }, /Unauthorized/);
    assert.strictEqual(calls, 1);
  });

  it("should not retry on content_policy errors", async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await retryWithBackoff(() => {
        calls++;
        throw new Error("content_policy_violation");
      }, 3, 1);
    }, /content_policy/);
    assert.strictEqual(calls, 1);
  });

  it("should retry on 429 rate limit errors", async () => {
    let calls = 0;
    const err429 = new Error("Rate limited");
    err429.status = 429;
    const result = await retryWithBackoff(() => {
      calls++;
      if (calls < 2) throw err429;
      return Promise.resolve("ok");
    }, 3, 1);
    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 2);
  });

  it("should retry on 500 server errors", async () => {
    let calls = 0;
    const err500 = new Error("Internal server error");
    err500.status = 500;
    const result = await retryWithBackoff(() => {
      calls++;
      if (calls < 2) throw err500;
      return Promise.resolve("ok");
    }, 3, 1);
    assert.strictEqual(result, "ok");
    assert.strictEqual(calls, 2);
  });

  it("should throw after max retries exhausted", async () => {
    let calls = 0;
    const err = new Error("persistent failure");
    err.status = 503;
    await assert.rejects(async () => {
      await retryWithBackoff(() => {
        calls++;
        throw err;
      }, 2, 1);
    }, /persistent failure/);
    assert.strictEqual(calls, 3);
  });

  it("should not retry programming errors, cancellation, or exhausted quota", async () => {
    const quota = new Error("You exceeded your current quota");
    quota.status = 429;
    quota.code = "insufficient_quota";
    for (const err of [new TypeError("x is not a function"), quota, new APIUserAbortError(), new APIConnectionTimeoutError()]) {
      let calls = 0;
      await assert.rejects(() => retryWithBackoff(() => { calls++; throw err; }, 3, 1));
      assert.strictEqual(calls, 1, `${err.name} should not be retried`);
    }
  });

  it("should retry 408 and 409 responses", async () => {
    for (const status of [408, 409]) {
      let calls = 0;
      const err = new Error(`status ${status}`);
      err.status = status;
      await retryWithBackoff(() => {
        calls++;
        if (calls < 2) throw err;
        return Promise.resolve("ok");
      }, 3, 1);
      assert.strictEqual(calls, 2, `${status} should be retried`);
    }
  });

  it("should wait for the Retry-After header", async () => {
    const err = new Error("Rate limited");
    err.status = 429;
    err.headers = new Headers({ "retry-after": "0.2" });
    let calls = 0;
    const start = Date.now();
    await retryWithBackoff(() => {
      calls++;
      if (calls < 2) throw err;
      return Promise.resolve("ok");
    }, 3, 1);
    assert.ok(Date.now() - start >= 190, "should honor Retry-After");
  });

  it("should honor an HTTP-date Retry-After header", async () => {
    const err = new Error("Rate limited");
    err.status = 429;
    err.headers = new Headers({ "retry-after": new Date(Date.now() + 1500).toUTCString() });
    let calls = 0;
    const start = Date.now();
    await retryWithBackoff(() => {
      calls++;
      if (calls < 2) throw err;
      return Promise.resolve("ok");
    }, 3, 1);
    // HTTP dates have 1-second resolution, so allow for rounding down
    assert.ok(Date.now() - start >= 400, "should wait until the Retry-After date");
  });

  it("should stop waiting when the signal aborts", async () => {
    const err = new Error("Server error");
    err.status = 500;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();
    await assert.rejects(() => retryWithBackoff(() => { throw err; }, 3, 5000, controller.signal));
    assert.ok(Date.now() - start < 2000);
  });
});

// ─── Style Presets ───

describe("Style Presets", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should return tool error for unknown style", async () => {
    const result = await handleCreateImage({
      prompt: "test",
      output_file: DEFAULT_OUTPUT,
      style: "nonexistent-style",
    }, mockAPI);
    assertToolError(result, /Unknown style: "nonexistent-style"/);
  });

  it("should return tool error for non-string style", async () => {
    const result = await handleCreateImage({
      prompt: "test",
      output_file: DEFAULT_OUTPUT,
      style: 123,
    }, mockAPI);
    assertToolError(result, /style must be a string/);
  });

  it("should apply style system prompt to effective prompt", async () => {
    try {
      const result = await handleCreateImage({
        prompt: "A dashboard with analytics",
        output_file: DEFAULT_OUTPUT,
        style: "ui-mockup",
      }, mockAPI);
      assert.strictEqual(result.isError, undefined);
      // Verify the prompt sent to the API includes the style system prompt
      const sentPrompt = mockAPI.lastRequest.prompt;
      assert.ok(sentPrompt.includes("flat vector illustration"), `Expected style preamble in prompt, got: ${sentPrompt.substring(0, 100)}`);
      assert.ok(sentPrompt.includes("A dashboard with analytics"), "Expected user prompt in final prompt");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should apply style defaults when user does not override", async () => {
    try {
      const result = await handleCreateImage({
        prompt: "A settings page",
        output_file: DEFAULT_OUTPUT,
        style: "ui-mockup",
      }, mockAPI);
      assert.strictEqual(result.isError, undefined);
      // ui-mockup defaults: size=1024x1536, quality=high, background=opaque
      assert.strictEqual(mockAPI.lastRequest.size, "1024x1536");
      assert.strictEqual(mockAPI.lastRequest.quality, "high");
      assert.strictEqual(mockAPI.lastRequest.background, "opaque");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should let user args override style defaults", async () => {
    try {
      const result = await handleCreateImage({
        prompt: "A settings page",
        output_file: DEFAULT_OUTPUT,
        style: "ui-mockup",
        size: "1024x1024",
        quality: "low",
      }, mockAPI);
      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(mockAPI.lastRequest.size, "1024x1024");
      assert.strictEqual(mockAPI.lastRequest.quality, "low");
      // background still comes from style default
      assert.strictEqual(mockAPI.lastRequest.background, "opaque");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should combine style prompt with system_message_file", async () => {
    const sysFile = join(fixturesDir, "test-system-msg.txt");
    writeFileSync(sysFile, "Extra brand guidelines here.");
    try {
      const result = await handleCreateImage({
        prompt: "A login form",
        output_file: DEFAULT_OUTPUT,
        style: "ui-mockup",
        system_message_file: sysFile,
      }, mockAPI);
      assert.strictEqual(result.isError, undefined);
      const sentPrompt = mockAPI.lastRequest.prompt;
      // Style prompt comes first, then system_message_file, then user prompt
      const styleIdx = sentPrompt.indexOf("flat vector illustration");
      const brandIdx = sentPrompt.indexOf("Extra brand guidelines");
      const userIdx = sentPrompt.indexOf("A login form");
      assert.ok(styleIdx >= 0, "Style prompt should be present");
      assert.ok(brandIdx >= 0, "System message file content should be present");
      assert.ok(userIdx >= 0, "User prompt should be present");
      assert.ok(styleIdx < brandIdx, "Style prompt should come before system_message_file");
      assert.ok(brandIdx < userIdx, "System message should come before user prompt");
    } finally {
      cleanup(DEFAULT_OUTPUT, sysFile);
    }
  });

  it("should work without style (null/undefined ignored)", async () => {
    try {
      const result = await handleCreateImage({
        prompt: "A simple image",
        output_file: DEFAULT_OUTPUT,
      }, mockAPI);
      assert.strictEqual(result.isError, undefined);
      // Prompt should be the raw user prompt with no style preamble
      assert.strictEqual(mockAPI.lastRequest.prompt, "A simple image");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Style Module ───

describe("Style Module", () => {
  it("getStyleNames should return an array of strings", () => {
    const names = getStyleNames();
    assert.ok(Array.isArray(names));
    assert.ok(names.length >= 1, "Should have at least 1 built-in style");
    for (const name of names) {
      assert.strictEqual(typeof name, "string");
    }
  });

  it("getStyle should return style object for valid name", () => {
    const style = getStyle("ui-mockup");
    assert.ok(style);
    assert.strictEqual(style.name, "UI Mockup");
    assert.ok(style.systemPrompt.length > 0);
    assert.ok(style.defaults);
    assert.strictEqual(style.defaults.size, "1024x1536");
  });

  it("getStyle should return null for unknown name", () => {
    assert.strictEqual(getStyle("does-not-exist"), null);
  });

  it("listStyles should return array with name, displayName, description", () => {
    const styles = listStyles();
    assert.ok(Array.isArray(styles));
    assert.ok(styles.length >= 1);
    for (const s of styles) {
      assert.ok(s.name);
      assert.ok(s.displayName);
      assert.ok(s.description);
    }
  });

  it("all styles should have required fields", () => {
    for (const name of getStyleNames()) {
      const style = getStyle(name);
      assert.ok(style.name, `${name} missing name`);
      assert.ok(style.description, `${name} missing description`);
      assert.ok(style.systemPrompt, `${name} missing systemPrompt`);
      assert.ok(typeof style.systemPrompt === "string", `${name} systemPrompt must be string`);
    }
  });

  it("should include ui-mockup as a built-in style", () => {
    const names = getStyleNames();
    assert.ok(names.includes("ui-mockup"));
  });
});

// ─── Output Path & Format Resolution ───

describe("Output Path & Format Resolution", () => {
  const out = (name) => join(fixturesDir, name);

  it("should infer JPEG from a .jpg output_file", async () => {
    const mockAPI = new MockOpenAI();
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: out("infer.jpg") }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.output_format, "jpeg");
      assert.ok(result.content[0].text.includes(`${out("infer.jpg")} (`));
      assert.ok(result.content[0].text.includes("image/jpeg"));
      assert.ok(existsSync(out("infer.jpg")));
    } finally {
      cleanup(out("infer.jpg"));
    }
  });

  it("should infer WebP from a .webp output_file over a style default", async () => {
    const mockAPI = new MockOpenAI();
    try {
      await handleCreateImage({ prompt: "test", output_file: out("infer-style.webp"), style: "ui-mockup" }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.output_format, "webp");
      assert.ok(existsSync(out("infer-style.webp")));
    } finally {
      cleanup(out("infer-style.webp"));
    }
  });

  it("should correct a mismatched extension when output_mime_type is explicit", async () => {
    const mockAPI = new MockOpenAI();
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: out("mismatch.png"), output_mime_type: "image/jpeg" },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastRequest.output_format, "jpeg");
      assert.ok(result.content[0].text.includes(out("mismatch.jpg")));
      assert.ok(existsSync(out("mismatch.jpg")));
      assert.ok(!existsSync(out("mismatch.png")));
    } finally {
      cleanup(out("mismatch.png"));
    }
  });

  it("should keep a .jpeg extension for JPEG output", async () => {
    const mockAPI = new MockOpenAI();
    try {
      await handleCreateImage({ prompt: "test", output_file: out("keep.jpeg") }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.output_format, "jpeg");
      assert.ok(existsSync(out("keep.jpeg")));
    } finally {
      cleanup(out("keep.jpeg"));
    }
  });

  it("should append an extension when output_file has none", async () => {
    const mockAPI = new MockOpenAI();
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: out("no-ext") }, mockAPI);
      assert.ok(result.content[0].text.includes(out("no-ext.png")));
      assert.ok(existsSync(out("no-ext.png")));
    } finally {
      cleanup(out("no-ext.png"));
    }
  });

  it("should number multiple images using the corrected extension", async () => {
    const mockAPI = new MockOpenAI({
      generateResponses: [{ data: [{ b64_json: TINY_PNG_BUFFER.toString("base64") }, { b64_json: TINY_PNG_BUFFER.toString("base64") }] }],
    });
    try {
      await handleCreateImage(
        { prompt: "test", output_file: out("multi.png"), output_mime_type: "image/webp", number_of_images: 2 },
        mockAPI
      );
      assert.ok(existsSync(out("multi_1.webp")));
      assert.ok(existsSync(out("multi_2.webp")));
    } finally {
      cleanup(out("multi_1.webp"), out("multi_2.webp"));
    }
  });

  it("should report an absolute path for a relative output_file", async () => {
    const mockAPI = new MockOpenAI();
    const relative = "test/fixtures/relative-out.png";
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: relative }, mockAPI);
      assert.ok(result.content[0].text.includes(join(process.cwd(), relative)));
    } finally {
      cleanup(join(process.cwd(), relative));
    }
  });

  it("should expand ~ in system_message_file", { skip: !fixturesDir.startsWith(homedir()) }, async () => {
    const mockAPI = new MockOpenAI();
    const tildePath = "~" + join(fixturesDir, "system-prompt.txt").slice(homedir().length);
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: DEFAULT_OUTPUT, system_message_file: tildePath },
        mockAPI
      );
      assert.strictEqual(result.isError, undefined);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Argument Robustness ───

describe("Argument Robustness", () => {
  it("should accept number_of_images as a numeric string", async () => {
    const mockAPI = new MockOpenAI();
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: "2" }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.n, 2);
    } finally {
      cleanup(DEFAULT_OUTPUT, join(fixturesDir, "test-output_1.png"), join(fixturesDir, "test-output_2.png"));
    }
  });

  it("should reject a non-numeric number_of_images string", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: "two" }, new MockOpenAI());
    assertToolError(result, /number_of_images must be an integer between 1 and 4/);
  });

  it("should reject mask without input_images", async () => {
    const mockAPI = new MockOpenAI();
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, mask: TINY_PNG_PATH }, mockAPI);
    assertToolError(result, /mask requires input_images/);
    assert.strictEqual(mockAPI.callCount, 0);
  });

  it("should fail fast without retrying when the mask file is missing", async () => {
    const mockAPI = new MockOpenAI();
    const start = Date.now();
    const result = await handleCreateImage(
      { prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], mask: join(fixturesDir, "missing-mask.png") },
      mockAPI,
      { retryDelay: 5000 }
    );
    assertToolError(result, /\[FILE_ERROR\]/);
    assert.strictEqual(mockAPI.callCount, 0);
    assert.ok(Date.now() - start < 2000, "should not have waited on retries");
  });

  it("should reject an output_file that is a directory", async () => {
    const mockAPI = new MockOpenAI();
    for (const outputFile of [fixturesDir, `${fixturesDir}/`]) {
      const result = await handleCreateImage({ prompt: "test", output_file: outputFile }, mockAPI);
      assertToolError(result, /must be a file path, not a directory/);
    }
    assert.strictEqual(mockAPI.callCount, 0);
  });

  it("should return a tool error when system_message_file is a directory", async () => {
    const result = await handleCreateImage(
      { prompt: "test", output_file: DEFAULT_OUTPUT, system_message_file: fixturesDir },
      new MockOpenAI()
    );
    assertToolError(result, /System message file not found/);
  });

  it("should not retry a statusless moderation_blocked error", async () => {
    const err = new Error("Rejected");
    err.code = "moderation_blocked";
    const mockAPI = new MockOpenAI({ errors: [err, err, err, err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI, { retryDelay: 1 });
    assertToolError(result, /\[SAFETY_ERROR\]/);
    assert.strictEqual(mockAPI.callCount, 1);
  });

  it("should categorize moderation_blocked code as a safety error", async () => {
    const err = new Error("Your request was rejected as a result of our safety system.");
    err.status = 400;
    err.code = "moderation_blocked";
    const mockAPI = new MockOpenAI({ errors: [err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
    assertToolError(result, /\[SAFETY_ERROR\]/);
    assert.strictEqual(mockAPI.callCount, 1);
  });
});

// ─── GPT Image 2.5 Parameters ───

describe("GPT Image 2.5 Parameters", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should default to gpt-image-2.5-sunburst", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.model, IMAGE_MODEL);
      if (!process.env.OPENAI_IMAGE_MODEL) {
        assert.strictEqual(IMAGE_MODEL, "gpt-image-2.5-sunburst");
      }
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should use gpt-image-2.5-flare when requested", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, model: "gpt-image-2.5-flare" }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.model, "gpt-image-2.5-flare");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should reject an unknown model", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, model: "dall-e-3" }, mockAPI);
    assertToolError(result, /model must be one of/);
    assert.strictEqual(mockAPI.callCount, 0);
  });

  it("should pass output_compression for JPEG output", async () => {
    const outputPath = join(fixturesDir, "compress.jpg");
    try {
      await handleCreateImage({ prompt: "test", output_file: outputPath, output_compression: "60" }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.output_compression, 60);
    } finally {
      cleanup(outputPath);
    }
  });

  it("should reject output_compression for PNG output", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, output_compression: 60 }, mockAPI);
    assertToolError(result, /only applies to JPEG or WebP/);
  });

  it("should reject out-of-range output_compression", async () => {
    const result = await handleCreateImage(
      { prompt: "test", output_file: join(fixturesDir, "x.webp"), output_compression: 101 },
      mockAPI
    );
    assertToolError(result, /between 0 and 100/);
  });

  it("should pass moderation and omit it when unset", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.moderation, undefined);
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, moderation: "low" }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.moderation, "low");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should reject an invalid moderation value", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, moderation: "off" }, mockAPI);
    assertToolError(result, /moderation must be one of/);
  });

  it("should send moderation and compression to the edit endpoint too", async () => {
    const outputPath = join(fixturesDir, "edit-params.webp");
    try {
      await handleCreateImage(
        { prompt: "edit", output_file: outputPath, input_images: [TINY_PNG_PATH], moderation: "low", output_compression: 70 },
        mockAPI
      );
      assert.strictEqual(mockAPI.lastEndpoint, "edit");
      assert.strictEqual(mockAPI.lastRequest.moderation, "low");
      assert.strictEqual(mockAPI.lastRequest.output_compression, 70);
    } finally {
      cleanup(outputPath);
    }
  });

  it("should reject more than the maximum number of input images", async () => {
    const images = Array(MAX_INPUT_IMAGES + 1).fill(TINY_PNG_PATH);
    const result = await handleCreateImage({ prompt: "edit", output_file: DEFAULT_OUTPUT, input_images: images }, mockAPI);
    assertToolError(result, /at most 16 images/);
  });

  it("should reject GIF input images before calling the API", async () => {
    const gifPath = join(fixturesDir, "unsupported-input.gif");
    writeFileSync(gifPath, Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"));
    try {
      const result = await handleCreateImage({ prompt: "edit", output_file: DEFAULT_OUTPUT, input_images: [gifPath] }, mockAPI);
      assertToolError(result, /Unsupported image type/);
      assert.strictEqual(mockAPI.callCount, 0);
    } finally {
      if (existsSync(gifPath)) unlinkSync(gifPath);
    }
  });

  it("should reject a non-PNG mask", async () => {
    const result = await handleCreateImage(
      { prompt: "edit", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH], mask: TINY_JPEG_PATH },
      mockAPI
    );
    assertToolError(result, /mask must be a PNG/);
  });
});

// ─── Response Details ───

describe("Response Details", () => {
  it("should report the model, size, quality, and tokens the API actually used", async () => {
    const mockAPI = new MockOpenAI({
      generateResponses: [{
        data: [{ b64_json: TINY_PNG_BUFFER.toString("base64") }],
        size: "1312x1199",
        quality: "medium",
        usage: { output_tokens: 215 },
      }],
    });
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, size: "auto" }, mockAPI);
      const text = result.content[0].text;
      assert.ok(text.includes(`model ${IMAGE_MODEL}`));
      assert.ok(text.includes("size 1312x1199"));
      assert.ok(text.includes("quality medium"));
      assert.ok(text.includes("215 output tokens"));
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should fall back to the requested settings when the API omits them", async () => {
    const mockAPI = new MockOpenAI();
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, quality: "low" }, mockAPI);
      assert.ok(result.content[0].text.includes("size 1024x1024, quality low"));
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Hardening ───

describe("Hardening", () => {
  let mockAPI;

  beforeEach(() => {
    mockAPI = new MockOpenAI();
  });

  it("should reject unknown parameters", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, aspect: "16:9" }, mockAPI);
    assertToolError(result, /Unknown parameter: aspect/);
    assert.strictEqual(mockAPI.callCount, 0);
  });

  it("should reject a non-string quality instead of defaulting it", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, quality: false }, mockAPI);
    assertToolError(result, /quality must be one of/);
  });

  it("should reject input_fidelity without input_images", async () => {
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_fidelity: "high" }, mockAPI);
    assertToolError(result, /input_fidelity requires input_images/);
  });

  it("should reject a prompt that exceeds the limit once the style preamble is added", async () => {
    const result = await handleCreateImage(
      { prompt: "a".repeat(31990), output_file: DEFAULT_OUTPUT, style: "ui-mockup" },
      mockAPI
    );
    assertToolError(result, /Prompt plus style\/system message/);
    assert.strictEqual(mockAPI.callCount, 0);
  });

  it("should reject a text file renamed to .png as an input image", async () => {
    const fakePath = join(fixturesDir, "not-really.png");
    writeFileSync(fakePath, "just some text");
    try {
      const result = await handleCreateImage({ prompt: "edit", output_file: DEFAULT_OUTPUT, input_images: [fakePath] }, mockAPI);
      assertToolError(result, /\[FILE_ERROR\].*Unsupported image type/);
      assert.strictEqual(mockAPI.callCount, 0);
    } finally {
      unlinkSync(fakePath);
    }
  });

  it("should send the detected type for input images", async () => {
    try {
      await handleCreateImage({ prompt: "edit", output_file: DEFAULT_OUTPUT, input_images: [TINY_JPEG_PATH] }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.image.type, "image/jpeg");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should report undecodable image data as an error without writing a file", async () => {
    const api = new MockOpenAI({ generateResponses: [{ data: [{ b64_json: "%%%" }] }] });
    const outputPath = join(fixturesDir, "garbage.png");
    const result = await handleCreateImage({ prompt: "test", output_file: outputPath }, api);
    assertToolError(result, /could not be decoded/);
    assert.ok(!existsSync(outputPath));
  });

  it("should mark an empty API response as an error", async () => {
    const api = new MockOpenAI({ generateResponses: [MockOpenAI.emptyResponse()] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, api);
    assertToolError(result, /\[NO_IMAGE\]/);
  });

  it("should number files and note a shortfall when fewer images come back", async () => {
    const api = new MockOpenAI({ generateResponses: [MockOpenAI.defaultImageResponse(1)] });
    const outputPath = join(fixturesDir, "shortfall.png");
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: outputPath, number_of_images: 3 }, api);
      assert.ok(existsSync(join(fixturesDir, "shortfall_1.png")));
      assert.ok(result.content[0].text.includes("requested 3 images but the API returned 1"));
    } finally {
      cleanup(join(fixturesDir, "shortfall_1.png"));
    }
  });

  it("should report files already saved when a later write fails", async () => {
    const api = new MockOpenAI({ generateResponses: [MockOpenAI.defaultImageResponse(2)] });
    const outputPath = join(fixturesDir, "partial.png");
    const blocker = join(fixturesDir, "partial_2.png");
    mkdirSync(blocker, { recursive: true });
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: outputPath, number_of_images: 2 }, api);
      assertToolError(result, /\[FILE_ERROR\] Could not write .*partial_2\.png.*Already saved: .*partial_1\.png/);
    } finally {
      cleanup(join(fixturesDir, "partial_1.png"));
      rmSync(blocker, { recursive: true, force: true });
    }
  });

  it("should classify SDK connection timeouts as timeout errors without retrying", async () => {
    const err = new APIConnectionTimeoutError();
    const api = new MockOpenAI({ errors: [err, err, err, err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, api, { retryDelay: 1 });
    assertToolError(result, /\[TIMEOUT_ERROR\]/);
    assert.strictEqual(api.callCount, 1);
  });

  it("should report exhausted quota clearly without retrying", async () => {
    const err = new Error("You exceeded your current quota");
    err.status = 429;
    err.code = "insufficient_quota";
    const api = new MockOpenAI({ errors: [err, err, err, err] });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, api, { retryDelay: 1 });
    assertToolError(result, /\[QUOTA_ERROR\] OpenAI account is out of credits/);
    assert.strictEqual(api.callCount, 1);
  });

  it("should pass the abort signal to the API and write nothing once cancelled", async () => {
    const controller = new AbortController();
    const outputPath = join(fixturesDir, "cancelled.png");
    const api = {
      images: {
        generate: async (_params, requestOptions) => {
          assert.strictEqual(requestOptions.signal, controller.signal);
          controller.abort();
          return MockOpenAI.defaultImageResponse();
        },
      },
    };
    const result = await handleCreateImage({ prompt: "test", output_file: outputPath }, api, { signal: controller.signal });
    assertToolError(result, /\[CANCELLED\]/);
    assert.ok(!existsSync(outputPath));
  });

  it("should not resolve inherited object properties as styles", async () => {
    assert.strictEqual(getStyle("constructor"), null);
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, style: "constructor" }, mockAPI);
    assertToolError(result, /Unknown style/);
  });
});

// ─── Style Compression Defaults ───

describe("Style Compression Defaults", () => {
  const stylesDir = join(process.cwd(), "create-image-styles");
  const styleName = `test-compressed-${process.pid}`;
  const stylePath = join(stylesDir, `${styleName}.json`);
  const createdDir = !existsSync(stylesDir);

  beforeEach(() => {
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(stylePath, JSON.stringify({
      name: "Test Compressed",
      description: "Test style with JPEG compression defaults",
      systemPrompt: "Test style.",
      defaults: { output_mime_type: "image/jpeg", output_compression: 70 },
    }));
  });

  // Remove only what this suite created; leave the directory if anything else is in it
  const removeStyle = () => {
    if (existsSync(stylePath)) unlinkSync(stylePath);
    if (createdDir && existsSync(stylesDir) && readdirSync(stylesDir).length === 0) rmdirSync(stylesDir);
  };

  it("should apply the style's compression to JPEG output", async () => {
    const mockAPI = new MockOpenAI();
    const outputPath = join(fixturesDir, "style-compressed");
    try {
      await handleCreateImage({ prompt: "test", output_file: outputPath, style: styleName }, mockAPI);
      assert.strictEqual(mockAPI.lastRequest.output_format, "jpeg");
      assert.strictEqual(mockAPI.lastRequest.output_compression, 70);
    } finally {
      cleanup(`${outputPath}.jpg`);
      removeStyle();
    }
  });

  it("should drop the style's compression when the caller asks for PNG", async () => {
    const mockAPI = new MockOpenAI();
    const outputPath = join(fixturesDir, "style-png.png");
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: outputPath, style: styleName }, mockAPI);
      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(mockAPI.lastRequest.output_format, "png");
      assert.strictEqual(mockAPI.lastRequest.output_compression, undefined);
    } finally {
      cleanup(outputPath);
      removeStyle();
    }
  });
});
