import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

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

  // Input validation for output_file
  if (outputFile !== undefined && outputFile !== null) {
    if (typeof outputFile !== "string") {
      throw new Error("output_file must be a string");
    }
    if (outputFile.trim().length === 0) {
      throw new Error("output_file cannot be empty");
    }
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
      const { readImageFile } = await import("../../src/index.js");
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

    const content = [];

    if (outputFile) {
      const { extname } = await import("path");
      const ext = extname(outputFile);
      const baseName = outputFile.slice(0, outputFile.length - ext.length);

      for (let i = 0; i < outputImages.length; i++) {
        const fileName = outputImages.length === 1 ? outputFile : `${baseName}_${i + 1}${ext}`;
        try {
          const buffer = Buffer.from(outputImages[i].data, "base64");
          writeFileSync(fileName, buffer);
          content.push({ type: "text", text: `Image saved to: ${fileName}` });
        } catch (fileError) {
          content.push({ type: "text", text: `Failed to save image to '${fileName}': ${fileError.message}` });
        }
      }
    }

    for (const outputImage of outputImages) {
      content.push({ type: "image", data: outputImage.data, mimeType: outputImage.mimeType });
    }

    if (textParts.length > 0) {
      content.push({ type: "text", text: textParts.join("") });
    }

    return { content };
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

// ─── Input Validation Tests ───

describe("Input Validation", () => {
  let mockAI;

  beforeEach(() => {
    mockAI = new MockGenerativeAI();
  });

  it("should reject missing prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({}, mockAI),
      /Missing required parameter: prompt/
    );
  });

  it("should reject null prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: null }, mockAI),
      /Missing required parameter: prompt/
    );
  });

  it("should reject undefined prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: undefined }, mockAI),
      /Missing required parameter: prompt/
    );
  });

  it("should reject non-string prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: 123 }, mockAI),
      /Prompt must be a string/
    );
  });

  it("should reject empty string prompt", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "   " }, mockAI),
      /Prompt cannot be empty/
    );
  });

  it("should reject prompt exceeding max length", async () => {
    const longPrompt = "x".repeat(10001);
    await assert.rejects(
      () => handleCreateImage({ prompt: longPrompt }, mockAI),
      /Prompt exceeds maximum length of 10000 characters/
    );
  });

  it("should accept prompt at max length boundary", async () => {
    const maxPrompt = "x".repeat(10000);
    const result = await handleCreateImage({ prompt: maxPrompt }, mockAI);
    assert.ok(result.content.length > 0);
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
      () => handleCreateImage({ prompt: "test", input_images: "not-array" }, mockAI),
      /input_images must be an array/
    );
  });

  it("should reject empty input_images array", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", input_images: [] }, mockAI),
      /input_images cannot be an empty array/
    );
  });

  it("should reject input_images with more than 4 entries", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", input_images: ["a", "b", "c", "d", "e"] }, mockAI),
      /input_images cannot contain more than 4 images/
    );
  });

  it("should reject input_images with non-string entries", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", input_images: [123] }, mockAI),
      /Each input_images entry must be a non-empty string/
    );
  });

  it("should reject input_images with empty string entries", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", input_images: ["  "] }, mockAI),
      /Each input_images entry must be a non-empty string/
    );
  });

  it("should accept valid input_images with existing files", async () => {
    const result = await handleCreateImage(
      { prompt: "edit this image", input_images: [TINY_PNG_PATH] },
      mockAI
    );
    assert.ok(result.content.length > 0);
    // Verify the request included image data
    const requestParts = mockAI.lastRequest.contents[0].parts;
    assert.strictEqual(requestParts.length, 2); // text + image
    assert.ok(requestParts[1].inlineData);
    assert.strictEqual(requestParts[1].inlineData.mimeType, "image/png");
  });

  it("should accept multiple input images", async () => {
    const result = await handleCreateImage(
      { prompt: "combine these", input_images: [TINY_PNG_PATH, TINY_JPEG_PATH] },
      mockAI
    );
    assert.ok(result.content.length > 0);
    const requestParts = mockAI.lastRequest.contents[0].parts;
    assert.strictEqual(requestParts.length, 3); // text + 2 images
  });

  it("should skip input_images when undefined", async () => {
    const result = await handleCreateImage({ prompt: "test" }, mockAI);
    assert.ok(result.content.length > 0);
    const requestParts = mockAI.lastRequest.contents[0].parts;
    assert.strictEqual(requestParts.length, 1); // text only
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

  it("should save image to output_file", async () => {
    const outputPath = join(fixturesDir, "output-test.png");
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: outputPath },
        mockAI
      );
      assert.ok(existsSync(outputPath));
      const saveText = result.content.find(c => c.type === "text" && c.text.includes("Image saved to:"));
      assert.ok(saveText);
    } finally {
      if (existsSync(outputPath)) unlinkSync(outputPath);
    }
  });

  it("should handle file save errors gracefully", async () => {
    const result = await handleCreateImage(
      { prompt: "test", output_file: "/nonexistent/dir/image.png" },
      mockAI
    );
    const errorText = result.content.find(c => c.type === "text" && c.text.includes("Failed to save"));
    assert.ok(errorText);
    // Should still return the image data
    const imageContent = result.content.find(c => c.type === "image");
    assert.ok(imageContent);
  });

  it("should number multiple output files", async () => {
    const mockMulti = new MockGenerativeAI({
      responses: [MockGenerativeAI.multiImageResponse(2)],
    });
    const outputPath = join(fixturesDir, "multi-output.png");
    try {
      const result = await handleCreateImage(
        { prompt: "test", output_file: outputPath },
        mockMulti
      );
      const saveTexts = result.content.filter(c => c.type === "text" && c.text.includes("Image saved to:"));
      assert.strictEqual(saveTexts.length, 2);
      assert.ok(saveTexts[0].text.includes("multi-output_1.png"));
      assert.ok(saveTexts[1].text.includes("multi-output_2.png"));
    } finally {
      const file1 = join(fixturesDir, "multi-output_1.png");
      const file2 = join(fixturesDir, "multi-output_2.png");
      if (existsSync(file1)) unlinkSync(file1);
      if (existsSync(file2)) unlinkSync(file2);
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
      const result = await handleCreateImage({ prompt: "test", aspect_ratio: ratio }, mockAI);
      assert.ok(result.content.length > 0, `Failed for ratio: ${ratio}`);
    }
  });

  it("should reject invalid aspect ratio", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", aspect_ratio: "7:3" }, mockAI),
      /aspect_ratio must be one of/
    );
  });

  it("should default to 16:9", async () => {
    await handleCreateImage({ prompt: "test" }, mockAI);
    assert.strictEqual(mockAI.lastRequest.config.imageConfig.aspectRatio, "16:9");
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
      const result = await handleCreateImage({ prompt: "test", image_size: size }, mockAI);
      assert.ok(result.content.length > 0);
    }
  });

  it("should reject invalid image size", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", image_size: "4K" }, mockAI),
      /image_size must be one of/
    );
  });

  it("should default to 2K", async () => {
    await handleCreateImage({ prompt: "test" }, mockAI);
    assert.strictEqual(mockAI.lastRequest.config.imageConfig.imageSize, "2K");
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
      const result = await handleCreateImage({ prompt: "test", number_of_images: n }, mockAI);
      assert.ok(result.content.length > 0);
    }
  });

  it("should reject 0", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", number_of_images: 0 }, mockAI),
      /number_of_images must be an integer between 1 and 4/
    );
  });

  it("should reject 5", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", number_of_images: 5 }, mockAI),
      /number_of_images must be an integer between 1 and 4/
    );
  });

  it("should reject non-integer", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", number_of_images: 1.5 }, mockAI),
      /number_of_images must be an integer between 1 and 4/
    );
  });

  it("should default to 1", async () => {
    await handleCreateImage({ prompt: "test" }, mockAI);
    assert.strictEqual(mockAI.lastRequest.config.imageConfig.numberOfImages, 1);
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
      const result = await handleCreateImage({ prompt: "test", output_mime_type: mt }, mockAI);
      assert.ok(result.content.length > 0);
    }
  });

  it("should reject invalid mime type", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", output_mime_type: "image/gif" }, mockAI),
      /output_mime_type must be one of/
    );
  });

  it("should default to image/png", async () => {
    await handleCreateImage({ prompt: "test" }, mockAI);
    assert.strictEqual(mockAI.lastRequest.config.imageConfig.outputMimeType, "image/png");
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
      const result = await handleCreateImage({ prompt: "test", person_generation: pg }, mockAI);
      assert.ok(result.content.length > 0);
    }
  });

  it("should reject invalid value", async () => {
    await assert.rejects(
      () => handleCreateImage({ prompt: "test", person_generation: "INVALID" }, mockAI),
      /person_generation must be one of/
    );
  });

  it("should default to empty string", async () => {
    await handleCreateImage({ prompt: "test" }, mockAI);
    assert.strictEqual(mockAI.lastRequest.config.imageConfig.personGeneration, "");
  });
});

// ─── Successful Response Tests ───

describe("Successful Responses", () => {
  it("should return image content for basic generation", async () => {
    const mockAI = new MockGenerativeAI();
    const result = await handleCreateImage({ prompt: "A mountain landscape" }, mockAI);

    const imageContent = result.content.find(c => c.type === "image");
    assert.ok(imageContent);
    assert.strictEqual(imageContent.mimeType, "image/png");
    assert.ok(imageContent.data.length > 0);
  });

  it("should return text when model returns text alongside image", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [MockGenerativeAI.imageWithTextResponse("Here is your generated image")],
    });
    const result = await handleCreateImage({ prompt: "test" }, mockAI);

    const imageContent = result.content.find(c => c.type === "image");
    const textContent = result.content.find(c => c.type === "text" && !c.text.startsWith("Image saved"));
    assert.ok(imageContent);
    assert.ok(textContent);
    assert.strictEqual(textContent.text, "Here is your generated image");
  });

  it("should handle text-only response (no image generated)", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [MockGenerativeAI.textOnlyResponse("I cannot generate that image")],
    });
    const result = await handleCreateImage({ prompt: "test" }, mockAI);

    assert.strictEqual(result.content.length, 1);
    assert.ok(result.content[0].text.includes("[NO_IMAGE]"));
    assert.ok(result.content[0].text.includes("I cannot generate that image"));
  });

  it("should handle empty response", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [MockGenerativeAI.emptyResponse()],
    });
    const result = await handleCreateImage({ prompt: "test" }, mockAI);

    assert.strictEqual(result.content.length, 1);
    assert.ok(result.content[0].text.includes("[NO_IMAGE]"));
    assert.ok(result.content[0].text.includes("model may have declined"));
  });

  it("should handle multiple images in response", async () => {
    const mockAI = new MockGenerativeAI({
      responses: [MockGenerativeAI.multiImageResponse(3)],
    });
    const result = await handleCreateImage({ prompt: "test" }, mockAI);

    const imageContents = result.content.filter(c => c.type === "image");
    assert.strictEqual(imageContents.length, 3);
  });

  it("should pass all config parameters to API", async () => {
    const mockAI = new MockGenerativeAI();
    await handleCreateImage({
      prompt: "test",
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
  });

  it("should include googleSearch in tools config", async () => {
    const mockAI = new MockGenerativeAI();
    await handleCreateImage({ prompt: "test" }, mockAI);
    assert.deepStrictEqual(mockAI.lastRequest.config.tools, [{ googleSearch: {} }]);
  });
});

// ─── Error Handling Tests ───

describe("Error Handling", () => {
  it("should categorize auth errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Invalid api key provided")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test" }, mockAI),
      /\[AUTH_ERROR\]/
    );
  });

  it("should categorize quota errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Quota exceeded for this project")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test" }, mockAI),
      /\[QUOTA_ERROR\]/
    );
  });

  it("should categorize rate limit errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Rate limit reached")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test" }, mockAI),
      /\[QUOTA_ERROR\]/
    );
  });

  it("should categorize timeout errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Request timeout after 30s")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test" }, mockAI),
      /\[TIMEOUT_ERROR\]/
    );
  });

  it("should categorize safety errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Content blocked by safety filters")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test" }, mockAI),
      /\[SAFETY_ERROR\]/
    );
  });

  it("should categorize generic errors", async () => {
    const mockAI = new MockGenerativeAI({
      errors: [new Error("Something went wrong")],
    });
    await assert.rejects(
      () => handleCreateImage({ prompt: "test" }, mockAI),
      /\[API_ERROR\]/
    );
  });
});

// ─── Edge Cases ───

describe("Edge Cases", () => {
  it("should handle special characters in prompt", async () => {
    const mockAI = new MockGenerativeAI();
    const result = await handleCreateImage(
      { prompt: 'A "quoted" image with <html> & special chars!' },
      mockAI
    );
    assert.ok(result.content.length > 0);
  });

  it("should handle unicode in prompt", async () => {
    const mockAI = new MockGenerativeAI();
    const result = await handleCreateImage(
      { prompt: "An image of a dragon" },
      mockAI
    );
    assert.ok(result.content.length > 0);
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
    const result = await handleCreateImage({ prompt: "test" }, mockAI);
    const imageContent = result.content.find(c => c.type === "image");
    assert.ok(imageContent);
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
    const result = await handleCreateImage({ prompt: "test" }, mockAI);
    const imageContent = result.content.find(c => c.type === "image");
    assert.ok(imageContent);
  });
});

// ─── readImageFile Tests ───

describe("readImageFile", () => {
  it("should throw for non-existent file", async () => {
    const { readImageFile } = await import("../../src/index.js");
    assert.throws(
      () => readImageFile("/nonexistent/image.png"),
      /Input image file not found/
    );
  });

  it("should throw for unsupported file type", async () => {
    const { readImageFile } = await import("../../src/index.js");
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

  it("should read a valid PNG file", async () => {
    const { readImageFile } = await import("../../src/index.js");
    const result = readImageFile(TINY_PNG_PATH);
    assert.strictEqual(result.mimeType, "image/png");
    assert.ok(result.data.length > 0);
    // Verify it's valid base64
    const buffer = Buffer.from(result.data, "base64");
    assert.ok(buffer.length > 0);
  });

  it("should read a valid JPEG file", async () => {
    const { readImageFile } = await import("../../src/index.js");
    const result = readImageFile(TINY_JPEG_PATH);
    assert.strictEqual(result.mimeType, "image/jpeg");
    assert.ok(result.data.length > 0);
  });
});
