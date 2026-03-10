---
description: Research and create a new image generation style preset
argument-hint: <style-name> <description of what the style should achieve>
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(npm test:*)
  - Bash(node --test:*)
  - Bash(ls:*)
  - Bash(mkdir:*)
  - mcp__ask-google__ask_google
  - mcp__create-image__create_image
---

# Create a New Image Style

You are creating a new style preset for the create-image MCP server. A style is a JSON file placed in `create-image-styles/` that guides image generation towards a specific visual style.

## Input

Style name and goal: $ARGUMENTS

Style names must be in kebab-case (e.g., `ui-mockup`, `hand-drawn-sketch`, `pixel-art`). The filename becomes the style name.

## Reference: Existing Style Format

Read the built-in style in `src/styles.js` to understand the JSON structure. Each style has:
- `name`: Human-readable display name
- `description`: What the style achieves (1-2 sentences)
- `systemPrompt`: The prompt text that guides the image model. This is the core of the style.
- `defaults`: Optional parameter defaults (`size`, `quality`, `background`, `output_mime_type`)

Valid sizes: `1024x1024`, `1024x1536`, `1536x1024`, `auto`
Valid qualities: `low`, `medium`, `high`, `auto`
Valid backgrounds: `transparent`, `opaque`, `auto`
Valid output MIME types: `image/png`, `image/jpeg`, `image/webp`

## Process

### Step 1: Research the visual style

Use `mcp__ask-google__ask_google` to research what makes this visual style effective. Ask specifically about:
- What defines this style visually (colors, composition, line work, etc.)
- Best practices for AI image generation in this style
- What to avoid (common failure modes with AI image generators)
- How to describe it in a prompt that GPT Image 1.5 will interpret well

Do 2-3 rounds of research to refine your understanding. Be specific about GPT Image / OpenAI image models when searching.

### Step 2: Draft the system prompt

Write a system prompt following these principles (learned from creating the ui-mockup style):

1. **Lead with the core style directive** — one clear sentence describing what to create
2. **Use structured categories** — break constraints into labeled sections (Color scheme, Typography, Layout, Constraints, etc.)
3. **Be specific about what to include AND what to avoid** — the model needs negative constraints
4. **Use concrete values** — hex colors, specific terms (e.g., "flat vector" not "nice looking")
5. **Keep it focused** — the system prompt should be under 500 words. Shorter is better.
6. **Avoid vague terms** — "beautiful", "nice", "good" mean nothing to the model. Use precise visual language.

### Step 3: Choose sensible defaults

Pick defaults that match the style's typical use case:
- Portrait (`1024x1536`) for tall content like mobile UIs, documents
- Landscape (`1536x1024`) for wide content like headers, diagrams, scenes
- Square (`1024x1024`) for icons, avatars, centered compositions
- Quality should almost always be `high` for styles
- Set `background` and `output_mime_type` only if the style strongly implies them

### Step 4: Generate test images

Use the `mcp__create-image__create_image` tool to generate 2-3 test images with different prompts but the same style. Pass the system prompt via `system_message_file` by writing it to a temp file first.

Test with varied subjects to confirm the style is consistent. For example, if creating a "watercolor" style, test with a landscape, a portrait, and an object.

Evaluate: Is the style consistent across prompts? Is the text legible? Are the constraints respected?

### Step 5: Iterate if needed

If test images don't match expectations, refine the system prompt. Common fixes:
- Add stronger negative constraints if unwanted elements appear
- Be more specific about colors or composition if results are inconsistent
- Simplify if the model seems confused by too many instructions

### Step 6: Save the style

Create the style JSON file at `create-image-styles/<style-name>.json`:

```json
{
  "name": "Display Name",
  "description": "One-line description of what this style achieves.",
  "systemPrompt": "The full system prompt text.",
  "defaults": {
    "size": "1024x1024",
    "quality": "high"
  }
}
```

Ensure the `create-image-styles/` directory exists first.

### Step 7: Verify

Run `npm test` to confirm the style loads correctly (the test suite validates all discoverable styles have the required fields).

Report to the user:
- Style name and file path
- The system prompt (so they can review it)
- Links to the test images generated
- Any defaults that were set and why
