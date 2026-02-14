# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server that generates images using Google Gemini's image generation model (`gemini-3-pro-image-preview`). It enables Claude Desktop, Claude Code, and other MCP clients to create images from text descriptions.

**Key Technologies:**
- MCP SDK (`@modelcontextprotocol/sdk`) for stdio server transport and JSON-RPC 2.0 communication
- Google GenAI SDK (`@google/genai`) for Gemini image generation API
- Node.js native test runner for unit/integration testing
- ES modules (`type: "module"` in package.json)

## Development Commands

### Running the Server
```bash
npm start                    # Start MCP server (runs check-env first)
npm run dev                  # Auto-reload mode with --watch flag
```

### Testing
```bash
npm test                     # Unit tests only (test/unit/**/*.test.js)
npm run test:integration     # Integration test with live Gemini API
npm run test:all             # All tests (unit + integration)
```

**Running a single test file:**
```bash
node --test test/unit/tool-handler.test.js
```

### Environment & Security
```bash
npm run check-env            # Validate .env configuration
npm run security:audit       # Check for vulnerabilities
npm run security:fix         # Auto-fix security issues
npm run security:update      # Update deps and audit
```

## Architecture

### MCP Server Design

The server implements a **single-tool MCP server** following the stdio transport pattern:

1. **Server Initialization** (src/index.js)
   - Creates MCP Server instance with name/version metadata
   - Declares `tools` capability
   - Connects to StdioServerTransport for JSON-RPC communication

2. **Tool Registration**
   - Handles `ListToolsRequestSchema` to expose the `create_image` tool
   - Tool description is optimized for AI agent invocation with clear trigger phrases
   - Input schema includes validation rules and examples

3. **Request Handling**
   - Handles `CallToolRequestSchema` for tool execution
   - **Input validation**: null/undefined check → type check → empty string check → length check
   - **Gemini integration**: Uses `@google/genai` SDK with `generateContentStream` for image generation
   - **Response handling**: Collects streamed image parts, saves to disk, returns text-only response with file paths
   - **Error categorization**: Maps Gemini errors to MCP-friendly error codes

4. **Process Stability**
   - Handles unhandled rejections, uncaught exceptions, SIGINT, SIGTERM
   - All failures trigger clean shutdown with error logging to stderr

### Gemini Model Configuration

**Model**: `gemini-3-pro-image-preview`
- Configured with `responseModalities: ["IMAGE", "TEXT"]`
- Supports 10 aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9
- Image sizes: 1K, 2K (default: 2K)
- Uses streaming API (`generateContentStream`) to handle image data
- Supports image input for editing/style transfer (PNG, JPEG, WebP, HEIC; max 20MB)
- Retry with exponential backoff (3 retries, skips auth/quota errors)

### Tool Parameters

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `prompt` | Yes | string | - | Image description or editing instructions (1-10,000 chars) |
| `output_file` | Yes | string | - | File path to save the generated image |
| `input_images` | No | array | - | File paths to input images (max 4) |
| `aspect_ratio` | No | enum | 16:9 | One of 10 valid ratios |
| `image_size` | No | enum | 2K | 1K or 2K |
| `number_of_images` | No | integer | 1 | 1-4 variations |
| `output_mime_type` | No | enum | image/png | image/png or image/jpeg |
| `person_generation` | No | enum | "" | Controls people in generated images |

### Response Format

The tool returns **text-only** MCP content:
- `type: "text"` - File path, size, and mimeType for each saved image
- Multiple images get numbered filenames (e.g., `output_1.png`, `output_2.png`)
- No base64 image data in the response (images are saved to disk only)

## Important Patterns

### Error Handling Strategy

All errors are **categorized by prefix** for MCP client consumption:
- `[AUTH_ERROR]`: API key issues
- `[QUOTA_ERROR]`: Rate limits or quota exceeded
- `[TIMEOUT_ERROR]`: Request timeouts
- `[SAFETY_ERROR]`: Content blocked by safety filters
- `[API_ERROR]`: Generic Gemini API errors

### Package Distribution

**NPM package** (`@gpriday/create-image-mcp`):
- Scoped package requires `--access public` for publishing
- Binary: `create-image-mcp` (defined in package.json bin field)
- Published files: `src/`, `scripts/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `.env.example`
- `package-lock.json` is committed for reproducible builds
- CI/CD should use `npm ci` (not `npm install`)

## Release Process

Use `/release [patch|minor|major]` slash command for automated releases:
- Auto-detects version bump from Conventional Commits if no argument provided
- Validates tests pass, git is clean, NPM authentication
- Updates package.json version
- Creates git commit, tag, publishes to NPM, pushes to origin
