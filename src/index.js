#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI, { toFile } from "openai";
import { config } from "dotenv";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, extname, basename } from "path";
import { homedir } from "os";
import mime from "mime";

// Load .env file if it exists (supports both local dev and global install)
// First try CWD, then fallback to home directory (won't override existing env)
config({ path: join(process.cwd(), ".env") });
config({ path: join(homedir(), ".env") });

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);

// Initialize OpenAI client
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

const openai = new OpenAI({ apiKey });

// Image generation model
const IMAGE_MODEL = "gpt-image-1.5";

// Max input image size (20MB)
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

// Supported input image mime types
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

/**
 * Retry helper with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} initialDelay - Initial delay in milliseconds
 * @returns {Promise} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = MAX_RETRIES, initialDelay = INITIAL_RETRY_DELAY) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on certain error types
      const errorMessage = error.message || "";
      const lowerMessage = errorMessage.toLowerCase();

      // Don't retry auth errors, quota errors, or content policy violations
      if (lowerMessage.includes("api key") ||
          lowerMessage.includes("authentication") ||
          lowerMessage.includes("unauthorized") ||
          lowerMessage.includes("quota") ||
          lowerMessage.includes("rate limit") ||
          lowerMessage.includes("billing") ||
          lowerMessage.includes("content_policy")) {
        throw error;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = initialDelay * Math.pow(2, attempt);
      console.error(`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed: ${errorMessage}. Retrying in ${delay}ms...`);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Read an image file and return its buffer and mime type
 * @param {string} filePath - Path to the image file
 * @returns {{ data: Buffer, mimeType: string }} Buffer and mime type
 */
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
  return {
    data,
    mimeType,
  };
}

// Create MCP server
const server = new Server(
  {
    name: "create-image",
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Valid configuration options
const VALID_SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"];
const VALID_QUALITIES = ["low", "medium", "high", "auto"];
const VALID_BACKGROUNDS = ["transparent", "opaque", "auto"];
const VALID_OUTPUT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_image",
        description:
          "Generate or edit images using OpenAI GPT Image. Use when asked to 'create an image', 'generate a picture', 'draw', 'make an illustration', 'edit an image', 'transform a photo', or any visual content creation request. Supports image input for editing and style transfer.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            prompt: {
              type: "string",
              description: "A detailed description of the image to generate, or editing instructions when input images are provided. Be specific about style, composition, colors, mood, and subject matter for best results.",
              minLength: 1,
              maxLength: 32000,
              examples: [
                "A serene mountain landscape at sunset with golden light",
                "A futuristic city skyline with flying cars, cyberpunk style",
                "Change the background to a beach scene",
                "Make this image look like a watercolor painting",
              ],
            },
            input_images: {
              type: "array",
              description: "File paths to input images for editing or style reference. Supports PNG, JPEG, WebP, and GIF formats. Max 20MB per image. When provided, the prompt should describe how to modify or use these images.",
              items: {
                type: "string",
              },
              examples: [
                ["./photo.jpg"],
                ["./source.png", "./style-reference.jpg"],
              ],
            },
            output_file: {
              type: "string",
              description: "File path to save the generated image. Supports both absolute paths (/Users/name/image.png) and relative paths (./output/image.png). The image will be written to this path and the path returned in the response.",
              examples: [
                "./generated-image.png",
                "output/my-image.png",
                "/Users/john/Documents/image.png",
              ],
            },
            size: {
              type: "string",
              description: "Size of the generated image. '1024x1024' for square, '1024x1536' for portrait, '1536x1024' for landscape, or 'auto' to let the model decide.",
              enum: VALID_SIZES,
              default: "1024x1024",
              examples: ["1024x1024", "1024x1536", "1536x1024", "auto"],
            },
            quality: {
              type: "string",
              description: "Quality of the generated image. 'high' produces the most detailed output, 'medium' balances quality and speed, 'low' is fastest, 'auto' lets the model decide.",
              enum: VALID_QUALITIES,
              default: "auto",
              examples: ["auto", "high", "medium", "low"],
            },
            background: {
              type: "string",
              description: "Background style for the generated image. 'transparent' generates images with a transparent background (requires PNG or WebP output), 'opaque' forces a solid background, 'auto' lets the model decide.",
              enum: VALID_BACKGROUNDS,
              default: "auto",
              examples: ["auto", "transparent", "opaque"],
            },
            number_of_images: {
              type: "integer",
              description: "Number of image variations to generate (1-4).",
              minimum: 1,
              maximum: 4,
              default: 1,
              examples: [1, 2, 4],
            },
            output_mime_type: {
              type: "string",
              description: "Output image format.",
              enum: VALID_OUTPUT_MIME_TYPES,
              default: "image/png",
              examples: ["image/png", "image/jpeg", "image/webp"],
            },
            system_message_file: {
              type: "string",
              description: "File path to a text file containing system-level instructions. The file contents are prepended to the prompt (truncated to 4000 chars). Use for persistent style guidelines, brand constraints, or negative constraints. Since the OpenAI images API does not support a native system role, the content is prepended to the prompt.",
              examples: [
                "./system-prompt.txt",
                "/Users/john/brand-guidelines.txt",
              ],
            },
          },
          required: ["prompt", "output_file"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "create_image") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const prompt = request.params.arguments?.prompt;
  const inputImages = request.params.arguments?.input_images;
  const outputFile = request.params.arguments?.output_file;
  const size = request.params.arguments?.size || "1024x1024";
  const quality = request.params.arguments?.quality || "auto";
  const background = request.params.arguments?.background || "auto";
  const numberOfImages = request.params.arguments?.number_of_images || 1;
  const outputMimeType = request.params.arguments?.output_mime_type || "image/png";
  const systemMessageFile = request.params.arguments?.system_message_file;

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

  // Input validation for input_images (if provided)
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

  // Input validation for system_message_file (if provided)
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

  // Input validation for size
  if (!VALID_SIZES.includes(size)) {
    throw new Error(`size must be one of: ${VALID_SIZES.join(", ")}. Got: ${size}`);
  }

  // Input validation for quality
  if (!VALID_QUALITIES.includes(quality)) {
    throw new Error(`quality must be one of: ${VALID_QUALITIES.join(", ")}. Got: ${quality}`);
  }

  // Input validation for background
  if (!VALID_BACKGROUNDS.includes(background)) {
    throw new Error(`background must be one of: ${VALID_BACKGROUNDS.join(", ")}. Got: ${background}`);
  }

  // Input validation for number_of_images
  if (!Number.isInteger(numberOfImages) || numberOfImages < 1 || numberOfImages > 4) {
    throw new Error(`number_of_images must be an integer between 1 and 4. Got: ${numberOfImages}`);
  }

  // Input validation for output_mime_type
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
    // (OpenAI images API does not support a native system role)
    const effectivePrompt = systemMessage && systemMessage.trim().length > 0
      ? `${systemMessage.trim()}\n\n${prompt}`
      : prompt;

    const hasInputImages = inputImages && inputImages.length > 0;

    // Read and prepare input images if provided
    let imageFiles = [];
    if (hasInputImages) {
      for (const imgPath of inputImages) {
        const imageData = readImageFile(imgPath);
        const file = await toFile(imageData.data, basename(imgPath), { type: imageData.mimeType });
        imageFiles.push(file);
      }
    }

    // Generate images
    const outputImages = [];

    const result = await retryWithBackoff(async () => {
      if (hasInputImages) {
        // Use edit endpoint for image editing
        return await openai.images.edit({
          model: IMAGE_MODEL,
          image: imageFiles.length === 1 ? imageFiles[0] : imageFiles,
          prompt: effectivePrompt,
          size,
          n: numberOfImages,
        });
      } else {
        // Use generate endpoint for text-to-image
        return await openai.images.generate({
          model: IMAGE_MODEL,
          prompt: effectivePrompt,
          size,
          quality,
          background,
          output_format: outputFormat,
          n: numberOfImages,
        });
      }
    });

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
        content: [
          {
            type: "text",
            text: "[NO_IMAGE] No image was generated. The model may have declined the request.",
          },
        ],
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
      const fileName = outputImages.length === 1
        ? outputFile
        : `${baseName}_${i + 1}${ext}`;

      const buffer = Buffer.from(outputImages[i].data, "base64");
      writeFileSync(fileName, buffer);
      console.error(`[FILE_OUTPUT] Successfully saved image to: ${fileName}`);
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
      content: [
        {
          type: "text",
          text: lines.join("\n"),
        },
      ],
    };
  } catch (error) {
    // MCP-specific error handling with codes
    const errorMessage = error.message || "Image generation failed";
    const lowerMessage = errorMessage.toLowerCase();

    // Categorize errors (case-insensitive)
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
});

// Export for testing
export {
  retryWithBackoff,
  readImageFile,
  VALID_SIZES,
  VALID_QUALITIES,
  VALID_BACKGROUNDS,
  VALID_OUTPUT_MIME_TYPES,
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_SIZE,
  IMAGE_MODEL,
};

// Process stability handlers
process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled Rejection at:", promise, "Reason:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught Exception:", error.message, error.stack);
  process.exit(1);
});

// Graceful shutdown handler
process.on("SIGINT", () => {
  console.error("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Create Image MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
