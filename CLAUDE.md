# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server that generates images using OpenAI's GPT Image model (`gpt-image-1.5`). It enables Claude Desktop, Claude Code, and other MCP clients to create images from text descriptions.

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
npm run test:integration     # Integration test with live OpenAI API
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

**Model**: `gpt-image-1.5`
- Supports sizes: 1024x1024, 1024x1536, 1536x1024, auto
- Quality levels: low, medium, high, auto (default: auto)
- Background modes: transparent, opaque, auto
- Output formats: png, jpeg, webp (via output_format parameter)
- Supports n=1-10 images per request (tool limits to 1-4)
- Returns base64-encoded image data (b64_json)
- Supports image input for editing via images.edit endpoint (PNG, JPEG, WebP, GIF; max 20MB)
- OpenAI SDK built-in retries disabled (`maxRetries: 0`); custom retry with exponential backoff (3 retries, retries 429/5xx, skips auth/content_policy errors)

### Tool Parameters

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `prompt` | Yes | string | - | Image description or editing instructions (1-32,000 chars) |
| `output_file` | Yes | string | - | File path to save the generated image |
| `input_images` | No | array | - | File paths to input images for editing |
| `size` | No | enum | 1024x1024 | 1024x1024, 1024x1536, 1536x1024, auto |
| `quality` | No | enum | auto | low, medium, high, auto |
| `background` | No | enum | auto | transparent, opaque, auto |
| `number_of_images` | No | integer | 1 | 1-4 variations |
| `output_mime_type` | No | enum | image/png | image/png, image/jpeg, image/webp |

### Response Format

The tool returns **text-only** MCP content:
- `type: "text"` - File path, size, and mimeType for each saved image
- Multiple images get numbered filenames (e.g., `output_1.png`, `output_2.png`)
- No base64 image data in the response (images are saved to disk only)

## Important Patterns

### Error Handling Strategy

All errors are returned as **tool-level errors** (`isError: true`) with categorized prefixes:
- `[AUTH_ERROR]`: API key / authentication issues (401, 403)
- `[QUOTA_ERROR]`: Rate limits, quota exceeded, or billing errors (402, 429)
- `[TIMEOUT_ERROR]`: Request timeouts (408, ETIMEDOUT)
- `[SAFETY_ERROR]`: Content blocked by safety filters or content policy violations
- `[FILE_ERROR]`: Filesystem errors (EACCES, ENOENT, etc.)
- `[API_ERROR]`: Generic OpenAI API errors (400, 422, 5xx)

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
