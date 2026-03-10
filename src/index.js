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
import { getStyle, getStyleNames, listStyles } from "./styles.js";

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

// Detect if running as main entry point vs imported for testing
const isMainModule = process.argv[1] &&
  (process.argv[1] === __filename || process.argv[1].endsWith("/create-image-mcp"));

// Initialize OpenAI client (only required when running as server)
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey && isMainModule) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

const openai = apiKey ? new OpenAI({ apiKey, maxRetries: 0 }) : null;

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

      // Don't retry on non-retryable error types
      const status = error.status || error.statusCode;
      if (status) {
        // Retry 429 (rate limit) and 5xx (server errors); don't retry anything else
        if (status !== 429 && status < 500) {
          throw error;
        }
      } else {
        // For non-HTTP errors, check message for non-retryable conditions
        const lowerMessage = (error.message || "").toLowerCase();
        if (lowerMessage.includes("api key") ||
            lowerMessage.includes("authentication") ||
            lowerMessage.includes("unauthorized") ||
            lowerMessage.includes("content_policy")) {
          throw error;
        }
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = initialDelay * Math.pow(2, attempt);
      console.error(`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed: ${error.message || "Unknown error"}. Retrying in ${delay}ms...`);

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

// Create MCP server (only when running as main)
const server = isMainModule ? new Server(
  {
    name: "create-image",
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
) : null;

// Valid configuration options
const VALID_SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"];
const VALID_QUALITIES = ["low", "medium", "high", "auto"];
const VALID_BACKGROUNDS = ["transparent", "opaque", "auto"];
const VALID_OUTPUT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const VALID_INPUT_FIDELITIES = ["high", "low"];

// List available tools handler (registered below when running as server)
const listToolsHandler = async () => {
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
            style: {
              type: "string",
              description: "Optional style preset that guides image generation towards a specific visual style.",
              enum: getStyleNames(),
              examples: getStyleNames(),
            },
            input_images: {
              oneOf: [
                {
                  type: "string",
                  description: "A single file path or a JSON-encoded array of file paths.",
                },
                {
                  type: "array",
                  items: { type: "string" },
                },
              ],
              description: "File paths to input images for editing or style reference. Supports PNG, JPEG, WebP, and GIF formats. Max 20MB per image. When provided, the prompt should describe how to modify or use these images. Accepts a single path string, a JSON-encoded array string, or an array of strings.",
              examples: [
                "./photo.jpg",
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
              description: "Number of image variations to generate (1-4). Multiple images are saved with numbered filenames (e.g., output_1.png, output_2.png).",
              minimum: 1,
              maximum: 4,
              default: 1,
              examples: [1, 2, 4],
            },
            output_mime_type: {
              type: "string",
              description: "Output image format. 'image/png' supports transparency, 'image/jpeg' for smaller file sizes, 'image/webp' for modern web use.",
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
            mask: {
              type: "string",
              description: "File path to a PNG image with an alpha channel to use as a mask for targeted inpainting. Transparent areas of the mask indicate where the image should be edited. Only used with the edit endpoint (when input_images is provided).",
              examples: [
                "./mask.png",
                "/Users/john/Documents/mask.png",
              ],
            },
            input_fidelity: {
              type: "string",
              description: "Controls how strictly the output image preserves the original input image details. 'high' preserves more details, 'low' allows more creative freedom. Only used with the edit endpoint (when input_images is provided).",
              enum: VALID_INPUT_FIDELITIES,
              examples: ["high", "low"],
            },
          },
          required: ["prompt", "output_file"],
        },
      },
    ],
  };
};

/**
 * Normalize input_images to an array.
 * Accepts: undefined/null, a string (single path or JSON-encoded array), or an array.
 */
function normalizeInputImages(value) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Not valid JSON, treat as single path
      }
    }
    return [trimmed];
  }
  return value;
}

/**
 * Handle create_image tool calls.
 * Extracted as a named function so unit tests can call it directly with a mock API client.
 *
 * @param {object} args - Tool arguments (prompt, output_file, etc.)
 * @param {object} apiClient - OpenAI-compatible client with images.generate/edit
 * @param {object} [options] - Optional configuration
 * @param {number} [options.maxRetries] - Max retry attempts
 * @param {number} [options.retryDelay] - Initial retry delay in ms
 * @returns {Promise<object>} MCP tool result
 */
async function handleCreateImage(args, apiClient, options = {}) {
  // Helper to return a tool-level error (visible to the model, not a protocol error)
  function toolError(message) {
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }

  // Resolve style preset (if provided)
  const styleName = args.style;
  let style = null;
  if (styleName !== undefined && styleName !== null) {
    if (typeof styleName !== "string") {
      return toolError("style must be a string");
    }
    style = getStyle(styleName);
    if (!style) {
      return toolError(`Unknown style: "${styleName}". Available styles: ${getStyleNames().join(", ")}`);
    }
  }

  // Apply style defaults (user-provided args take priority)
  const styleDefaults = style ? style.defaults || {} : {};

  const prompt = args.prompt;
  const inputImages = normalizeInputImages(args.input_images);
  const outputFile = args.output_file;
  const size = args.size || styleDefaults.size || "1024x1024";
  const quality = args.quality || styleDefaults.quality || "auto";
  const background = args.background || styleDefaults.background || "auto";
  const numberOfImages = args.number_of_images !== undefined && args.number_of_images !== null ? args.number_of_images : 1;
  const outputMimeType = args.output_mime_type || styleDefaults.output_mime_type || "image/png";
  const systemMessageFile = args.system_message_file;
  const mask = args.mask;
  const inputFidelity = args.input_fidelity;

  // Input validation for prompt
  if (!prompt) {
    return toolError("Missing required parameter: prompt");
  }

  if (typeof prompt !== "string") {
    return toolError("Prompt must be a string");
  }

  if (prompt.trim().length === 0) {
    return toolError("Prompt cannot be empty");
  }

  if (prompt.length > 32000) {
    return toolError("Prompt exceeds maximum length of 32000 characters");
  }

  // Input validation for input_images (if provided, already normalized to array)
  if (inputImages !== undefined && inputImages !== null) {
    if (!Array.isArray(inputImages)) {
      return toolError("input_images must be a string, a JSON-encoded array, or an array of file paths");
    }

    if (inputImages.length === 0) {
      return toolError("input_images cannot be empty");
    }

    for (const imgPath of inputImages) {
      if (typeof imgPath !== "string" || imgPath.trim().length === 0) {
        return toolError("Each input_images entry must be a non-empty string file path");
      }
    }
  }

  // Input validation for system_message_file (if provided)
  let systemMessage = null;
  if (systemMessageFile !== undefined && systemMessageFile !== null) {
    if (typeof systemMessageFile !== "string") {
      return toolError("system_message_file must be a string");
    }
    if (systemMessageFile.trim().length === 0) {
      return toolError("system_message_file cannot be empty");
    }
    if (!existsSync(systemMessageFile)) {
      return toolError(`System message file not found: ${systemMessageFile}`);
    }
    systemMessage = readFileSync(systemMessageFile, "utf-8");
    if (systemMessage.length > 4000) {
      systemMessage = systemMessage.slice(0, 4000);
    }
  }

  // Input validation for output_file (required)
  if (!outputFile) {
    return toolError("Missing required parameter: output_file");
  }

  if (typeof outputFile !== "string") {
    return toolError("output_file must be a string");
  }

  if (outputFile.trim().length === 0) {
    return toolError("output_file cannot be empty");
  }

  // Input validation for size
  if (!VALID_SIZES.includes(size)) {
    return toolError(`size must be one of: ${VALID_SIZES.join(", ")}. Got: ${size}`);
  }

  // Input validation for quality
  if (!VALID_QUALITIES.includes(quality)) {
    return toolError(`quality must be one of: ${VALID_QUALITIES.join(", ")}. Got: ${quality}`);
  }

  // Input validation for background
  if (!VALID_BACKGROUNDS.includes(background)) {
    return toolError(`background must be one of: ${VALID_BACKGROUNDS.join(", ")}. Got: ${background}`);
  }

  // Input validation for number_of_images
  if (!Number.isInteger(numberOfImages) || numberOfImages < 1 || numberOfImages > 4) {
    return toolError(`number_of_images must be an integer between 1 and 4. Got: ${numberOfImages}`);
  }

  // Input validation for output_mime_type
  if (!VALID_OUTPUT_MIME_TYPES.includes(outputMimeType)) {
    return toolError(`output_mime_type must be one of: ${VALID_OUTPUT_MIME_TYPES.join(", ")}. Got: ${outputMimeType}`);
  }

  // Cross-field validation: transparent background requires PNG or WebP
  if (background === "transparent" && outputMimeType === "image/jpeg") {
    return toolError("Transparent background requires PNG or WebP output format. JPEG does not support transparency.");
  }

  // Input validation for mask (if provided)
  if (mask !== undefined && mask !== null) {
    if (typeof mask !== "string") {
      return toolError("mask must be a string");
    }
    if (mask.trim().length === 0) {
      return toolError("mask cannot be empty");
    }
  }

  // Input validation for input_fidelity (if provided)
  if (inputFidelity !== undefined && inputFidelity !== null) {
    if (!VALID_INPUT_FIDELITIES.includes(inputFidelity)) {
      return toolError(`input_fidelity must be one of: ${VALID_INPUT_FIDELITIES.join(", ")}. Got: ${inputFidelity}`);
    }
  }

  try {
    // Map output_mime_type to OpenAI output_format
    const outputFormatMap = {
      "image/png": "png",
      "image/jpeg": "jpeg",
      "image/webp": "webp",
    };
    const outputFormat = outputFormatMap[outputMimeType];

    // Build effective prompt: style system prompt → system_message_file → user prompt
    // (OpenAI images API does not support a native system role, so we prepend)
    const preambleParts = [];
    if (style && style.systemPrompt) {
      preambleParts.push(style.systemPrompt.trim());
    }
    if (systemMessage && systemMessage.trim().length > 0) {
      preambleParts.push(systemMessage.trim());
    }
    const effectivePrompt = preambleParts.length > 0
      ? `${preambleParts.join("\n\n")}\n\n${prompt}`
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

    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : MAX_RETRIES;
    const retryDelay = options.retryDelay !== undefined ? options.retryDelay : INITIAL_RETRY_DELAY;

    const result = await retryWithBackoff(async () => {
      if (hasInputImages) {
        // Use edit endpoint for image editing
        const editParams = {
          model: IMAGE_MODEL,
          image: imageFiles.length === 1 ? imageFiles[0] : imageFiles,
          prompt: effectivePrompt,
          size,
          quality,
          background,
          output_format: outputFormat,
          n: numberOfImages,
        };
        if (mask) {
          const maskData = readImageFile(mask);
          const maskFile = await toFile(maskData.data, basename(mask), { type: maskData.mimeType });
          editParams.mask = maskFile;
        }
        if (inputFidelity) {
          editParams.input_fidelity = inputFidelity;
        }
        return await apiClient.images.edit(editParams);
      } else {
        // Use generate endpoint for text-to-image
        return await apiClient.images.generate({
          model: IMAGE_MODEL,
          prompt: effectivePrompt,
          size,
          quality,
          background,
          output_format: outputFormat,
          n: numberOfImages,
        });
      }
    }, maxRetries, retryDelay);

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
    const errorMessage = error.message || "Image generation failed";

    // Categorize errors using status codes when available (OpenAI SDK errors)
    const status = error.status || error.statusCode;
    if (status) {
      if (status === 401) {
        return toolError(`[AUTH_ERROR] Invalid or missing API key: ${errorMessage}`);
      } else if (status === 403) {
        return toolError(`[AUTH_ERROR] Permission denied: ${errorMessage}`);
      } else if (status === 429) {
        return toolError(`[QUOTA_ERROR] Rate limit exceeded: ${errorMessage}`);
      } else if (status === 402) {
        return toolError(`[QUOTA_ERROR] Billing issue: ${errorMessage}`);
      } else if (status === 408 || error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
        return toolError(`[TIMEOUT_ERROR] Request timed out: ${errorMessage}`);
      } else if (status === 400 || status === 422) {
        const lowerMessage = errorMessage.toLowerCase();
        if (lowerMessage.includes("content_policy") || lowerMessage.includes("safety")) {
          return toolError(`[SAFETY_ERROR] Request blocked by safety filters: ${errorMessage}`);
        }
        return toolError(`[API_ERROR] Invalid request: ${errorMessage}`);
      } else if (status >= 500) {
        return toolError(`[API_ERROR] OpenAI server error: ${errorMessage}`);
      }
    }

    // Fallback: categorize by message content
    const lowerMessage = errorMessage.toLowerCase();

    // Filesystem errors (don't mislabel as API errors)
    if (error.code === "EACCES" || error.code === "ENOENT" || error.code === "ENOSPC" || error.code === "EISDIR") {
      return toolError(`[FILE_ERROR] Filesystem error: ${errorMessage}`);
    }

    if (lowerMessage.includes("api key") || lowerMessage.includes("authentication") || lowerMessage.includes("unauthorized")) {
      return toolError(`[AUTH_ERROR] Invalid or missing API key: ${errorMessage}`);
    } else if (lowerMessage.includes("quota") || lowerMessage.includes("rate limit") || lowerMessage.includes("billing")) {
      return toolError(`[QUOTA_ERROR] API quota exceeded: ${errorMessage}`);
    } else if (lowerMessage.includes("timeout")) {
      return toolError(`[TIMEOUT_ERROR] Request timed out: ${errorMessage}`);
    } else if (lowerMessage.includes("safety") || lowerMessage.includes("blocked") || lowerMessage.includes("content_policy")) {
      return toolError(`[SAFETY_ERROR] Request blocked by safety filters: ${errorMessage}`);
    } else if (lowerMessage.includes("input image")) {
      return toolError(`[FILE_ERROR] ${errorMessage}`);
    } else {
      return toolError(`[API_ERROR] OpenAI API error: ${errorMessage}`);
    }
  }
}

// Register MCP handlers (only when running as server)
if (server) {
  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "create_image") {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      };
    }
    return handleCreateImage(request.params.arguments || {}, openai);
  });
}

// Export for testing
export {
  handleCreateImage,
  retryWithBackoff,
  readImageFile,
  VALID_SIZES,
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
};

// Server startup (only when running as main entry point)
if (isMainModule) {
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
}
