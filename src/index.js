#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import OpenAI, { toFile, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, realpathSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, extname, basename, resolve } from "path";
import { homedir } from "os";
import { getStyle, getStyleNames, listStyles } from "./styles.js";
import { loadEnvFiles } from "./env.js";

// Take OPENAI_API_KEY / OPENAI_IMAGE_MODEL from <cwd>/.env or ~/.env when not
// already set (see src/env.js for why nothing else is loaded)
loadEnvFiles();

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);

// Detect if running as the entry point vs imported for testing. Comparing real
// paths handles npm link, npx .bin symlinks, and renamed links alike.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}
const isMainModule = isEntryPoint();

// Per-attempt request timeout. High-quality 4K renders can take a few minutes,
// but a stalled request shouldn't hold the tool call for the SDK's 10-minute default.
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// Route SDK logging (enabled by OPENAI_LOG) to stderr; stdout carries MCP messages
const stderrLogger = {
  error: (...args) => console.error(...args),
  warn: (...args) => console.error(...args),
  info: (...args) => console.error(...args),
  debug: (...args) => console.error(...args),
};

// Initialize OpenAI client (only required when running as server)
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey && isMainModule) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

const openai = apiKey
  ? new OpenAI({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS, logger: stderrLogger })
  : null;

// Image generation models: sunburst is the precision model, flare the faster one.
// OPENAI_IMAGE_MODEL changes the default (e.g. to pin a dated snapshot).
const KNOWN_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"];
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || KNOWN_MODELS[0];
const VALID_MODELS = [...new Set([IMAGE_MODEL, ...KNOWN_MODELS])];

// Max input image size (20MB) and count accepted by the edit endpoint
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_INPUT_IMAGES = 16;

// Supported input image mime types (the edit endpoint rejects GIF)
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

// Prompt limits: the API accepts 32,000 characters including any style preamble
const MAX_PROMPT_LENGTH = 32000;
const MAX_SYSTEM_MESSAGE_LENGTH = 4000;
const MAX_SYSTEM_MESSAGE_FILE_SIZE = 1024 * 1024;

// Size limits for custom WxH sizes
const SIZE_MULTIPLE = 16;
const MAX_SIZE_EDGE = 3840;
const MAX_SIZE_ASPECT_RATIO = 3;
const MIN_SIZE_PIXELS = 655360;
const MAX_SIZE_PIXELS = 8294400;

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_AFTER_MS = 60 * 1000;

// Network failures worth retrying when there is no HTTP status
const RETRYABLE_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_SOCKET"]);

// Error codes that mean retrying can't help
const NON_RETRYABLE_CODES = new Set(["insufficient_quota", "moderation_blocked", "content_policy_violation"]);

// Filesystem error codes reported as [FILE_ERROR]
const FILE_ERROR_CODES = new Set(["EACCES", "ENOENT", "ENOSPC", "EISDIR", "EROFS", "ENOTDIR", "EPERM", "EEXIST", "EMFILE", "ENAMETOOLONG"]);

/**
 * Decide whether an error from an image request is transient.
 * Retries rate limits, conflicts, request timeouts (408), server errors, and
 * dropped connections; never retries auth, validation, quota exhaustion,
 * safety rejections, cancellation, client-side timeouts, or programming errors.
 */
function isRetryableError(error) {
  if (!error || NON_RETRYABLE_CODES.has(error.code)) return false;
  // SDK error classes all report name "Error", so match on class. The timeout
  // class extends APIConnectionError and must be excluded first.
  if (error instanceof APIUserAbortError || error.name === "AbortError") return false;
  if (error instanceof APIConnectionTimeoutError) return false;
  if (error instanceof APIConnectionError) return true;
  const status = error.status || error.statusCode;
  if (status) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return RETRYABLE_NETWORK_CODES.has(error.code ?? error.cause?.code);
}

/**
 * Milliseconds the API asked us to wait (Retry-After header, as seconds or an
 * HTTP date), capped at MAX_RETRY_AFTER_MS.
 */
function retryAfterMs(error) {
  const header = typeof error?.headers?.get === "function"
    ? error.headers.get("retry-after")
    : error?.headers?.["retry-after"];
  if (!header) return 0;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : 0;
}

/**
 * Wait for ms, rejecting early if the signal aborts.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Request was cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Request was cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry helper with exponential backoff and jitter. Honors Retry-After.
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries after the first attempt
 * @param {number} initialDelay - Initial delay in milliseconds
 * @param {AbortSignal} [signal] - Cancels waiting between attempts
 * @returns {Promise} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = MAX_RETRIES, initialDelay = INITIAL_RETRY_DELAY, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || signal?.aborted || !isRetryableError(error)) {
        throw error;
      }
      const backoff = initialDelay * Math.pow(2, attempt) * (1 + Math.random() * 0.25);
      const delay = Math.round(Math.max(backoff, retryAfterMs(error)));
      console.error(`[RETRY] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${error.message || "Unknown error"}. Retrying in ${delay}ms...`);
      await sleep(delay, signal);
    }
  }
}

/**
 * Resolve a user-supplied path to an absolute path, expanding a leading ~.
 * Relative paths resolve against the server's working directory.
 * @param {string} filePath - Path as provided by the caller
 * @returns {string} Absolute path
 */
function resolvePath(filePath) {
  const trimmed = filePath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identify an image by its leading bytes rather than trusting the extension.
 * @param {Buffer} buffer - File contents
 * @returns {string|null} Mime type, or null if unrecognized
 */
function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  return null;
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
  if (!stats.isFile()) {
    throw new Error(`Input image is not a regular file: ${filePath}`);
  }
  if (stats.size > MAX_IMAGE_SIZE) {
    throw new Error(`Input image exceeds 20MB limit: ${filePath} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
  }

  const data = readFileSync(filePath);
  const mimeType = detectImageType(data);
  if (!mimeType || !SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
    const detected = mimeType ? ` (detected ${mimeType})` : "";
    throw new Error(`Unsupported image type for ${filePath}${detected}. Supported: ${SUPPORTED_IMAGE_TYPES.join(", ")}`);
  }

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
const SIZE_PRESETS = ["1024x1024", "1024x1536", "1536x1024", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840", "auto"];
const VALID_MODERATIONS = ["auto", "low"];
const VALID_QUALITIES = ["low", "medium", "high", "auto"];
const VALID_BACKGROUNDS = ["transparent", "opaque", "auto"];
const VALID_OUTPUT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const VALID_INPUT_FIDELITIES = ["high", "low"];

// Output file extensions and the formats they imply
const EXTENSION_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const MIME_TYPE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

// Tool description doubles as a settings guide for the calling agent. Speed and
// cost notes come from measured runs (1024x1024: high quality used ~9x the output
// tokens of low; flare finished high quality in ~60% of sunburst's time).
const TOOL_DESCRIPTION = [
  "Generate or edit images with OpenAI GPT Image 2.5 and save them to disk. Use when asked to 'create an image', 'generate a picture', 'draw', 'make an illustration', 'design a logo/icon/mockup', 'edit an image', 'transform a photo', or any visual content creation request. Pass input_images to edit, combine, or restyle existing images.",
  "",
  `The defaults (${IMAGE_MODEL}, auto quality, 1024x1024 PNG) work well for most requests. When the request calls for something else:`,
  `- model: 'gpt-image-2.5-sunburst' is the precision model: best for final assets, legible text, logos, and fine detail. 'gpt-image-2.5-flare' is faster, especially at higher quality: use it for drafts, brainstorming, and batches of variations. Default: '${IMAGE_MODEL}'.`,
  "- quality: 'low' for quick drafts and thumbnails (cheapest: about 1/9 the output tokens of high); 'medium' for everyday images; 'high' for final deliverables, small or dense text, and detailed scenes; 'auto' (default) lets the model decide.",
  "- size: match the aspect ratio to the use: '1024x1024' square (icons, avatars, social posts), '1536x1024' landscape, '1024x1536' portrait (posters, phone screens), '2048x1152' 16:9 (banners, slides, hero images), '1152x2048' 9:16 (stories). Up to '3840x2160'/'2160x3840' for 4K. Bigger sizes cost more and take longer.",
  "- background 'transparent' for logos, icons, and stickers (PNG or WebP only). Use a .jpg output_file with output_compression for smaller photographic files.",
  "- A common flow: iterate with flare at low quality, then produce the final with sunburst at high quality.",
  "",
  "Use absolute output_file paths; relative paths resolve against the server's working directory. The response lists each saved file with the model, size, and quality actually used.",
].join("\n");

/**
 * JSON Schema properties for create_image. A function because the style enum
 * reflects the create-image-styles/ directory at call time.
 */
function inputSchemaProperties() {
  const styleNames = getStyleNames();
  return {
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
    model: {
      type: "string",
      description: `Image model. 'gpt-image-2.5-sunburst': precision model for final assets, legible text, and fine detail. 'gpt-image-2.5-flare': faster model for drafts, exploration, and variations; quality is close to sunburst for most scenes. Default: '${IMAGE_MODEL}'.`,
      enum: VALID_MODELS,
      default: IMAGE_MODEL,
    },
    style: {
      type: "string",
      description: "Optional style preset that guides image generation towards a specific visual style.",
      enum: styleNames,
      examples: styleNames,
    },
    input_images: {
      oneOf: [
        {
          type: "string",
          description: "A single file path or a JSON-encoded array of file paths.",
        },
        {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: MAX_INPUT_IMAGES,
        },
      ],
      description: "File paths to input images for editing or style reference. Supports PNG, JPEG, and WebP formats. Up to 16 images, max 20MB each. When provided, the prompt should describe how to modify or use these images. Accepts a single path string, a JSON-encoded array string, or an array of strings.",
      examples: [
        "./photo.jpg",
        ["./photo.jpg"],
        ["./source.png", "./style-reference.jpg"],
      ],
    },
    output_file: {
      type: "string",
      description: "File path to save the generated image. Supports both absolute paths (/Users/name/image.png) and relative paths (./output/image.png). Absolute paths are recommended; '~/' expands to the home directory. The extension picks the output format (.png, .jpg/.jpeg, .webp) unless output_mime_type is set, in which case the extension is corrected to match. The saved absolute path is returned in the response.",
      examples: [
        "./generated-image.png",
        "output/my-image.png",
        "/Users/john/Documents/image.png",
      ],
    },
    size: {
      type: "string",
      description: "Output size as WIDTHxHEIGHT. Pick the aspect ratio for the use: '1024x1024' square, '1536x1024' landscape (3:2), '1024x1536' portrait (2:3), '2048x1152' 16:9 banner/slide, '1152x2048' 9:16 story, '2048x2048' large square, '3840x2160'/'2160x3840' 4K. Custom sizes are fine if both edges are multiples of 16, the longest edge is at most 3840, the aspect ratio is at most 3:1, and the total is 655,360-8,294,400 pixels. 'auto' lets the model pick (dimensions are unpredictable, e.g. 1312x1199). Larger sizes cost more and take longer.",
      pattern: "^(auto|[0-9]+x[0-9]+)$",
      default: "1024x1024",
      examples: SIZE_PRESETS,
    },
    quality: {
      type: "string",
      description: "Rendering quality; the biggest lever on cost and speed. 'low': fast drafts and thumbnails (about 1/9 the output tokens of high). 'medium': everyday images. 'high': final deliverables, small or dense text, intricate detail. 'auto' (default): the model decides.",
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
      description: "Number of variations to generate in one call (1-4). Multiple images are saved with numbered filenames (e.g., output_1.png, output_2.png). Each variation is billed separately; consider flare or low quality when exploring.",
      minimum: 1,
      maximum: 4,
      default: 1,
      examples: [1, 2, 4],
    },
    output_mime_type: {
      type: "string",
      description: "Output image format. 'image/png' supports transparency, 'image/jpeg' for smaller file sizes, 'image/webp' for modern web use. Defaults to the format implied by output_file's extension, or PNG.",
      enum: VALID_OUTPUT_MIME_TYPES,
      examples: ["image/png", "image/jpeg", "image/webp"],
    },
    output_compression: {
      type: "integer",
      description: "Compression level (0-100) for JPEG or WebP output. Lower values give smaller files. Not valid for PNG.",
      minimum: 0,
      maximum: 100,
      examples: [80, 50],
    },
    moderation: {
      type: "string",
      description: "Content moderation strictness. 'auto' is the standard filter; 'low' is less restrictive, useful when benign requests are being blocked.",
      enum: VALID_MODERATIONS,
      default: "auto",
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
      description: "File path to a PNG image with an alpha channel to use as a mask for targeted inpainting. Transparent areas of the mask indicate where the image should be edited. Requires input_images.",
      examples: [
        "./mask.png",
        "/Users/john/Documents/mask.png",
      ],
    },
    input_fidelity: {
      type: "string",
      description: "Controls how strictly the output image preserves the original input image details. 'high' preserves more details, 'low' allows more creative freedom. Requires input_images.",
      enum: VALID_INPUT_FIDELITIES,
      examples: ["high", "low"],
    },
  };
}

// List available tools handler (registered below when running as server)
const listToolsHandler = async () => {
  return {
    tools: [
      {
        name: "create_image",
        title: "Create Image",
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: inputSchemaProperties(),
          required: ["prompt", "output_file"],
        },
        annotations: {
          title: "Create Image",
          readOnlyHint: false,
          // Writes to output_file, replacing any existing file at that path
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    ],
  };
};

/**
 * Check a size string against the model's resolution limits.
 * @param {string} size - "auto" or "WIDTHxHEIGHT"
 * @returns {string|null} Error message, or null if valid
 */
function validateSize(size) {
  if (size === "auto") return null;
  const match = typeof size === "string" ? /^(\d+)x(\d+)$/.exec(size) : null;
  if (!match) {
    return `size must be "auto" or WIDTHxHEIGHT (e.g. 1536x1024). Got: ${size}`;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width % SIZE_MULTIPLE !== 0 || height % SIZE_MULTIPLE !== 0) {
    return `size width and height must both be multiples of ${SIZE_MULTIPLE}. Got: ${size}`;
  }
  if (Math.max(width, height) > MAX_SIZE_EDGE) {
    return `size longest edge must be at most ${MAX_SIZE_EDGE}px. Got: ${size}`;
  }
  if (Math.max(width, height) > MAX_SIZE_ASPECT_RATIO * Math.min(width, height)) {
    return `size aspect ratio must be at most ${MAX_SIZE_ASPECT_RATIO}:1. Got: ${size}`;
  }
  const pixels = width * height;
  if (pixels < MIN_SIZE_PIXELS || pixels > MAX_SIZE_PIXELS) {
    return `size must total between ${MIN_SIZE_PIXELS.toLocaleString("en-US")} and ${MAX_SIZE_PIXELS.toLocaleString("en-US")} pixels (e.g. 1024x640 up to 3840x2160). Got: ${size}`;
  }
  return null;
}

/**
 * Some MCP clients send numbers as strings; turn "2" into 2 and leave
 * anything else untouched for validation to reject.
 */
function coerceInteger(value) {
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return value;
}

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
 * @param {AbortSignal} [options.signal] - Cancels the API request and retries
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

  // Reject arguments the schema doesn't define rather than silently ignoring them
  const knownArgs = Object.keys(inputSchemaProperties());
  const unknownArgs = Object.keys(args).filter((key) => !knownArgs.includes(key));
  if (unknownArgs.length > 0) {
    return toolError(`Unknown parameter${unknownArgs.length > 1 ? "s" : ""}: ${unknownArgs.join(", ")}. Valid parameters: ${knownArgs.join(", ")}`);
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
  // Defaults apply only to absent values, so an invalid value like false is rejected
  const model = args.model ?? styleDefaults.model ?? IMAGE_MODEL;
  const size = args.size ?? styleDefaults.size ?? "1024x1024";
  const quality = args.quality ?? styleDefaults.quality ?? "auto";
  const background = args.background ?? styleDefaults.background ?? "auto";
  const numberOfImages = coerceInteger(args.number_of_images ?? 1);
  const explicitCompression = coerceInteger(args.output_compression);
  const moderation = args.moderation ?? styleDefaults.moderation;
  // Format priority: explicit output_mime_type → output_file extension → style default → PNG
  const outputExtMimeType = typeof outputFile === "string"
    ? EXTENSION_MIME_TYPES[extname(outputFile.trim()).toLowerCase()]
    : undefined;
  const outputMimeType = args.output_mime_type ?? outputExtMimeType ?? styleDefaults.output_mime_type ?? "image/png";
  // A style's compression default only applies to formats that support it;
  // compression the caller passes explicitly is validated as given
  const outputCompression = explicitCompression ?? (outputMimeType !== "image/png" ? coerceInteger(styleDefaults.output_compression) : undefined);
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

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return toolError(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
  }

  // Input validation for input_images (if provided, already normalized to array)
  if (inputImages !== undefined && inputImages !== null) {
    if (!Array.isArray(inputImages)) {
      return toolError("input_images must be a string, a JSON-encoded array, or an array of file paths");
    }

    if (inputImages.length === 0) {
      return toolError("input_images cannot be empty");
    }

    if (inputImages.length > MAX_INPUT_IMAGES) {
      return toolError(`input_images accepts at most ${MAX_INPUT_IMAGES} images. Got: ${inputImages.length}`);
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
    const systemMessagePath = resolvePath(systemMessageFile);
    if (!existsSync(systemMessagePath) || !statSync(systemMessagePath).isFile()) {
      return toolError(`System message file not found: ${systemMessageFile}`);
    }
    if (statSync(systemMessagePath).size > MAX_SYSTEM_MESSAGE_FILE_SIZE) {
      return toolError(`System message file is too large (max 1MB; only the first ${MAX_SYSTEM_MESSAGE_LENGTH} characters are used): ${systemMessageFile}`);
    }
    try {
      systemMessage = readFileSync(systemMessagePath, "utf-8").slice(0, MAX_SYSTEM_MESSAGE_LENGTH);
    } catch (error) {
      return toolError(`[FILE_ERROR] Could not read system message file: ${error.message}`);
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

  if (/[\\/]$/.test(outputFile.trim()) || (existsSync(resolvePath(outputFile)) && statSync(resolvePath(outputFile)).isDirectory())) {
    return toolError(`output_file must be a file path, not a directory: ${outputFile}`);
  }

  // Input validation for size
  if (!VALID_MODELS.includes(model)) {
    return toolError(`model must be one of: ${VALID_MODELS.join(", ")}. Got: ${model}`);
  }

  const sizeError = validateSize(size);
  if (sizeError) {
    return toolError(sizeError);
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

  if (outputCompression !== undefined && outputCompression !== null) {
    if (!Number.isInteger(outputCompression) || outputCompression < 0 || outputCompression > 100) {
      return toolError(`output_compression must be an integer between 0 and 100. Got: ${outputCompression}`);
    }
    if (outputMimeType === "image/png") {
      return toolError("output_compression only applies to JPEG or WebP output. Use a .jpg/.webp output_file or set output_mime_type.");
    }
  }

  if (moderation !== undefined && moderation !== null && !VALID_MODERATIONS.includes(moderation)) {
    return toolError(`moderation must be one of: ${VALID_MODERATIONS.join(", ")}. Got: ${moderation}`);
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
    if (!inputImages) {
      return toolError("mask requires input_images: provide the image to edit alongside the mask");
    }
  }

  // Input validation for input_fidelity (if provided)
  if (inputFidelity !== undefined && inputFidelity !== null) {
    if (!VALID_INPUT_FIDELITIES.includes(inputFidelity)) {
      return toolError(`input_fidelity must be one of: ${VALID_INPUT_FIDELITIES.join(", ")}. Got: ${inputFidelity}`);
    }
    if (!inputImages) {
      return toolError("input_fidelity requires input_images: it controls how closely edits preserve the input");
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
    if (effectivePrompt.length > MAX_PROMPT_LENGTH) {
      return toolError(`Prompt plus style/system message is ${effectivePrompt.length} characters; the maximum is ${MAX_PROMPT_LENGTH}. Shorten the prompt.`);
    }

    const hasInputImages = inputImages && inputImages.length > 0;

    // Read and prepare input images and mask up front, so a bad path fails
    // immediately instead of being retried as if it were a transient API error
    let imageFiles = [];
    let maskFile = null;
    if (hasInputImages) {
      for (const imgPath of inputImages) {
        const imageData = readImageFile(resolvePath(imgPath));
        const file = await toFile(imageData.data, basename(imgPath), { type: imageData.mimeType });
        imageFiles.push(file);
      }
      if (mask) {
        const maskData = readImageFile(resolvePath(mask));
        if (maskData.mimeType !== "image/png") {
          return toolError(`mask must be a PNG file with an alpha channel. Got ${maskData.mimeType}: ${mask}`);
        }
        maskFile = await toFile(maskData.data, basename(mask), { type: maskData.mimeType });
      }
    }

    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : MAX_RETRIES;
    const retryDelay = options.retryDelay !== undefined ? options.retryDelay : INITIAL_RETRY_DELAY;

    const params = {
      model,
      prompt: effectivePrompt,
      size,
      quality,
      background,
      output_format: outputFormat,
      n: numberOfImages,
    };
    if (outputCompression !== undefined && outputCompression !== null) {
      params.output_compression = outputCompression;
    }
    if (moderation) {
      params.moderation = moderation;
    }
    if (hasInputImages) {
      params.image = imageFiles.length === 1 ? imageFiles[0] : imageFiles;
      if (maskFile) {
        params.mask = maskFile;
      }
      if (inputFidelity) {
        params.input_fidelity = inputFidelity;
      }
    }

    // Edit endpoint when input images are provided, otherwise text-to-image
    const signal = options.signal;
    const requestOptions = signal ? { signal } : undefined;
    const result = await retryWithBackoff(
      () => hasInputImages ? apiClient.images.edit(params, requestOptions) : apiClient.images.generate(params, requestOptions),
      maxRetries,
      retryDelay,
      signal
    );

    if (signal?.aborted) {
      return toolError("[CANCELLED] The request was cancelled; no files were written.");
    }

    // Decode and check each image before writing anything
    const outputImages = [];
    for (const entry of result?.data ?? []) {
      if (!entry?.b64_json) continue;
      const buffer = Buffer.from(entry.b64_json, "base64");
      if (!detectImageType(buffer)) {
        return toolError("[API_ERROR] The API returned image data that could not be decoded; no files were written.");
      }
      outputImages.push({ buffer, mimeType: outputMimeType });
    }

    if (outputImages.length === 0) {
      return toolError("[NO_IMAGE] No image was generated. The model may have declined the request.");
    }

    // Save images to disk
    // Make the extension match the bytes we actually write: swap a known image
    // extension that disagrees with the format, or append one if missing/unknown
    const savedFiles = [];
    const resolvedOutput = resolvePath(outputFile);
    const requestedExt = extname(resolvedOutput);
    const requestedMimeType = EXTENSION_MIME_TYPES[requestedExt.toLowerCase()];
    const baseName = requestedMimeType
      ? resolvedOutput.slice(0, resolvedOutput.length - requestedExt.length)
      : resolvedOutput;
    const finalExt = requestedMimeType === outputMimeType
      ? requestedExt
      : MIME_TYPE_EXTENSIONS[outputMimeType];
    const outputDir = dirname(resolvedOutput);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Number files whenever several were requested, so names stay predictable
    // even if the API returns fewer images than asked for
    for (let i = 0; i < outputImages.length; i++) {
      const fileName = numberOfImages === 1
        ? `${baseName}${finalExt}`
        : `${baseName}_${i + 1}${finalExt}`;

      try {
        writeFileSync(fileName, outputImages[i].buffer);
      } catch (error) {
        const saved = savedFiles.map((file) => file.path).join(", ");
        return toolError(`[FILE_ERROR] Could not write ${fileName}: ${error.message}${saved ? `. Already saved: ${saved}` : ""}`);
      }
      console.error(`[FILE_OUTPUT] Successfully saved image to: ${fileName}`);
      savedFiles.push({
        path: fileName,
        mimeType: outputImages[i].mimeType,
        size: outputImages[i].buffer.length,
      });
    }

    // Build text-only response with file paths and metadata
    const lines = [];
    for (const file of savedFiles) {
      const sizeKB = (file.size / 1024).toFixed(1);
      lines.push(`Image saved to: ${file.path} (${sizeKB} KB, ${file.mimeType})`);
    }
    if (savedFiles.length < numberOfImages) {
      lines.push(`Note: requested ${numberOfImages} images but the API returned ${savedFiles.length}.`);
    }
    // The API reports what it actually used, which matters when size or quality was "auto"
    const details = [`model ${result.model || model}`, `size ${result.size || size}`, `quality ${result.quality || quality}`];
    if (result.usage?.output_tokens) {
      details.push(`${result.usage.output_tokens} output tokens`);
    }
    lines.push(`Generated with ${details.join(", ")}`);

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

    if (options.signal?.aborted || error instanceof APIUserAbortError || error.name === "AbortError") {
      return toolError("[CANCELLED] The request was cancelled; no files were written.");
    }

    if (error instanceof APIConnectionTimeoutError || error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
      return toolError(`[TIMEOUT_ERROR] Request timed out: ${errorMessage}`);
    }

    if (error instanceof APIConnectionError) {
      return toolError(`[API_ERROR] Could not connect to OpenAI (check network access): ${errorMessage}`);
    }

    if (FILE_ERROR_CODES.has(error.code)) {
      return toolError(`[FILE_ERROR] Filesystem error: ${errorMessage}`);
    }

    if (error.code === "insufficient_quota") {
      return toolError(`[QUOTA_ERROR] OpenAI account is out of credits or over its spending limit: ${errorMessage}`);
    }

    // OpenAI flags safety rejections with an error code (typically on a 400)
    if (error.code === "moderation_blocked" || error.code === "content_policy_violation") {
      return toolError(`[SAFETY_ERROR] Request blocked by safety filters: ${errorMessage}`);
    }

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
      } else if (status === 408) {
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

    if (lowerMessage.includes("api key") || lowerMessage.includes("authentication") || lowerMessage.includes("unauthorized")) {
      return toolError(`[AUTH_ERROR] Invalid or missing API key: ${errorMessage}`);
    } else if (lowerMessage.includes("quota") || lowerMessage.includes("rate limit") || lowerMessage.includes("billing")) {
      return toolError(`[QUOTA_ERROR] API quota exceeded: ${errorMessage}`);
    } else if (lowerMessage.includes("timeout") || lowerMessage.includes("timed out")) {
      return toolError(`[TIMEOUT_ERROR] Request timed out: ${errorMessage}`);
    } else if (lowerMessage.includes("safety") || lowerMessage.includes("blocked") || lowerMessage.includes("content_policy")) {
      return toolError(`[SAFETY_ERROR] Request blocked by safety filters: ${errorMessage}`);
    } else if (lowerMessage.includes("input image") || lowerMessage.includes("unsupported image type")) {
      return toolError(`[FILE_ERROR] ${errorMessage}`);
    } else {
      return toolError(`[API_ERROR] OpenAI API error: ${errorMessage}`);
    }
  }
}

// Register MCP handlers (only when running as server)
if (server) {
  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== "create_image") {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      };
    }
    return handleCreateImage(request.params.arguments || {}, openai, { signal: extra?.signal });
  });
}

// Export for testing
export {
  handleCreateImage,
  listToolsHandler,
  retryWithBackoff,
  readImageFile,
  detectImageType,
  isRetryableError,
  SIZE_PRESETS,
  VALID_MODELS,
  VALID_MODERATIONS,
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
};

// Server startup (only when running as main entry point)
if (isMainModule) {
  // Process stability handlers
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] Unhandled Rejection:", reason instanceof Error ? reason.stack : reason);
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
