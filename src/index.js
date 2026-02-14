#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenAI } from "@google/genai";
import { config } from "dotenv";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, extname } from "path";
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

// Initialize Gemini AI client
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  throw new Error("GOOGLE_API_KEY environment variable is required");
}

const ai = new GoogleGenAI({ apiKey });

// Image generation model
const IMAGE_MODEL = "gemini-3-pro-image-preview";

// Max input image size (20MB)
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

// Supported input image mime types
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic"];

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

      // Don't retry auth errors or quota errors (permanent failures)
      if (lowerMessage.includes("api key") ||
          lowerMessage.includes("quota") ||
          lowerMessage.includes("rate limit")) {
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
 * Read an image file and return its base64 data and mime type
 * @param {string} filePath - Path to the image file
 * @returns {{ data: string, mimeType: string }} Base64 data and mime type
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
    data: data.toString("base64"),
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
const VALID_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];
const VALID_IMAGE_SIZES = ["1K", "2K"];
const VALID_PERSON_GENERATION = ["", "DONT_ALLOW", "ALLOW_ADULT", "ALLOW_ALL"];
const VALID_OUTPUT_MIME_TYPES = ["image/png", "image/jpeg"];

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_image",
        description:
          "Generate or edit images using Google Gemini. Use when asked to 'create an image', 'generate a picture', 'draw', 'make an illustration', 'edit an image', 'transform a photo', or any visual content creation request. Supports image input for editing and style transfer.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            prompt: {
              type: "string",
              description: "A detailed description of the image to generate, or editing instructions when input images are provided. Be specific about style, composition, colors, mood, and subject matter for best results.",
              minLength: 1,
              maxLength: 10000,
              examples: [
                "A serene mountain landscape at sunset with golden light",
                "A futuristic city skyline with flying cars, cyberpunk style",
                "Change the background to a beach scene",
                "Make this image look like a watercolor painting",
              ],
            },
            input_images: {
              type: "array",
              description: "File paths to input images for editing or style reference. Supports PNG, JPEG, WebP, and HEIC formats. Max 20MB per image. When provided, the prompt should describe how to modify or use these images.",
              items: {
                type: "string",
              },
              maxItems: 4,
              examples: [
                ["./photo.jpg"],
                ["./source.png", "./style-reference.jpg"],
              ],
            },
            output_file: {
              type: "string",
              description: "File path to save the generated image. Supports both absolute paths (/Users/name/image.png) and relative paths (./output/image.png). If not provided, the image is returned as base64 data only.",
              examples: [
                "./generated-image.png",
                "output/my-image.png",
                "/Users/john/Documents/image.png",
              ],
            },
            aspect_ratio: {
              type: "string",
              description: "Aspect ratio of the generated image.",
              enum: VALID_ASPECT_RATIOS,
              default: "16:9",
              examples: ["16:9", "1:1", "9:16", "3:2", "21:9"],
            },
            image_size: {
              type: "string",
              description: "Resolution of the generated image. '2K' produces higher quality output.",
              enum: VALID_IMAGE_SIZES,
              default: "2K",
              examples: ["2K", "1K"],
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
              examples: ["image/png", "image/jpeg"],
            },
            person_generation: {
              type: "string",
              description: "Controls whether people can appear in generated images. Empty string uses model default, 'DONT_ALLOW' blocks people, 'ALLOW_ADULT' allows adult faces, 'ALLOW_ALL' allows all people including children.",
              enum: VALID_PERSON_GENERATION,
              default: "",
              examples: ["", "ALLOW_ADULT", "DONT_ALLOW"],
            },
          },
          required: ["prompt"],
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
  const aspectRatio = request.params.arguments?.aspect_ratio || "16:9";
  const imageSize = request.params.arguments?.image_size || "2K";
  const numberOfImages = request.params.arguments?.number_of_images || 1;
  const outputMimeType = request.params.arguments?.output_mime_type || "image/png";
  const personGeneration = request.params.arguments?.person_generation ?? "";

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

  // Input validation for input_images (if provided)
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

  // Input validation for output_file (if provided)
  if (outputFile !== undefined && outputFile !== null) {
    if (typeof outputFile !== "string") {
      throw new Error("output_file must be a string");
    }

    if (outputFile.trim().length === 0) {
      throw new Error("output_file cannot be empty");
    }
  }

  // Input validation for aspect_ratio
  if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Error(`aspect_ratio must be one of: ${VALID_ASPECT_RATIOS.join(", ")}. Got: ${aspectRatio}`);
  }

  // Input validation for image_size
  if (!VALID_IMAGE_SIZES.includes(imageSize)) {
    throw new Error(`image_size must be one of: ${VALID_IMAGE_SIZES.join(", ")}. Got: ${imageSize}`);
  }

  // Input validation for number_of_images
  if (!Number.isInteger(numberOfImages) || numberOfImages < 1 || numberOfImages > 4) {
    throw new Error(`number_of_images must be an integer between 1 and 4. Got: ${numberOfImages}`);
  }

  // Input validation for output_mime_type
  if (!VALID_OUTPUT_MIME_TYPES.includes(outputMimeType)) {
    throw new Error(`output_mime_type must be one of: ${VALID_OUTPUT_MIME_TYPES.join(", ")}. Got: ${outputMimeType}`);
  }

  // Input validation for person_generation
  if (!VALID_PERSON_GENERATION.includes(personGeneration)) {
    throw new Error(`person_generation must be one of: ${VALID_PERSON_GENERATION.join(", ")}. Got: ${personGeneration}`);
  }

  try {
    // Read input images if provided
    const imageParts = [];
    if (inputImages && inputImages.length > 0) {
      for (const imgPath of inputImages) {
        const imageData = readImageFile(imgPath);
        imageParts.push({
          inlineData: {
            mimeType: imageData.mimeType,
            data: imageData.data,
          },
        });
      }
    }

    const generationConfig = {
      responseModalities: ["IMAGE", "TEXT"],
      imageConfig: {
        aspectRatio: aspectRatio,
        imageSize: imageSize,
        personGeneration: personGeneration,
        numberOfImages: numberOfImages,
        outputMimeType: outputMimeType,
      },
      tools: [{ googleSearch: {} }],
    };

    // Build content parts: text prompt + any input images
    const parts = [{ text: prompt }, ...imageParts];

    const contents = [
      {
        role: "user",
        parts,
      },
    ];

    // Generate image with retry logic
    const result = await retryWithBackoff(async () => {
      const response = await ai.models.generateContentStream({
        model: IMAGE_MODEL,
        config: generationConfig,
        contents,
      });

      // Collect all parts from the stream
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

      return { outputImages, textParts };
    });

    const { outputImages, textParts } = result;

    if (outputImages.length === 0) {
      const textResponse = textParts.join("") || "No image was generated. The model may have declined the request.";
      return {
        content: [
          {
            type: "text",
            text: `[NO_IMAGE] ${textResponse}`,
          },
        ],
      };
    }

    // Build MCP response content
    const content = [];

    // Save images to file if output_file was provided
    if (outputFile) {
      const ext = extname(outputFile);
      const baseName = outputFile.slice(0, outputFile.length - ext.length);

      for (let i = 0; i < outputImages.length; i++) {
        const fileName = outputImages.length === 1
          ? outputFile
          : `${baseName}_${i + 1}${ext}`;

        try {
          const buffer = Buffer.from(outputImages[i].data, "base64");
          writeFileSync(fileName, buffer);
          console.error(`[FILE_OUTPUT] Successfully saved image to: ${fileName}`);
          content.push({
            type: "text",
            text: `Image saved to: ${fileName}`,
          });
        } catch (fileError) {
          console.error(`[FILE_OUTPUT] Failed to save to ${fileName}: ${fileError.message}`);
          content.push({
            type: "text",
            text: `Failed to save image to '${fileName}': ${fileError.message}`,
          });
        }
      }
    }

    // Add all images as base64 content
    for (const outputImage of outputImages) {
      content.push({
        type: "image",
        data: outputImage.data,
        mimeType: outputImage.mimeType,
      });
    }

    // Add any text the model returned alongside the image
    if (textParts.length > 0) {
      content.push({
        type: "text",
        text: textParts.join(""),
      });
    }

    return { content };
  } catch (error) {
    // MCP-specific error handling with codes
    const errorMessage = error.message || "Image generation failed";
    const lowerMessage = errorMessage.toLowerCase();

    // Categorize errors (case-insensitive)
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
});

// Export for testing
export {
  retryWithBackoff,
  readImageFile,
  VALID_ASPECT_RATIOS,
  VALID_IMAGE_SIZES,
  VALID_PERSON_GENERATION,
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
