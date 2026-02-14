# Changelog

All notable changes to this project will be documented in this file.

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
