# mcp-dependency-explorer

MCP (Model Context Protocol) server that provides intelligent access to your project's installed dependencies - explore documentation and source code directly from `node_modules`.

## Features

- **List Modules**: Discover all installed npm packages across your project, including monorepo workspaces
- **Search**: Regex-powered search through module source files (.ts, .tsx, .jsx, .d.ts, .css, .md, etc.)
- **Read Files**: Read module files with optional line range support
- **TypeScript Symbols**: List and inspect functions, classes, interfaces, types, enums, and variables
- **Workspace Support**: Automatically detects and scans monorepo structures (pnpm, yarn workspaces)

## Installation

### Via npm (Recommended)

```bash
npm install -g @kozer/mcp-dependency-explorer
```

### From Source

```bash
git clone https://github.com/kozer/mcp-dependency-explorer.git
cd mcp-dependency-explorer
pnpm install
pnpm build
```

## Usage

### As MCP Server

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "dependency-explorer": {
      "command": "mcp-dependency-explorer"
    }
  }
}
```

Or if installed from source:

```json
{
  "mcpServers": {
    "dependency-explorer": {
      "command": "node",
      "args": ["/path/to/mcp-dependency-explorer/dist/server.js"]
    }
  }
}
```

### Available Tools

#### 1. `list_modules`

List all installed Node modules from all `node_modules` directories.

**Parameters:**
- `root` (optional): Project root directory (defaults to cwd)
- `filter` (optional): Filter by module name substring

**Example:**
```typescript
// List all modules
list_modules()

// Filter by name
list_modules({ filter: "react" })
```

#### 2. `search`

Search for patterns in module files with code snippets.

**Parameters:**
- `module`: Module name (exact or substring match)
- `pattern`: Regex pattern to search
- `flags` (optional): Regex flags (e.g., 'i' for case-insensitive)
- `context` (optional): Lines of context around match (default: 5)
- `limit` (optional): Max results (default: 20, max: 100)
- `root` (optional): Project root directory

**Example:**
```typescript
// Search for useState in React
search({
  module: "react",
  pattern: "function useState",
  flags: "i",
  context: 10
})
```

#### 3. `read_file`

Read a file from a module with optional line range.

**Parameters:**
- `module`: Module name
- `file`: File path relative to module root
- `startLine` (optional): Start line (1-based)
- `count` (optional): Number of lines to read (max: 2000)
- `root` (optional): Project root directory

**Example:**
```typescript
read_file({
  module: "fastify",
  file: "fastify.d.ts",
  startLine: 100,
  count: 50
})
```

#### 4. `list_symbols`

List TypeScript symbols (functions, classes, interfaces, etc.) from a module.

**Parameters:**
- `module`: Module name
- `kind` (optional): Filter by symbol type (`function`, `class`, `interface`, `type`, `enum`, `namespace`, `variable`)
- `name` (optional): Filter by symbol name (substring)
- `limit` (optional): Max results (default: 100, max: 500)
- `root` (optional): Project root directory

**Example:**
```typescript
// List all symbols
list_symbols({ module: "fastify" })

// List only interfaces
list_symbols({ module: "fastify", kind: "interface" })

// Search for specific symbol name
list_symbols({ module: "fastify", name: "Request" })
```

#### 5. `get_symbol`

Get the full code for a specific symbol with context.

**Parameters:**
- `module`: Module name
- `file`: File path relative to module root
- `name`: Symbol name
- `padding` (optional): Lines of padding around symbol (default: 10)
- `root` (optional): Project root directory

**Example:**
```typescript
get_symbol({
  module: "fastify",
  file: "types/instance.d.ts",
  name: "FastifyInstance",
  padding: 15
})
```

## How It Works

1. **Project Detection**: Automatically finds your project root by looking for `package.json` and `node_modules`
2. **Workspace Scanning**: Detects monorepos (pnpm-workspace.yaml, yarn workspaces) and scans all workspace packages
3. **TypeScript Analysis**: Uses TypeScript compiler API to extract symbols with accurate type information
4. **Intelligent Caching**: Caches symbol indexes for fast repeated queries

## Supported File Types

- TypeScript: `.ts`, `.tsx`, `.d.ts`
- JavaScript: `.jsx`
- Styles: `.css`, `.scss`, `.sass`, `.less`
- Documentation: `.md`, `README.md`

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run server
pnpm start
```

## Requirements

- Node.js 18+
- TypeScript 5+
- Project with `node_modules` directory

## License

MIT
