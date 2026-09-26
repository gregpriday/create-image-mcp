import { describe, it } from "node:test";
import assert from "node:assert";
import {
  SIZE_PRESETS,
  VALID_MODELS,
  VALID_MODERATIONS,
  VALID_QUALITIES,
  VALID_BACKGROUNDS,
  VALID_OUTPUT_MIME_TYPES,
  VALID_INPUT_FIDELITIES,
  getStyleNames,
  listToolsHandler,
  IMAGE_MODEL,
} from "../../src/index.js";


// ─── Exported Constants Tests ───

describe("Exported Constants", () => {
  it("should include the standard size presets", () => {
    for (const s of ["1024x1024", "1024x1536", "1536x1024", "auto"]) {
      assert.ok(SIZE_PRESETS.includes(s), `missing ${s}`);
    }
  });

  it("should offer both GPT Image 2.5 models", () => {
    assert.ok(VALID_MODELS.includes("gpt-image-2.5-sunburst"));
    assert.ok(VALID_MODELS.includes("gpt-image-2.5-flare"));
  });

  it("should have 2 valid moderation levels", () => {
    assert.deepStrictEqual(VALID_MODERATIONS, ["auto", "low"]);
  });

  it("should have 4 valid qualities", () => {
    assert.deepStrictEqual(VALID_QUALITIES, ["low", "medium", "high", "auto"]);
  });

  it("should have 3 valid backgrounds", () => {
    assert.deepStrictEqual(VALID_BACKGROUNDS, ["transparent", "opaque", "auto"]);
  });

  it("should have 3 valid output MIME types", () => {
    assert.deepStrictEqual(VALID_OUTPUT_MIME_TYPES, ["image/png", "image/jpeg", "image/webp"]);
  });

  it("should have 2 valid input fidelities", () => {
    assert.deepStrictEqual(VALID_INPUT_FIDELITIES, ["high", "low"]);
  });

  it("should have ui-mockup as a built-in style", () => {
    const names = getStyleNames();
    assert.ok(names.length >= 1, `Expected at least 1 style, got ${names.length}`);
    assert.ok(names.includes("ui-mockup"), "Should include ui-mockup style");
  });
});

// ─── Tool Schema & Guidance ───

describe("Tool Schema", async () => {
  const { tools } = await listToolsHandler();
  const tool = tools.find((t) => t.name === "create_image");
  const props = tool.inputSchema.properties;

  it("should expose a single create_image tool", () => {
    assert.strictEqual(tools.length, 1);
    assert.ok(tool);
  });

  it("should guide the agent on model, quality, and size choices", () => {
    for (const phrase of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "quality", "'low'", "'high'", "2048x1152", "3840x2160", "transparent"]) {
      assert.ok(tool.description.includes(phrase), `description missing ${phrase}`);
    }
  });

  it("should keep the trigger phrases", () => {
    for (const phrase of ["create an image", "edit an image", "draw"]) {
      assert.ok(tool.description.includes(phrase), `description missing ${phrase}`);
    }
  });

  it("should default model to the configured model and list both 2.5 models", () => {
    assert.strictEqual(props.model.default, IMAGE_MODEL);
    assert.ok(props.model.enum.includes("gpt-image-2.5-sunburst"));
    assert.ok(props.model.enum.includes("gpt-image-2.5-flare"));
  });

  it("should accept free-form sizes via a pattern with presets as examples", () => {
    assert.strictEqual(props.size.enum, undefined);
    const pattern = new RegExp(props.size.pattern);
    assert.ok(pattern.test("2048x1152"));
    assert.ok(pattern.test("auto"));
    assert.ok(!pattern.test("large"));
    assert.ok(props.size.examples.includes("3840x2160"));
  });

  it("should document every parameter", () => {
    for (const [name, schema] of Object.entries(props)) {
      assert.ok(schema.description && schema.description.length > 20, `${name} needs a description`);
    }
  });

  it("should require only prompt and output_file", () => {
    assert.deepStrictEqual(tool.inputSchema.required, ["prompt", "output_file"]);
  });
});
