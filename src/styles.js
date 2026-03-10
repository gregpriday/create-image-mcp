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
