# Create Image MCP Server

A Model Context Protocol (MCP) server that generates and edits images using Google Gemini's image generation model (`gemini-3-pro-image-preview`). This server enables Claude Desktop, Claude Code, and other MCP clients to create images from text descriptions and edit existing images.

## Features

- Text-to-image generation via Gemini image model
- Image editing and style transfer with input image support
- Configurable aspect ratios, resolution, and output format
- Multiple image variations in a single request
- Images saved to disk with text-only responses (no base64 bloat)
- Retry with exponential backoff for transient failures

## Prerequisites

- Node.js >= 20.0.0
- Google API Key with Gemini API access

## Installation

### Option 1: NPM Global Install (Recommended)

```bash
npm install -g @gpriday/create-image-mcp
```

The `create-image-mcp` command will be available globally.

### Option 2: Local Development Install

```bash
git clone https://github.com/gpriday/create-image-mcp.git
cd create-image-mcp
npm install
```

### Configuration

Create a `.env` file in your project root or home directory (`~/.env`):

```bash
GOOGLE_API_KEY=your_api_key_here
```

You can get a Google API key from [Google AI Studio](https://aistudio.google.com/apikey).

**For local development**, validate your configuration with:
```bash
npm run check-env
```

The server will automatically load `.env` from:
1. Current working directory (`.env`)
2. Home directory (`~/.env`) as fallback
3. Or use environment variables directly

## Usage

### Run the MCP Server

**If installed globally:**
```bash
create-image-mcp
```

**If running locally:**
```bash
npm start
```

The server runs on stdio and communicates via JSON-RPC 2.0.

### Test the Server

```bash
npm test                     # Unit tests
npm run test:integration     # Integration test with live API
npm run test:all             # All tests
```

### Available Tools

#### create_image

Generate or edit images using Google Gemini.

**Use when:** user says "create an image", "generate a picture", "draw", "make an illustration", "edit an image", "transform a photo", or any visual content creation request.

**Parameters:**

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `prompt` | Yes | string | - | Image description or editing instructions (1-10,000 chars) |
| `output_file` | Yes | string | - | File path to save the generated image |
| `input_images` | No | array | - | File paths to input images for editing (max 4, supports PNG/JPEG/WebP/HEIC, max 20MB each) |
| `aspect_ratio` | No | enum | `16:9` | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `5:4`, `4:5`, `21:9` |
| `image_size` | No | enum | `2K` | `1K` or `2K` |
| `number_of_images` | No | integer | `1` | Number of variations (1-4) |
| `output_mime_type` | No | enum | `image/png` | `image/png` or `image/jpeg` |
| `person_generation` | No | enum | `""` | `""` (default), `DONT_ALLOW`, `ALLOW_ADULT`, `ALLOW_ALL` |

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
    "aspect_ratio": "21:9",
    "image_size": "2K",
    "number_of_images": 2
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
Image saved to: ./landscape.png (245.3 KB, image/png)
```

For multiple images, files are numbered:
```
Image saved to: ./cyberpunk-city_1.png (312.1 KB, image/png)
Image saved to: ./cyberpunk-city_2.png (298.7 KB, image/png)
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
        "GOOGLE_API_KEY": "your_api_key_here"
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
        "GOOGLE_API_KEY": "your_api_key_here"
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
        "GOOGLE_API_KEY": "your_api_key_here"
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
        "GOOGLE_API_KEY": "your_api_key_here"
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
        "GOOGLE_API_KEY": "your_api_key_here"
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
        "GOOGLE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**After updating the configuration, restart Claude Desktop.**

## Integration with Claude Code

Add the MCP server using the `claude mcp add` command.

### If Installed Globally (Recommended)

**For current project only:**
```bash
claude mcp add --scope project create-image -e GOOGLE_API_KEY=your_api_key_here -- create-image-mcp
```

**For your user (available in all projects):**
```bash
claude mcp add --scope user create-image -e GOOGLE_API_KEY=your_api_key_here -- create-image-mcp
```

### If Running Locally

```bash
claude mcp add --scope project create-image -e GOOGLE_API_KEY=your_api_key_here -- node /path/to/create-image-mcp/src/index.js
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
codex mcp add create-image --env GOOGLE_API_KEY=your_api_key_here -- create-image-mcp
```

**If running locally:**
```bash
codex mcp add create-image --env GOOGLE_API_KEY=your_api_key_here -- node /path/to/create-image-mcp/src/index.js
```

### Manual Configuration

Edit `~/.codex/config.toml`:

```toml
[mcp.create-image]
command = "create-image-mcp"
env = ["GOOGLE_API_KEY=your_api_key_here"]
```

## Development

### Dependency Management

- **Semver Ranges**: Dependencies use caret (`^`) ranges for automatic patch/minor security updates
- **Lockfile**: `package-lock.json` is committed for reproducible builds
- **CI/CD**: Use `npm ci` (not `npm install`) to enforce lockfile versions
- **Security**: Run `npm run security:audit` regularly

### Project Structure

```
create-image/
├── src/
│   └── index.js               # Main MCP server
├── scripts/
│   └── check-env.js           # Environment validation
├── test/
│   ├── unit/
│   │   ├── tool-handler.test.js    # Unit tests (93 tests)
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
- `npm run test:integration` - Run integration tests
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
- **[QUOTA_ERROR]**: API quota or rate limit exceeded
- **[TIMEOUT_ERROR]**: Request timeout errors
- **[SAFETY_ERROR]**: Content blocked by safety filters
- **[API_ERROR]**: General API errors
- **Retry Logic**: Transient failures retried with exponential backoff (up to 3 attempts)
- **Process Stability**: Unhandled rejections and exceptions trigger clean shutdown

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

For issues or questions:
1. Check the [MCP documentation](https://modelcontextprotocol.io)
2. Review [Google Gemini API docs](https://ai.google.dev/docs)
3. Open an issue in this repository
