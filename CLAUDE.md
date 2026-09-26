# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server that generates and edits images using OpenAI's GPT Image 2.5 models (`gpt-image-2.5-sunburst` default, `gpt-image-2.5-flare` fast). It enables Claude Desktop, Claude Code, and other MCP clients to create images from text descriptions.

**Key Technologies:**
- MCP SDK (`@modelcontextprotocol/sdk`) for stdio server transport and JSON-RPC 2.0 communication
- OpenAI SDK (`openai`) for GPT Image generation API
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
npm run test:integration     # MCP stdio protocol test (add CREATE_IMAGE_LIVE_TEST=1 for a paid live generation)
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

3. **Request Handling** (via exported `handleCreateImage` function)
   - **Input validation**: null/undefined check → type check → empty string check → length check → cross-field check
   - **Error protocol**: Validation and API errors return `{ isError: true }` tool results (not protocol-level errors)
   - **OpenAI integration**: Uses `openai` SDK with `images.generate` for text-to-image and `images.edit` for image editing
   - **Response handling**: Decodes base64 image data, saves to disk, returns text-only response with file paths
   - **Error categorization**: Uses HTTP status codes first, then message-based fallback. Separates filesystem, auth, quota, timeout, safety, and API errors

4. **Process Stability**
   - Handles unhandled rejections, uncaught exceptions, SIGINT, SIGTERM
   - All failures trigger clean shutdown with error logging to stderr

### OpenAI Model Configuration

**Models**: `gpt-image-2.5-sunburst` (default, precision) and `gpt-image-2.5-flare` (fast), selectable per call via `model`; `OPENAI_IMAGE_MODEL` changes the default. `gpt-image-1.5` is deprecated (shutdown 2026-12-01).
- Sizes: `auto` or any WxH with edges divisible by 16, longest edge <= 3840, aspect <= 3:1, 655,360-8,294,400 total pixels (validated locally by `validateSize`)
- Moderation: auto, low. Output compression: 0-100 (JPEG/WebP only)
- Quality levels: low, medium, high, auto (default: auto)
- Background modes: transparent, opaque, auto
- Output formats: png, jpeg, webp (via output_format parameter)
- Supports n=1-10 images per request (tool limits to 1-4)
- Returns base64-encoded image data (b64_json)
- Supports image input for editing via images.edit endpoint (PNG, JPEG, WebP; GIF is rejected by the API; up to 16 images, max 20MB each; mask must be PNG)
- OpenAI SDK built-in retries disabled (`maxRetries: 0`); `retryWithBackoff` retries 408/409/429/5xx and `APIConnectionError` up to 3 times with jittered backoff and `Retry-After`; never retries `insufficient_quota`, safety codes, aborts, or timeouts. 5-minute per-attempt timeout; the MCP request's abort signal is passed through.
- `.env` loading lives in `src/env.js` (shared with `scripts/check-env.js`): only `OPENAI_API_KEY` and `OPENAI_IMAGE_MODEL` are taken from `<cwd>/.env` and `~/.env`, and real env vars win. Nothing may write to stdout except the MCP transport (SDK logs are routed to stderr).

### Tool Parameters

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `prompt` | Yes | string | - | Image description or editing instructions (1-32,000 chars) |
| `output_file` | Yes | string | - | File path to save the generated image |
| `model` | No | enum | gpt-image-2.5-sunburst | gpt-image-2.5-sunburst, gpt-image-2.5-flare |
| `style` | No | enum | - | Style preset (built-in: ui-mockup; user styles via create-image-styles/) |
| `input_images` | No | array | - | File paths to input images for editing |
| `size` | No | string | 1024x1024 | auto or WxH within the limits above |
| `quality` | No | enum | auto | low, medium, high, auto |
| `background` | No | enum | auto | transparent, opaque, auto |
| `number_of_images` | No | integer | 1 | 1-4 variations |
| `output_mime_type` | No | enum | from output_file ext, else image/png | image/png, image/jpeg, image/webp (explicit value corrects the file extension) |
| `output_compression` | No | integer | - | 0-100, JPEG/WebP only |
| `moderation` | No | enum | - | auto, low |
| `system_message_file` | No | string | - | Text prepended to the prompt (max 4000 chars) |
| `mask` | No | string | - | PNG mask for inpainting (requires input_images) |
| `input_fidelity` | No | enum | - | high, low (edit endpoint only) |

### Response Format

The tool returns **text-only** MCP content:
- `type: "text"` - Absolute file path, size, and mimeType for each saved image (paths are `~`-expanded and resolved against the server CWD)
- Multiple images get numbered filenames (e.g., `output_1.png`, `output_2.png`)
- No base64 image data in the response (images are saved to disk only)

## Important Patterns

### Error Handling Strategy

All errors are returned as **tool-level errors** (`isError: true`) with categorized prefixes:
- `[AUTH_ERROR]`: API key / authentication issues (401, 403)
- `[QUOTA_ERROR]`: Rate limits, quota exceeded, or billing errors (402, 429)
- `[TIMEOUT_ERROR]`: Request timeouts (408, `APIConnectionTimeoutError`, ETIMEDOUT)
- `[SAFETY_ERROR]`: Content blocked by safety filters or content policy violations
- `[FILE_ERROR]`: Filesystem errors (EACCES, ENOENT, EROFS, etc.) and unsupported input files (types are detected from file bytes)
- `[NO_IMAGE]`: API returned no images
- `[CANCELLED]`: Request aborted by the client
- `[API_ERROR]`: Generic OpenAI API errors (400, 422, 5xx) and undecodable image data

### Package Distribution

**NPM package** (`@gpriday/create-image-mcp`):
- Scoped package requires `--access public` for publishing
- Binary: `create-image-mcp` (defined in package.json bin field)
- Published files: `src/`, `scripts/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `.env.example`
- `package-lock.json` is committed for reproducible builds
- CI/CD should use `npm ci` (not `npm install`)

## Release Process

Use `/release [patch|minor|major]` slash command for releases:
- Auto-detects version bump from Conventional Commits if no argument provided
- Validates tests pass and git is clean on `main`
- Bumps the version with `npm version --no-git-tag-version` (package.json and package-lock.json) and dates the CHANGELOG
- Commits, tags `vX.Y.Z`, and pushes; GitHub Actions (`publish.yml`) checks the tag matches package.json and publishes to NPM
