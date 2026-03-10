/**
 * Built-in image generation styles and user-defined style loading.
 *
 * Styles are resolved in this order (later wins):
 * 1. Built-in styles (defined below)
 * 2. User-defined JSON files in <cwd>/create-image-styles/
 *
 * User styles override built-in styles with the same name.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";

const BUILT_IN_STYLES = {
  "ui-mockup": {
    name: "UI Mockup",
    description:
      "Clean, flat-vector Figma-style UI mockup. Grayscale palette with blue (#3B82F6) accent. Ideal for software interface designs, dashboards, and app screens.",
    systemPrompt: [
      "Create a high-fidelity digital UI mockup. Strictly flat vector illustration style, resembling a clean Figma layout.",
      "",
      "Color scheme: Minimalist grayscale palette with a single vibrant blue (#3B82F6) accent color for primary buttons and active states.",
      "Typography: Clean, modern sans-serif font with strict visual hierarchy — distinct headings, body text, and microcopy. All text must be legible and correctly spelled.",
      "Layout: Edge-to-edge interface design. Do not include device frames, bezels, browser chrome, hardware, or environmental backgrounds.",
      "Background: Solid pure white background.",
      "Constraints: Strictly 2D flat design. Avoid 3D elements, gradients, skeuomorphism, photorealism, and heavy drop shadows. Focus on structural alignment, precise padding, and clean negative space.",
    ].join("\n"),
    defaults: {
      size: "1024x1536",
      quality: "high",
      background: "opaque",
      output_mime_type: "image/png",
    },
  },

  "illustration": {
    name: "Illustration",
    description:
      "Modern digital illustration with clean lines and vibrant colors. Good for blog headers, social media, and marketing materials.",
    systemPrompt: [
      "Create a modern digital illustration with clean, confident line work and a vibrant but harmonious color palette.",
      "",
      "Style: Flat illustration with subtle depth cues (soft shadows, layering). No photorealism.",
      "Colors: Bold, saturated palette with good contrast. Limit to 5-7 key colors plus tints.",
      "Composition: Clear focal point with balanced negative space. Suitable for use as a header or hero image.",
      "Constraints: No text overlays, watermarks, or UI elements unless explicitly requested.",
    ].join("\n"),
    defaults: {
      size: "1536x1024",
      quality: "high",
    },
  },

  "icon": {
    name: "Icon",
    description:
      "Clean, minimal icon or symbol design. Flat style with optional subtle gradients. Perfect for app icons, UI icons, and logos.",
    systemPrompt: [
      "Create a clean, minimal icon design centered on the canvas.",
      "",
      "Style: Flat design with optional subtle gradient. Single subject, instantly recognizable at small sizes.",
      "Colors: Limited palette (2-4 colors maximum). High contrast against the background.",
      "Composition: Centered, symmetrical where appropriate. Generous padding around the icon.",
      "Constraints: No text, no fine details that would be lost at small sizes. Simple geometric shapes preferred.",
    ].join("\n"),
    defaults: {
      size: "1024x1024",
      quality: "high",
    },
  },

  "diagram": {
    name: "Diagram",
    description:
      "Technical diagram or flowchart with clear labels and connections. Good for architecture diagrams, flowcharts, and process maps.",
    systemPrompt: [
      "Create a clean technical diagram or flowchart.",
      "",
      "Style: Flat, schematic style with clear visual hierarchy. Use rounded rectangles for nodes, arrows for connections.",
      "Colors: Professional palette — dark gray text, light gray backgrounds, blue (#3B82F6) for primary elements, green for success states, red for error states.",
      "Typography: All labels must be legible, correctly spelled, and horizontally aligned. Use consistent font sizing.",
      "Layout: Left-to-right or top-to-bottom flow. Even spacing between elements. Clear directional arrows.",
      "Background: Solid white background with no grid or texture.",
      "Constraints: Strictly 2D. No 3D perspective, no decorative elements, no icons unless they clarify meaning.",
    ].join("\n"),
    defaults: {
      size: "1536x1024",
      quality: "high",
      background: "opaque",
      output_mime_type: "image/png",
    },
  },

  "photo-realistic": {
    name: "Photo Realistic",
    description:
      "Photorealistic image generation. Best for product mockups, environment concepts, and realistic scene creation.",
    systemPrompt: [
      "Create a photorealistic image with natural lighting and physically accurate materials.",
      "",
      "Style: Photorealistic rendering. Natural color grading, realistic shadows and reflections.",
      "Lighting: Soft, natural lighting unless otherwise specified. Avoid harsh artificial lighting.",
      "Composition: Follow photography best practices — rule of thirds, natural depth of field, appropriate focal length.",
      "Constraints: No text overlays, watermarks, or artificial elements unless explicitly requested.",
    ].join("\n"),
    defaults: {
      quality: "high",
    },
  },
};

const STYLES_DIR = "create-image-styles";

/**
 * Load user-defined styles from the create-image-styles/ directory in CWD.
 * Each .json file becomes a style keyed by its filename (without extension).
 * @returns {object} Map of style name → style definition
 */
function loadUserStyles() {
  const stylesPath = join(process.cwd(), STYLES_DIR);
  if (!existsSync(stylesPath)) return {};

  const userStyles = {};
  let files;
  try {
    files = readdirSync(stylesPath);
  } catch {
    return {};
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const styleName = basename(file, ".json");
    try {
      const content = readFileSync(join(stylesPath, file), "utf-8");
      const style = JSON.parse(content);
      if (style.systemPrompt && typeof style.systemPrompt === "string") {
        userStyles[styleName] = style;
      }
    } catch {
      // Skip malformed style files
    }
  }

  return userStyles;
}

/**
 * Get all styles: built-in merged with user-defined (user wins on conflict).
 * @returns {object} Merged style map
 */
function resolveStyles() {
  const userStyles = loadUserStyles();
  return { ...BUILT_IN_STYLES, ...userStyles };
}

/**
 * Get a style definition by name.
 * User-defined styles take precedence over built-in styles.
 * @param {string} name - Style name (e.g., "ui-mockup")
 * @returns {object|null} Style definition or null if not found
 */
export function getStyle(name) {
  const all = resolveStyles();
  return all[name] || null;
}

/**
 * Get all available style names (built-in + user-defined).
 * @returns {string[]} Array of style names
 */
export function getStyleNames() {
  return Object.keys(resolveStyles());
}

/**
 * Get a brief listing of all styles for display.
 * @returns {Array<{name: string, displayName: string, description: string}>}
 */
export function listStyles() {
  const all = resolveStyles();
  return Object.entries(all).map(([key, style]) => ({
    name: key,
    displayName: style.name || key,
    description: style.description || "",
  }));
}

export { BUILT_IN_STYLES, STYLES_DIR };
