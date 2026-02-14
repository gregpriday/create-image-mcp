import { describe, it } from "node:test";
import assert from "node:assert";

// Mirror the tool definition from src/index.js for schema validation
const VALID_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];
const VALID_IMAGE_SIZES = ["1K", "2K"];
const VALID_PERSON_GENERATION = ["", "DONT_ALLOW", "ALLOW_ADULT", "ALLOW_ALL"];
const VALID_OUTPUT_MIME_TYPES = ["image/png", "image/jpeg"];

const createImageToolDefinition = {
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
        items: { type: "string" },
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

  it("should require only prompt", () => {
    assert.deepStrictEqual(schema.required, ["prompt"]);
  });

  it("should define all expected properties", () => {
    const expectedProps = [
      "prompt", "input_images", "output_file", "aspect_ratio",
      "image_size", "number_of_images", "output_mime_type", "person_generation",
    ];
    for (const prop of expectedProps) {
      assert.ok(schema.properties[prop], `Missing property: ${prop}`);
    }
  });

  it("should not have unexpected properties", () => {
    const expectedProps = [
      "prompt", "input_images", "output_file", "aspect_ratio",
      "image_size", "number_of_images", "output_mime_type", "person_generation",
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

  it("should have maxLength of 10000", () => {
    assert.strictEqual(prompt.maxLength, 10000);
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

  it("should limit to 4 items", () => {
    assert.strictEqual(inputImages.maxItems, 4);
  });

  it("should mention supported formats in description", () => {
    assert.ok(inputImages.description.includes("PNG"));
    assert.ok(inputImages.description.includes("JPEG"));
    assert.ok(inputImages.description.includes("WebP"));
    assert.ok(inputImages.description.includes("HEIC"));
  });

  it("should mention size limit", () => {
    assert.ok(inputImages.description.includes("20MB"));
  });
});

// ─── Aspect Ratio Property Tests ───

describe("Aspect Ratio Property", () => {
  const ar = createImageToolDefinition.inputSchema.properties.aspect_ratio;

  it("should have all 10 valid ratios", () => {
    assert.strictEqual(ar.enum.length, 10);
    assert.deepStrictEqual(ar.enum, VALID_ASPECT_RATIOS);
  });

  it("should default to 16:9", () => {
    assert.strictEqual(ar.default, "16:9");
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

  it("should have png and jpeg options", () => {
    assert.deepStrictEqual(omt.enum, ["image/png", "image/jpeg"]);
  });

  it("should default to image/png", () => {
    assert.strictEqual(omt.default, "image/png");
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
