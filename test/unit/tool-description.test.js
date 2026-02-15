import { describe, it } from "node:test";
import assert from "node:assert";

// Mirror the tool definition from src/index.js for schema validation
const VALID_SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"];
const VALID_QUALITIES = ["low", "medium", "high", "auto"];
const VALID_BACKGROUNDS = ["transparent", "opaque", "auto"];
const VALID_OUTPUT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const VALID_INPUT_FIDELITIES = ["high", "low"];

const createImageToolDefinition = {
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
        items: { type: "string" },
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
};

// ─── Invocation Cue Tests ───

describe("Invocation Cues", () => {
  const description = createImageToolDefinition.description;

  it("should include 'create an image' trigger phrase", () => {
    assert.ok(description.includes("create an image"));
  });

  it("should include 'generate a picture' trigger phrase", () => {
    assert.ok(description.includes("generate a picture"));
  });

  it("should include 'draw' trigger phrase", () => {
    assert.ok(description.includes("draw"));
  });

  it("should include 'edit an image' trigger phrase", () => {
    assert.ok(description.includes("edit an image"));
  });

  it("should include 'transform a photo' trigger phrase", () => {
    assert.ok(description.includes("transform a photo"));
  });

  it("should mention image input support", () => {
    assert.ok(description.includes("image input"));
  });

  it("should be concise (under 300 characters)", () => {
    assert.ok(description.length < 300, `Description is ${description.length} chars`);
  });
});

// ─── Input Schema Tests ───

describe("Input Schema", () => {
  const schema = createImageToolDefinition.inputSchema;

  it("should have type object", () => {
    assert.strictEqual(schema.type, "object");
  });

  it("should disallow additional properties", () => {
    assert.strictEqual(schema.additionalProperties, false);
  });

  it("should require prompt and output_file", () => {
    assert.deepStrictEqual(schema.required, ["prompt", "output_file"]);
  });

  it("should define all expected properties", () => {
    const expectedProps = [
      "prompt", "input_images", "output_file", "size",
      "quality", "background", "number_of_images", "output_mime_type", "system_message_file",
      "mask", "input_fidelity",
    ];
    for (const prop of expectedProps) {
      assert.ok(schema.properties[prop], `Missing property: ${prop}`);
    }
  });

  it("should not have unexpected properties", () => {
    const expectedProps = [
      "prompt", "input_images", "output_file", "size",
      "quality", "background", "number_of_images", "output_mime_type", "system_message_file",
      "mask", "input_fidelity",
    ];
    const actualProps = Object.keys(schema.properties);
    for (const prop of actualProps) {
      assert.ok(expectedProps.includes(prop), `Unexpected property: ${prop}`);
    }
  });
});

// ─── Prompt Property Tests ───

describe("Prompt Property", () => {
  const prompt = createImageToolDefinition.inputSchema.properties.prompt;

  it("should be a string type", () => {
    assert.strictEqual(prompt.type, "string");
  });

  it("should have minLength of 1", () => {
    assert.strictEqual(prompt.minLength, 1);
  });

  it("should have maxLength of 32000", () => {
    assert.strictEqual(prompt.maxLength, 32000);
  });

  it("should have examples", () => {
    assert.ok(Array.isArray(prompt.examples));
    assert.ok(prompt.examples.length >= 2);
  });

  it("should include editing examples for image input use case", () => {
    const hasEditExample = prompt.examples.some(e =>
      e.toLowerCase().includes("change") ||
      e.toLowerCase().includes("edit") ||
      e.toLowerCase().includes("make this")
    );
    assert.ok(hasEditExample, "Should include examples for image editing");
  });
});

// ─── Input Images Property Tests ───

describe("Input Images Property", () => {
  const inputImages = createImageToolDefinition.inputSchema.properties.input_images;

  it("should be an array type", () => {
    assert.strictEqual(inputImages.type, "array");
  });

  it("should have string items", () => {
    assert.strictEqual(inputImages.items.type, "string");
  });

  it("should not impose a maxItems limit", () => {
    assert.strictEqual(inputImages.maxItems, undefined);
  });

  it("should mention supported formats in description", () => {
    assert.ok(inputImages.description.includes("PNG"));
    assert.ok(inputImages.description.includes("JPEG"));
    assert.ok(inputImages.description.includes("WebP"));
    assert.ok(inputImages.description.includes("GIF"));
  });

  it("should mention size limit", () => {
    assert.ok(inputImages.description.includes("20MB"));
  });
});

// ─── Size Property Tests ───

describe("Size Property", () => {
  const size = createImageToolDefinition.inputSchema.properties.size;

  it("should have all 4 valid sizes", () => {
    assert.strictEqual(size.enum.length, 4);
    assert.deepStrictEqual(size.enum, VALID_SIZES);
  });

  it("should default to 1024x1024", () => {
    assert.strictEqual(size.default, "1024x1024");
  });
});

// ─── Quality Property Tests ───

describe("Quality Property", () => {
  const quality = createImageToolDefinition.inputSchema.properties.quality;

  it("should have all 4 valid qualities", () => {
    assert.strictEqual(quality.enum.length, 4);
    assert.deepStrictEqual(quality.enum, VALID_QUALITIES);
  });

  it("should default to auto", () => {
    assert.strictEqual(quality.default, "auto");
  });
});

// ─── Background Property Tests ───

describe("Background Property", () => {
  const bg = createImageToolDefinition.inputSchema.properties.background;

  it("should have all 3 valid backgrounds", () => {
    assert.strictEqual(bg.enum.length, 3);
    assert.deepStrictEqual(bg.enum, VALID_BACKGROUNDS);
  });

  it("should default to auto", () => {
    assert.strictEqual(bg.default, "auto");
  });

  it("should mention transparency in description", () => {
    assert.ok(bg.description.includes("transparent"));
  });
});

// ─── Number of Images Property Tests ───

describe("Number of Images Property", () => {
  const noi = createImageToolDefinition.inputSchema.properties.number_of_images;

  it("should be integer type", () => {
    assert.strictEqual(noi.type, "integer");
  });

  it("should have minimum of 1", () => {
    assert.strictEqual(noi.minimum, 1);
  });

  it("should have maximum of 4", () => {
    assert.strictEqual(noi.maximum, 4);
  });

  it("should default to 1", () => {
    assert.strictEqual(noi.default, 1);
  });
});

// ─── Output MIME Type Property Tests ───

describe("Output MIME Type Property", () => {
  const omt = createImageToolDefinition.inputSchema.properties.output_mime_type;

  it("should have png, jpeg, and webp options", () => {
    assert.deepStrictEqual(omt.enum, ["image/png", "image/jpeg", "image/webp"]);
  });

  it("should default to image/png", () => {
    assert.strictEqual(omt.default, "image/png");
  });
});

// ─── Mask Property Tests ───

describe("Mask Property", () => {
  const mask = createImageToolDefinition.inputSchema.properties.mask;

  it("should be a string type", () => {
    assert.strictEqual(mask.type, "string");
  });

  it("should mention alpha channel in description", () => {
    assert.ok(mask.description.includes("alpha channel"));
  });

  it("should mention inpainting in description", () => {
    assert.ok(mask.description.includes("inpainting"));
  });

  it("should have examples", () => {
    assert.ok(Array.isArray(mask.examples));
    assert.ok(mask.examples.length >= 1);
  });
});

// ─── Input Fidelity Property Tests ───

describe("Input Fidelity Property", () => {
  const fidelity = createImageToolDefinition.inputSchema.properties.input_fidelity;

  it("should be a string type", () => {
    assert.strictEqual(fidelity.type, "string");
  });

  it("should have high and low enum values", () => {
    assert.deepStrictEqual(fidelity.enum, VALID_INPUT_FIDELITIES);
    assert.strictEqual(fidelity.enum.length, 2);
  });

  it("should not have a default value", () => {
    assert.strictEqual(fidelity.default, undefined);
  });

  it("should have examples", () => {
    assert.ok(Array.isArray(fidelity.examples));
    assert.ok(fidelity.examples.length >= 1);
  });
});

// ─── Tool Metadata Tests ───

describe("Tool Metadata", () => {
  it("should have name 'create_image'", () => {
    assert.strictEqual(createImageToolDefinition.name, "create_image");
  });

  it("should have a description", () => {
    assert.ok(createImageToolDefinition.description.length > 0);
  });

  it("should have a valid inputSchema", () => {
    assert.ok(createImageToolDefinition.inputSchema);
    assert.strictEqual(createImageToolDefinition.inputSchema.type, "object");
  });
});
