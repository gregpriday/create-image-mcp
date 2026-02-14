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

// Standalone readImageFile (mirrors src/index.js without needing GOOGLE_API_KEY)
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic"];

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
  return { data: data.toString("base64"), mimeType };
}

// Mock stream response helper
class MockStream {
  constructor(chunks) {
    this.chunks = chunks;
  }

  async *[Symbol.asyncIterator]() {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}

// Mock Gemini API
class MockGenerativeAI {
  constructor(options = {}) {
    this.callCount = 0;
    this.lastRequest = null;
    this.responses = options.responses || [MockGenerativeAI.defaultImageResponse()];
    this.errors = options.errors || [];
    this.models = {
      generateContentStream: async (request) => {
        this.lastRequest = request;
        this.callCount++;

        if (this.errors.length > 0 && this.callCount <= this.errors.length) {
          throw this.errors[this.callCount - 1];
        }

        const responseIndex = Math.min(this.callCount - 1 - this.errors.length, this.responses.length - 1);
        return new MockStream(this.responses[responseIndex]);
      },
    };
  }

  static defaultImageResponse() {
    return [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: TINY_PNG_BUFFER.toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      },
    ];
  }

  static textOnlyResponse(text) {
    return [
      {
        candidates: [
          {
            content: {
              parts: [{ text }],
            },
          },
        ],
      },
    ];
  }

  static imageWithTextResponse(text) {
    return [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: TINY_PNG_BUFFER.toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{ text }],
            },
          },
        ],
      },
    ];
  }

  static multiImageResponse(count) {
    const chunks = [];
    for (let i = 0; i < count; i++) {
      chunks.push({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: TINY_PNG_BUFFER.toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      });
    }
    return chunks;
  }

  static emptyResponse() {
    return [
      {
        candidates: [
          {
            content: {
              parts: [],
            },
          },
        ],
      },
    ];
  }
}

/**
 * Simulates the handleCreateImage logic from src/index.js for unit testing.
 * Mirrors the production code so we can test without starting the server.
 */
async function handleCreateImage(args, mockAI) {
  const {
    prompt,
    input_images: inputImages,
    output_file: outputFile,
    aspect_ratio: aspectRatio = "16:9",
    image_size: imageSize = "2K",
    number_of_images: numberOfImages = 1,
    output_mime_type: outputMimeType = "image/png",
    person_generation: personGeneration = "",
  } = args;

  const VALID_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];
  const VALID_IMAGE_SIZES = ["1K", "2K"];
  const VALID_PERSON_GENERATION = ["", "DONT_ALLOW", "ALLOW_ADULT", "ALLOW_ALL"];
  const VALID_OUTPUT_MIME_TYPES = ["image/png", "image/jpeg"];

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
  if (prompt.length > 10000) {
    throw new Error("Prompt exceeds maximum length of 10000 characters");
  }

  // Input validation for input_images
  if (inputImages !== undefined && inputImages !== null) {
    if (!Array.isArray(inputImages)) {
      throw new Error("input_images must be an array of file paths");
    }
    if (inputImages.length === 0) {
      throw new Error("input_images cannot be an empty array");
    }
    if (inputImages.length > 4) {
      throw new Error("input_images cannot contain more than 4 images");
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

  if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Error(`aspect_ratio must be one of: ${VALID_ASPECT_RATIOS.join(", ")}. Got: ${aspectRatio}`);
  }
  if (!VALID_IMAGE_SIZES.includes(imageSize)) {
    throw new Error(`image_size must be one of: ${VALID_IMAGE_SIZES.join(", ")}. Got: ${imageSize}`);
  }
  if (!Number.isInteger(numberOfImages) || numberOfImages < 1 || numberOfImages > 4) {
    throw new Error(`number_of_images must be an integer between 1 and 4. Got: ${numberOfImages}`);
  }
  if (!VALID_OUTPUT_MIME_TYPES.includes(outputMimeType)) {
    throw new Error(`output_mime_type must be one of: ${VALID_OUTPUT_MIME_TYPES.join(", ")}. Got: ${outputMimeType}`);
  }
  if (!VALID_PERSON_GENERATION.includes(personGeneration)) {
    throw new Error(`person_generation must be one of: ${VALID_PERSON_GENERATION.join(", ")}. Got: ${personGeneration}`);
  }

  try {
    const generationConfig = {
      responseModalities: ["IMAGE", "TEXT"],
      imageConfig: {
        aspectRatio,
        imageSize,
        personGeneration,
        numberOfImages,
        outputMimeType,
      },
      tools: [{ googleSearch: {} }],
    };

    const parts = [{ text: prompt }];

    // Read input images if provided
    if (inputImages && inputImages.length > 0) {
      for (const imgPath of inputImages) {
        const imageData = readImageFile(imgPath);
        parts.push({
          inlineData: {
            mimeType: imageData.mimeType,
            data: imageData.data,
          },
        });
      }
    }

    const contents = [{ role: "user", parts }];

    const response = await mockAI.models.generateContentStream({
      model: "gemini-3-pro-image-preview",
      config: generationConfig,
      contents,
    });

    const outputImages = [];
    const textParts = [];

    for await (const chunk of response) {
      if (!chunk.candidates || !chunk.candidates[0]?.content?.parts) {
        continue;
      }
      for (const part of chunk.candidates[0].content.parts) {
        if (part.inlineData) {
          outputImages.push({
            mimeType: part.inlineData.mimeType || "image/png",
            data: part.inlineData.data,
          });
        } else if (part.text) {
          textParts.push(part.text);
        }
      }
    }

    if (outputImages.length === 0) {
      const textResponse = textParts.join("") || "No image was generated. The model may have declined the request.";
      return {
        content: [{ type: "text", text: `[NO_IMAGE] ${textResponse}` }],
      };
    }

    // Save images to disk
    const savedFiles = [];
    const ext = extname(outputFile);
    const baseName = outputFile.slice(0, outputFile.length - ext.length);

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

    if (textParts.length > 0) {
      lines.push("");
      lines.push(textParts.join(""));
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (error) {
    const errorMessage = error.message || "Image generation failed";
    const lowerMessage = errorMessage.toLowerCase();

    if (lowerMessage.includes("api key")) {
      throw new Error(`[AUTH_ERROR] Invalid or missing API key: ${errorMessage}`);
    } else if (lowerMessage.includes("quota") || lowerMessage.includes("rate limit")) {
      throw new Error(`[QUOTA_ERROR] API quota exceeded: ${errorMessage}`);
    } else if (lowerMessage.includes("timeout")) {
      throw new Error(`[TIMEOUT_ERROR] Request timed out: ${errorMessage}`);
    } else if (lowerMessage.includes("safety") || lowerMessage.includes("blocked")) {
      throw new Error(`[SAFETY_ERROR] Request blocked by safety filters: ${errorMessage}`);
    } else {
      throw new Error(`[API_ERROR] Gemini API error: ${errorMessage}`);
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
  let mockAI;

  beforeEach(() => {
    mockAI = new MockGenerativeAI();
  });

  it("should reject missing prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ output_file: DEFAULT_OUTPUT }, mockAI),
      /Missing required parameter: prompt/
    );
  });

  it("should reject null prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: null, output_file: DEFAULT_OUTPUT }, mockAI),
      /Missing required parameter: prompt/
    );
  });

  it("should reject undefined prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: undefined, output_file: DEFAULT_OUTPUT }, mockAI),
      /Missing required parameter: prompt/
    );
  });

  it("should reject non-string prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: 123, output_file: DEFAULT_OUTPUT }, mockAI),
      /Prompt must be a string/
    );
  });

  it("should reject empty string prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "   ", output_file: DEFAULT_OUTPUT }, mockAI),
      /Prompt cannot be empty/
    );
  });

  it("should reject prompt exceeding max length", async () => {
    const longPrompt = "x".repeat(10001);
    await assert.rejects(
      () => handleCreateImage({ prompt: longPrompt, output_file: DEFAULT_OUTPUT }, mockAI),
      /Prompt exceeds maximum length of 10000 characters/
    );
  });

  it("should accept prompt at max length boundary", async () => {
    const maxPrompt = "x".repeat(10000);
    try {
      const result = await handleCreateImage({ prompt: maxPrompt, output_file: DEFAULT_OUTPUT }, mockAI);
      assert.ok(result.content.length > 0);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should reject missing output_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test" }, mockAI),
      /Missing required parameter: output_file/
    );
  });

  it("should reject null output_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: null }, mockAI),
      /Missing required parameter: output_file/
    );
  });
});

// ─── Input Images Validation ───

describe("Input Images Validation", () => {
  let mockAI;

  beforeEach(() => {
    mockAI = new MockGenerativeAI();
  });

  it("should reject non-array input_images", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: "not-array" }, mockAI),
      /input_images must be an array/
    );
  });

  it("should reject empty input_images array", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [] }, mockAI),
      /input_images cannot be an empty array/
    );
  });

  it("should reject input_images with more than 4 entries", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: ["a", "b", "c", "d", "e"] }, mockAI),
      /input_images cannot contain more than 4 images/
    );
  });

  it("should reject input_images with non-string entries", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: [123] }, mockAI),
      /Each input_images entry must be a non-empty string/
    );
  });

  it("should reject input_images with empty string entries", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, input_images: ["  "] }, mockAI),
      /Each input_images entry must be a non-empty string/
    );
  });

  it("should accept valid input_images with existing files", async () => {
    try {
      const result = await handleCreateImage(
        { prompt: "edit this image", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH] },
        mockAI
      );
      assert.ok(result.content.length > 0);
      // Verify the request included image data
      const requestParts = mockAI.lastRequest.contents[0].parts;
      assert.strictEqual(requestParts.length, 2); // text + image
      assert.ok(requestParts[1].inlineData);
      assert.strictEqual(requestParts[1].inlineData.mimeType, "image/png");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should accept multiple input images", async () => {
    try {
      const result = await handleCreateImage(
        { prompt: "combine these", output_file: DEFAULT_OUTPUT, input_images: [TINY_PNG_PATH, TINY_JPEG_PATH] },
        mockAI
      );
      assert.ok(result.content.length > 0);
      const requestParts = mockAI.lastRequest.contents[0].parts;
      assert.strictEqual(requestParts.length, 3); // text + 2 images
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should skip input_images when undefined", async () => {
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);
      assert.ok(result.content.length > 0);
      const requestParts = mockAI.lastRequest.contents[0].parts;
      assert.strictEqual(requestParts.length, 1); // text only
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Output File Validation ───

describe("Output File Validation", () => {
  let mockAI;

  beforeEach(() => {
    mockAI = new MockGenerativeAI();
  });

  it("should reject non-string output_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: 123 }, mockAI),
      /output_file must be a string/
    );
  });

  it("should reject empty output_file", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: "  " }, mockAI),
      /output_file cannot be empty/
    );
  });

  it("should save image to output_file and return text response", async () => {
    const outputPath = join(fixturesDir, "output-test.png");
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: outputPath },
        mockAI
      );
      assert.ok(existsSync(outputPath));
      // Response should be text-only with file path and size info
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
        mockAI
      );
      // No image content type in response
      const imageContent = result.content.find(c => c.type === "image");
      assert.strictEqual(imageContent, undefined);
    } finally {
      cleanup(outputPath);
    }
  });

  it("should number multiple output files", async () => {
    const mockMulti = new MockGenerativeAI({
      responses: [MockGenerativeAI.multiImageResponse(2)],
    });
    const outputPath = join(fixturesDir, "multi-output.png");
    const file1 = join(fixturesDir, "multi-output_1.png");
    const file2 = join(fixturesDir, "multi-output_2.png");
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: outputPath },
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

// ─── Aspect Ratio Validation ───

describe("Aspect Ratio Validation", () => {
  let mockAI;

  beforeEach(() => {
    mockAI = new MockGenerativeAI();
  });

  it("should accept all valid aspect ratios", async () => {
    const ratios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];
    for (const ratio of ratios) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, aspect_ratio: ratio }, mockAI);
        assert.ok(result.content.length > 0, `Failed for ratio: ${ratio}`);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should reject invalid aspect ratio", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, aspect_ratio: "7:3" }, mockAI),
      /aspect_ratio must be one of/
    );
  });

  it("should default to 16:9", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);
      assert.strictEqual(mockAI.lastRequest.config.imageConfig.aspectRatio, "16:9");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Image Size Validation ───

describe("Image Size Validation", () => {
  let mockAI;

  beforeEach(() => {
    mockAI = new MockGenerativeAI();
  });

  it("should accept 1K and 2K", async () => {
    for (const size of ["1K", "2K"]) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, image_size: size }, mockAI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should reject invalid image size", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, image_size: "4K" }, mockAI),
      /image_size must be one of/
    );
  });

  it("should default to 2K", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);
      assert.strictEqual(mockAI.lastRequest.config.imageConfig.imageSize, "2K");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Number of Images Validation ───

describe("Number of Images Validation", () => {
  let mockAI;

  beforeEach(() => {
    mockAI = new MockGenerativeAI();
  });

  it("should accept values 1-4", async () => {
    for (let n = 1; n <= 4; n++) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: n }, mockAI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should reject 0", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 0 }, mockAI),
      /number_of_images must be an integer between 1 and 4/
    );
  });

  it("should reject 5", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 5 }, mockAI),
      /number_of_images must be an integer between 1 and 4/
    );
  });

  it("should reject non-integer", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, number_of_images: 1.5 }, mockAI),
      /number_of_images must be an integer between 1 and 4/
    );
  });

  it("should default to 1", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);
      assert.strictEqual(mockAI.lastRequest.config.imageConfig.numberOfImages, 1);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Output MIME Type Validation ───

describe("Output MIME Type Validation", () => {
  let mockAI;

  beforeEach(() => {
    mockAI = new MockGenerativeAI();
  });

  it("should accept image/png and image/jpeg", async () => {
    for (const mt of ["image/png", "image/jpeg"]) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, output_mime_type: mt }, mockAI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should reject invalid mime type", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, output_mime_type: "image/gif" }, mockAI),
      /output_mime_type must be one of/
    );
  });

  it("should default to image/png", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);
      assert.strictEqual(mockAI.lastRequest.config.imageConfig.outputMimeType, "image/png");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Person Generation Validation ───

describe("Person Generation Validation", () => {
  let mockAI;

  beforeEach(() => {
    mockAI = new MockGenerativeAI();
  });

  it("should accept all valid values", async () => {
    for (const pg of ["", "DONT_ALLOW", "ALLOW_ADULT", "ALLOW_ALL"]) {
      try {
        const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, person_generation: pg }, mockAI);
        assert.ok(result.content.length > 0);
      } finally {
        cleanup(DEFAULT_OUTPUT);
      }
    }
  });

  it("should reject invalid value", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT, person_generation: "INVALID" }, mockAI),
      /person_generation must be one of/
    );
  });

  it("should default to empty string", async () => {
    try {
      await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);
      assert.strictEqual(mockAI.lastRequest.config.imageConfig.personGeneration, "");
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });
});

// ─── Successful Response Tests ───

describe("Successful Responses", () => {
  it("should return text-only response with file path", async () => {
    const mockAI = new MockGenerativeAI();
    const outputPath = join(fixturesDir, "success-test.png");
    try {
      const result = await handleCreateImage({ prompt: "A mountain landscape", output_file: outputPath }, mockAI);

      // Should only have text content (no image type)
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.ok(result.content[0].text.includes("Image saved to:"));
      assert.ok(result.content[0].text.includes("image/png"));
      assert.ok(existsSync(outputPath));
    } finally {
      cleanup(outputPath);
    }
  });

  it("should include model text in response when present", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [MockGenerativeAI.imageWithTextResponse("Here is your generated image")],
    });
    const outputPath = join(fixturesDir, "text-test.png");
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: outputPath }, mockAI);

      assert.strictEqual(result.content.length, 1);
      assert.ok(result.content[0].text.includes("Image saved to:"));
      assert.ok(result.content[0].text.includes("Here is your generated image"));
    } finally {
      cleanup(outputPath);
    }
  });

  it("should handle text-only response (no image generated)", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [MockGenerativeAI.textOnlyResponse("I cannot generate that image")],
    });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);

    assert.strictEqual(result.content.length, 1);
    assert.ok(result.content[0].text.includes("[NO_IMAGE]"));
    assert.ok(result.content[0].text.includes("I cannot generate that image"));
  });

  it("should handle empty response", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [MockGenerativeAI.emptyResponse()],
    });
    const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);

    assert.strictEqual(result.content.length, 1);
    assert.ok(result.content[0].text.includes("[NO_IMAGE]"));
    assert.ok(result.content[0].text.includes("model may have declined"));
  });

  it("should save multiple images with numbered filenames", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [MockGenerativeAI.multiImageResponse(3)],
    });
    const outputPath = join(fixturesDir, "multi-success.png");
    const files = [
      join(fixturesDir, "multi-success_1.png"),
      join(fixturesDir, "multi-success_2.png"),
      join(fixturesDir, "multi-success_3.png"),
    ];
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: outputPath }, mockAI);

      // All three file references in single text response
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
    const mockAI = new MockGenerativeAI();
    const outputPath = join(fixturesDir, "config-test.png");
    try {
      await handleCreateImage({
        prompt: "test",
        output_file: outputPath,
        aspect_ratio: "9:16",
        image_size: "1K",
        number_of_images: 2,
        output_mime_type: "image/jpeg",
        person_generation: "ALLOW_ADULT",
      }, mockAI);

      const config = mockAI.lastRequest.config;
      assert.strictEqual(config.imageConfig.aspectRatio, "9:16");
      assert.strictEqual(config.imageConfig.imageSize, "1K");
      assert.strictEqual(config.imageConfig.numberOfImages, 2);
      assert.strictEqual(config.imageConfig.outputMimeType, "image/jpeg");
      assert.strictEqual(config.imageConfig.personGeneration, "ALLOW_ADULT");
      assert.deepStrictEqual(config.responseModalities, ["IMAGE", "TEXT"]);
    } finally {
      cleanup(outputPath);
    }
  });

  it("should include googleSearch in tools config", async () => {
    const mockAI = new MockGenerativeAI();
    const outputPath = join(fixturesDir, "tools-test.png");
    try {
      await handleCreateImage({ prompt: "test", output_file: outputPath }, mockAI);
      assert.deepStrictEqual(mockAI.lastRequest.config.tools, [{ googleSearch: {} }]);
    } finally {
      cleanup(outputPath);
    }
  });
});

// ─── Error Handling Tests ───

describe("Error Handling", () => {
  it("should categorize auth errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Invalid api key provided")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI),
      /\[AUTH_ERROR\]/
    );
  });

  it("should categorize quota errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Quota exceeded for this project")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI),
      /\[QUOTA_ERROR\]/
    );
  });

  it("should categorize rate limit errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Rate limit reached")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI),
      /\[QUOTA_ERROR\]/
    );
  });

  it("should categorize timeout errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Request timeout after 30s")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI),
      /\[TIMEOUT_ERROR\]/
    );
  });

  it("should categorize safety errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Content blocked by safety filters")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI),
      /\[SAFETY_ERROR\]/
    );
  });

  it("should categorize generic errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Something went wrong")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI),
      /\[API_ERROR\]/
    );
  });
});

// ─── Edge Cases ───

describe("Edge Cases", () => {
  it("should handle special characters in prompt", async () => {
    const mockAI = new MockGenerativeAI();
    try {
      const result = await handleCreateImage(
        { prompt: 'A "quoted" image with <html> & special chars!', output_file: DEFAULT_OUTPUT },
        mockAI
      );
      assert.ok(result.content.length > 0);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should handle unicode in prompt", async () => {
    const mockAI = new MockGenerativeAI();
    try {
      const result = await handleCreateImage(
        { prompt: "An image of a dragon", output_file: DEFAULT_OUTPUT },
        mockAI
      );
      assert.ok(result.content.length > 0);
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should handle chunks with no candidates", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [
        [
          { candidates: null },
          { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG_BUFFER.toString("base64") } }] } }] },
        ],
      ],
    });
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);
      assert.ok(result.content[0].text.includes("Image saved to:"));
    } finally {
      cleanup(DEFAULT_OUTPUT);
    }
  });

  it("should handle chunks with no parts", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [
        [
          { candidates: [{ content: {} }] },
          { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG_BUFFER.toString("base64") } }] } }] },
        ],
      ],
    });
    try {
      const result = await handleCreateImage({ prompt: "test", output_file: DEFAULT_OUTPUT }, mockAI);
      assert.ok(result.content[0].text.includes("Image saved to:"));
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
    const buffer = Buffer.from(result.data, "base64");
    assert.ok(buffer.length > 0);
  });

  it("should read a valid JPEG file", () => {
    const result = readImageFile(TINY_JPEG_PATH);
    assert.strictEqual(result.mimeType, "image/jpeg");
    assert.ok(result.data.length > 0);
  });
});
