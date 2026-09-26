# Create Image MCP Server

A Model Context Protocol (MCP) server that generates and edits images using OpenAI's GPT Image 2.5 models (`gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`). This server enables Claude Desktop, Claude Code, and other MCP clients to create images from text descriptions and edit existing images.

## Features

- Text-to-image generation via OpenAI GPT Image 2.5 (precision `sunburst` or fast `flare` model)
- Image editing and style transfer with input image support
- Custom sizes up to 4K (3840x2160), plus quality, compression, and output format controls
- Transparent background support
- Multiple image variations in a single request
- Images saved to disk with text-only responses (no base64 bloat)
- Retry with exponential backoff for transient failures

## Prerequisites

- Node.js >= 22.0.0
- OpenAI API Key

## Installation

### Option 1: NPM Global Install (Recommended)

```bash
npm install -g @gpriday/create-image-mcp
```

The `create-image-mcp` command will be available globally.

### Option 2: Local Development Install

```bash
git clone https://github.com/gregpriday/create-image-mcp.git
cd create-image-mcp
npm install
```

### Configuration

Create a `.env` file in your project root or home directory (`~/.env`):

```bash
OPENAI_API_KEY=your_api_key_here
```

You can get an OpenAI API key from [OpenAI Platform](https://platform.openai.com/api-keys).

**For local development**, validate your configuration with:
```bash
npm run check-env
```

The server resolves settings in this order:
1. Environment variables (including the `env` block of your MCP client config)
2. `.env` in the server's working directory
3. `~/.env`

Only `OPENAI_API_KEY` and `OPENAI_IMAGE_MODEL` are read from `.env` files. Other variables such as `OPENAI_BASE_URL` are ignored there, so a project's `.env` can't redirect your key to another server.

Optionally set `OPENAI_IMAGE_MODEL` to change the default model (defaults to `gpt-image-2.5-sunburst`), for example to pin a dated snapshot such as `gpt-image-2.5-sunburst-2026-09-08`.

## Usage

### Run the MCP Server

**If installed globally:**
```bash
create-image-mcp
```

**If running locally:**
```bash
node src/index.js
```

The server runs on stdio and communicates via JSON-RPC 2.0. In MCP client configs, launch `create-image-mcp` or `node /path/to/src/index.js` directly rather than `npm start`, since npm prints its own output to stdout.

### Test the Server

```bash
npm test                     # Unit tests
npm run test:integration     # MCP protocol test over stdio (no API calls)
CREATE_IMAGE_LIVE_TEST=1 npm run test:integration   # Also generates one real image (costs a few cents)
npm run test:all             # All tests
```

### Available Tools

#### create_image

Generate or edit images using OpenAI GPT Image.

**Use when:** user says "create an image", "generate a picture", "draw", "make an illustration", "edit an image", "transform a photo", or any visual content creation request.

**Parameters:**

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `prompt` | Yes | string | - | Image description or editing instructions (1-32,000 chars) |
| `output_file` | Yes | string | - | File path to save the generated image (absolute recommended; `~/` is expanded) |
| `model` | No | enum | `gpt-image-2.5-sunburst` | `gpt-image-2.5-sunburst` (precision) or `gpt-image-2.5-flare` (faster, for drafts) |
| `style` | No | enum | - | Style preset (built-in: `ui-mockup`; add your own in `create-image-styles/`) |
| `input_images` | No | array | - | File paths to input images for editing (PNG/JPEG/WebP, up to 16 images, max 20MB each) |
| `size` | No | string | `1024x1024` | `auto` or `WIDTHxHEIGHT`, e.g. `1536x1024`, `2048x1152`, `3840x2160` (see size rules below) |
| `quality` | No | enum | `auto` | `low`, `medium`, `high`, `auto` |
| `background` | No | enum | `auto` | `transparent`, `opaque`, `auto` |
| `number_of_images` | No | integer | `1` | Number of variations (1-4) |
| `output_mime_type` | No | enum | from extension, else `image/png` | `image/png`, `image/jpeg`, `image/webp` |
| `output_compression` | No | integer | - | 0-100 compression for JPEG/WebP output |
| `moderation` | No | enum | `auto` | `auto` or `low` (less restrictive filtering) |
| `system_message_file` | No | string | - | Text file prepended to the prompt (max 4,000 chars), for brand or style rules |
| `mask` | No | string | - | PNG with alpha channel marking the area to edit (requires `input_images`) |
| `input_fidelity` | No | enum | - | `high` or `low`: how closely edits preserve the input (requires `input_images`) |

**Size rules:** both edges must be multiples of 16, the longest edge at most 3840px, the aspect ratio at most 3:1, and the total between 655,360 and 8,294,400 pixels (1024x640 up to 3840x2160). Larger sizes cost more and take longer.

**Paths and formats:** relative paths resolve against the server's working directory, which for Claude Desktop is usually not your project, so prefer absolute paths. The output format follows the `output_file` extension (`.png`, `.jpg`/`.jpeg`, `.webp`). If you set `output_mime_type` explicitly, the extension is corrected to match, and the response always reports the absolute path that was written.

**Examples:**

Generate a simple image:
```json
{
  "name": "create_image",
  "arguments": {
    "prompt": "A serene mountain landscape at sunset with golden light",
    "output_file": "./landscape.png"
  }
}
```

Generate with specific settings:
```json
{
  "name": "create_image",
  "arguments": {
    "prompt": "A futuristic city skyline with flying cars, cyberpunk style",
    "output_file": "./cyberpunk-city.png",
    "size": "1536x1024",
    "quality": "high",
    "number_of_images": 2
  }
}
```

Generate with transparent background:
```json
{
  "name": "create_image",
  "arguments": {
    "prompt": "A minimalist flat vector logo of an owl",
    "output_file": "./logo.png",
    "background": "transparent"
  }
}
```

Edit an existing image:
```json
{
  "name": "create_image",
  "arguments": {
    "prompt": "Change the background to a beach scene",
    "input_images": ["./photo.jpg"],
    "output_file": "./edited-photo.png"
  }
}
```

Style transfer:
```json
{
  "name": "create_image",
  "arguments": {
    "prompt": "Make this image look like a watercolor painting",
    "input_images": ["./source.png"],
    "output_file": "./watercolor.png"
  }
}
```

**Response Format:**

The tool saves images to disk and returns a text-only response:
```
Image saved to: /Users/you/project/landscape.png (245.3 KB, image/png)
```

For multiple images, files are numbered:
```
Image saved to: /Users/you/project/cyberpunk-city_1.png (312.1 KB, image/png)
Image saved to: /Users/you/project/cyberpunk-city_2.png (298.7 KB, image/png)
```

## Integration with Claude Desktop

Add this server to your Claude Desktop configuration.

### If Installed Globally (Recommended)

#### macOS
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "create-image": {
      "command": "create-image-mcp",
      "env": {
        "OPENAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

#### Windows
Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "create-image": {
      "command": "create-image-mcp",
      "env": {
        "OPENAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

#### Linux
Edit `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "create-image": {
      "command": "create-image-mcp",
      "env": {
        "OPENAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### If Running Locally

#### macOS
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "create-image": {
      "command": "node",
      "args": ["/path/to/create-image-mcp/src/index.js"],
      "env": {
        "OPENAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

#### Windows
Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "create-image": {
      "command": "node",
      "args": ["C:\\path\\to\\create-image-mcp\\src\\index.js"],
      "env": {
        "OPENAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

#### Linux
Edit `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "create-image": {
      "command": "node",
      "args": ["/path/to/create-image-mcp/src/index.js"],
      "env": {
        "OPENAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**After updating the configuration, restart Claude Desktop.**

## Integration with Claude Code

### Option 1: Project-Level `.mcp.json` (Recommended)

Add a `.mcp.json` file to your project root. This is the simplest approach and works automatically when Claude Code opens the project.

> **Note:** If `OPENAI_API_KEY` is already set in your shell environment (e.g. in `~/.zshrc`, `~/.bashrc`, or `~/.env`), omit the `env` field entirely. That's the safer choice for a checked-in `.mcp.json`: never commit a real API key. Claude Code also expands `${OPENAI_API_KEY}` in the `env` block.

**If installed globally:**
```json
{
  "mcpServers": {
    "create-image": {
      "command": "create-image-mcp",
      "env": {
        "OPENAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**If running locally:**
```json
{
  "mcpServers": {
    "create-image": {
      "command": "node",
      "args": ["/path/to/create-image-mcp/src/index.js"],
      "env": {
        "OPENAI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Option 2: CLI Command

**For current project only:**
```bash
claude mcp add --scope project create-image -e OPENAI_API_KEY=your_api_key_here -- create-image-mcp
```

**For your user (available in all projects):**
```bash
claude mcp add --scope user create-image -e OPENAI_API_KEY=your_api_key_here -- create-image-mcp
```

**Verify the server is running:**
```bash
claude mcp list
```

## Integration with OpenAI Codex

Add the MCP server using the `codex mcp add` command or by editing `~/.codex/config.toml`.

### Using CLI (Recommended)

**If installed globally:**
```bash
codex mcp add create-image --env OPENAI_API_KEY=your_api_key_here -- create-image-mcp
```

**If running locally:**
```bash
codex mcp add create-image --env OPENAI_API_KEY=your_api_key_here -- node /path/to/create-image-mcp/src/index.js
```

### Manual Configuration

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.create-image]
command = "create-image-mcp"
env = { OPENAI_API_KEY = "your_api_key_here" }
```

## Development

### Dependency Management

- **Semver Ranges**: Dependencies use caret (`^`) ranges for automatic patch/minor security updates
- **Lockfile**: `package-lock.json` is committed for reproducible builds
- **CI/CD**: Use `npm ci` (not `npm install`) to enforce lockfile versions
- **Security**: Run `npm run security:audit` regularly

### Project Structure

```
create-image-mcp/
├── src/
│   ├── index.js               # Main MCP server
│   └── styles.js              # Built-in and user style presets
├── scripts/
│   └── check-env.js           # Environment validation
├── test/
│   ├── unit/
│   │   ├── tool-handler.test.js    # Unit tests
│   │   └── tool-description.test.js # Schema tests
│   └── test-create-image-mcp.js    # Integration tests
├── package.json
├── package-lock.json          # Committed for reproducibility
├── .env                       # API key (git-ignored)
├── .env.example               # API key template
├── .gitignore
├── LICENSE
└── README.md
```

### Scripts

**Development:**
- `npm start` - Start the MCP server (auto-runs environment validation)
- `npm test` - Run unit tests
- `npm run test:integration` - Run the MCP protocol test (set `CREATE_IMAGE_LIVE_TEST=1` for a live generation)
- `npm run test:all` - Run all tests
- `npm run dev` - Run server with auto-reload

**Environment & Security:**
- `npm run check-env` - Validate environment configuration
- `npm run security:audit` - Check for security vulnerabilities
- `npm run security:fix` - Auto-fix security issues
- `npm run security:update` - Update dependencies and audit

## Error Handling

The server provides categorized error handling:

- **Input Validation**: Parameters validated for presence, type, length, and enum membership
- **[AUTH_ERROR]**: Missing or invalid API keys
- **[QUOTA_ERROR]**: API quota, rate limit, or billing errors
- **[TIMEOUT_ERROR]**: Request timeout errors
- **[SAFETY_ERROR]**: Content blocked by safety filters or content policy violations
- **[FILE_ERROR]**: Missing, unreadable, or unsupported input images, masks, or output paths (input types are checked from file contents)
- **[NO_IMAGE]**: The API returned no image
- **[CANCELLED]**: The client cancelled the call; no files are written
- **[API_ERROR]**: General API errors
- **Retry Logic**: Rate limits (429), 408/409, server errors (5xx), and dropped connections are retried up to 3 times with exponential backoff, honoring `Retry-After`. Auth, validation, safety, exhausted-quota, and timeout errors are not retried. Each attempt times out after 5 minutes.
- **Process Stability**: Unhandled rejections and exceptions trigger clean shutdown

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

For issues or questions:
1. Check the [MCP documentation](https://modelcontextprotocol.io)
2. Review [OpenAI API docs](https://platform.openai.com/docs/api-reference/images)
3. Open an issue in this repository
