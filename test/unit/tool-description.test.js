import { describe, it } from "node:test";
import assert from "node:assert";
import {
  VALID_SIZES,
  VALID_QUALITIES,
  VALID_BACKGROUNDS,
  VALID_OUTPUT_MIME_TYPES,
  VALID_INPUT_FIDELITIES,
  getStyleNames,
} from "../../src/index.js";

// Import the tool definition from the live server by issuing a tools/list request
// Since we can't easily call the MCP handler directly (it needs a running server),
// we import the constants and validate them against expected values.
// The integration test validates the full schema via tools/list.

// ─── Exported Constants Tests ───

describe("Exported Constants", () => {
  it("should have 4 valid sizes", () => {
    assert.deepStrictEqual(VALID_SIZES, ["1024x1024", "1024x1536", "1536x1024", "auto"]);
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

  it("should have at least 5 built-in styles", () => {
    const names = getStyleNames();
    assert.ok(names.length >= 5, `Expected at least 5 styles, got ${names.length}`);
    assert.ok(names.includes("ui-mockup"), "Should include ui-mockup style");
    assert.ok(names.includes("illustration"), "Should include illustration style");
    assert.ok(names.includes("diagram"), "Should include diagram style");
  });
});
