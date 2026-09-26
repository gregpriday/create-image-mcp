# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- **Breaking:** default model is now `gpt-image-2.5-sunburst`; `gpt-image-1.5` is deprecated by OpenAI and shuts down 2026-12-01
- **Breaking:** requires Node.js 22+ (Node 20 is end-of-life; `openai` SDK upgraded from v4 to v7)
- `size` accepts any valid `WIDTHxHEIGHT` up to 3840x2160 instead of four fixed values, validated locally against the API's limits
- GIF input images are rejected up front (the edit endpoint does not accept them)

### Added
- `model` parameter to choose `gpt-image-2.5-sunburst` (precision) or `gpt-image-2.5-flare` (fast)
- `output_compression` (0-100, JPEG/WebP) and `moderation` (`auto`/`low`) parameters
- Validation for up to 16 input images and PNG-only masks
- Tool annotations (`destructiveHint`, `openWorldHint`, etc.) and a settings guide in the tool description
- Responses report the model, size, quality, and output tokens the API actually used
- Cancelling a tool call aborts the OpenAI request and writes nothing
- Output format is inferred from the `output_file` extension (`.jpg`/`.jpeg`, `.webp`, `.png`)
- `~/` expansion for all file path parameters; responses report absolute paths
- `OPENAI_IMAGE_MODEL` environment variable to override the image model
- `number_of_images` accepts numeric strings from clients that stringify numbers

### Fixed
- Explicit `output_mime_type` no longer writes JPEG/WebP bytes into a `.png` file; the extension is corrected
- A missing `mask` file fails immediately instead of being retried with backoff
- `mask` without `input_images` returns an error instead of being silently ignored
- OpenAI `moderation_blocked` errors are reported as `[SAFETY_ERROR]`
- Transitive dependency vulnerabilities resolved via `npm audit fix`
- **Security:** `.env` files can only set `OPENAI_API_KEY` and `OPENAI_IMAGE_MODEL`, so a project `.env` can no longer redirect requests (and the key) via `OPENAI_BASE_URL`
- SDK logging goes to stderr, so `OPENAI_LOG` can't corrupt the MCP stdio stream
- Retries no longer repeat exhausted-quota, cancelled, or programming errors; 408/409 are retried and `Retry-After` is honored; each attempt times out after 5 minutes
- Input images and masks are checked by file contents, not extension
- Unknown parameters, `input_fidelity` without `input_images`, and prompts that exceed 32,000 characters once a style is added are rejected
- Empty or undecodable API responses are errors; partial write failures report the files already saved
- Style names like `constructor` no longer resolve to built-in object properties
- `check-env` resolves configuration the same way the server does
- Integration test only makes paid API calls when `CREATE_IMAGE_LIVE_TEST=1`, and fails on non-JSON stdout

## [0.2.0] - 2026-03-10

### Changed
- Migrated from Gemini to OpenAI `gpt-image-1.5` (sizes, quality, background, WebP output)

### Added
- `mask` and `input_fidelity` parameters for image editing
- `system_message_file` parameter for persistent prompt preambles
- Style presets (`ui-mockup` built in, user styles from `create-image-styles/`)

## [0.1.0] - 2026-02-14

### Added
- Initial release of Create Image MCP server
- Text-to-image generation using Gemini `gemini-3-pro-image-preview` model
- Image editing and style transfer via `input_images` parameter
- 10 aspect ratio options (1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9)
- Configurable image resolution (1K, 2K)
- Multiple image variations (1-4 per request)
- Output format selection (PNG, JPEG)
- Person generation controls
- Images saved to disk with text-only MCP responses
- Retry with exponential backoff for transient failures
- Comprehensive unit tests (93 tests) and integration test
- Claude Desktop, Claude Code, and OpenAI Codex integration guides
