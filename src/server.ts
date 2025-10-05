#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fg from "fast-glob";
import fs from "fs";
import path from "path";
import ts from "typescript";
import os from "os";

function findProjectRoot(start: string): string {
  let cur = start;
  while (true) {
    if (
      fs.existsSync(path.join(cur, "package.json")) &&
      (fs.existsSync(path.join(cur, "node_modules")) ||
        fs.existsSync(path.join(cur, "pnpm-workspace.yaml")) ||
        fs.existsSync(path.join(cur, "yarn.lock")))
    ) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}

function readJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

type Module = { name: string; version: string; dir: string };

function getAllNodeModulesDirs(root: string): string[] {
  const dirs = new Set<string>();

  dirs.add(path.join(root, "node_modules"));

  const pnpmWs = path.join(root, "pnpm-workspace.yaml");
  const rootPkg = readJson(path.join(root, "package.json"));

  if (fs.existsSync(pnpmWs) || rootPkg?.workspaces) {
    const packages = fg.sync(
      ["packages/*/node_modules", "apps/*/node_modules", "*/node_modules"],
      {
        cwd: root,
        onlyDirectories: true,
        unique: true,
        dot: false,
        ignore: ["**/node_modules/**/node_modules"],
      },
    );
    packages.forEach((p) => dirs.add(path.join(root, p)));
  }

  return Array.from(dirs).filter((d) => fs.existsSync(d));
}

function scanAllModules(root: string, filter?: string): Module[] {
  const modules = new Map<string, Module>();
  const nmDirs = getAllNodeModulesDirs(root);

  for (const nmDir of nmDirs) {
    if (!fs.existsSync(nmDir)) continue;

    for (const entry of fs.readdirSync(nmDir)) {
      if (entry.startsWith(".")) continue;

      const entryPath = path.join(nmDir, entry);

      if (entry.startsWith("@")) {
        if (!fs.existsSync(entryPath)) continue;
        for (const sub of fs.readdirSync(entryPath)) {
          const subPath = path.join(entryPath, sub);
          const pkgJson = path.join(subPath, "package.json");
          if (fs.existsSync(pkgJson)) {
            const pkg = readJson(pkgJson);
            const name = pkg?.name || `${entry}/${sub}`;
            if (!modules.has(name)) {
              modules.set(name, {
                name,
                version: pkg?.version || "unknown",
                dir: subPath,
              });
            }
          }
        }
        continue;
      }

      const pkgJson = path.join(entryPath, "package.json");
      if (fs.existsSync(pkgJson)) {
        const pkg = readJson(pkgJson);
        const name = pkg?.name || entry;
        if (!modules.has(name)) {
          modules.set(name, {
            name,
            version: pkg?.version || "unknown",
            dir: entryPath,
          });
        }
      }
    }
  }

  const list = Array.from(modules.values());
  return filter ? list.filter((m) => m.name.includes(filter)) : list;
}

function findModule(name: string, root: string): Module | null {
  const all = scanAllModules(root);
  return all.find((m) => m.name === name) || all.find((m) => m.name.includes(name)) || null;
}

type SymKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "variable";

type Symbol = {
  kind: SymKind;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  signature?: string;
};

const symbolCache = new Map<string, Symbol[]>();

const DOCS_CACHE_DIR = path.join(os.tmpdir(), "mcp-node-modules-docs");
const docsCache = new Map<string, string[]>();

function ensureDocsCacheDir(): void {
  if (!fs.existsSync(DOCS_CACHE_DIR)) {
    fs.mkdirSync(DOCS_CACHE_DIR, { recursive: true });
  }
}

function getModuleHash(mod: Module): string {
  return Buffer.from(`${mod.name}@${mod.version}`).toString("base64").replace(/[/+=]/g, "_");
}

function getModuleDocsDir(mod: Module): string {
  return path.join(DOCS_CACHE_DIR, getModuleHash(mod));
}

function copyModuleDocs(mod: Module): string[] {
  const moduleHash = getModuleHash(mod);
  
  if (docsCache.has(moduleHash)) {
    return docsCache.get(moduleHash)!;
  }

  const docFiles: string[] = [];
  const seenFiles = new Set<string>();
  
  const docPatterns = [
    "**/*.md"
  ];

  try {
    const files = fg.sync(docPatterns, {
      cwd: mod.dir,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/test/**", "**/tests/**"],
      dot: false
    });

    for (const file of files) {
      const normalizedFile = file.toLowerCase();
      
      if (seenFiles.has(normalizedFile)) {
        continue;
      }
      seenFiles.add(normalizedFile);

      const pathParts = file.split(path.sep);
      if (pathParts.length === 1) {
        continue;
      }

      docFiles.push(file);
    }

    if (docFiles.length > 0) {
      const moduleDocsDir = getModuleDocsDir(mod);
      
      if (!fs.existsSync(moduleDocsDir)) {
        fs.mkdirSync(moduleDocsDir, { recursive: true });
      }

      for (const file of docFiles) {
        const srcPath = path.join(mod.dir, file);
        const destPath = path.join(moduleDocsDir, file);
        
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }

        fs.copyFileSync(srcPath, destPath);
      }
    }
  } catch (error) {
    console.error(`Failed to copy docs for ${mod.name}:`, error);
  }

  docsCache.set(moduleHash, docFiles);
  return docFiles;
}

function initializeDocsCache(root: string): { total: number; cached: number } {
  ensureDocsCacheDir();
  const modules = scanAllModules(root);
  let cached = 0;

  for (const mod of modules) {
    try {
      const docs = copyModuleDocs(mod);
      if (docs.length > 0) {
        cached++;
      }
    } catch (error) {
      console.error(`Failed to cache docs for ${mod.name}:`, error);
    }
  }

  return { total: modules.length, cached };
}

function tsKindToSymKind(node: ts.Node): SymKind | null {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isModuleDeclaration(node)) return "namespace";
  if (ts.isVariableStatement(node)) return "variable";
  return null;
}

function indexSymbols(mod: Module): Symbol[] {
  const cacheKey = fs.realpathSync.native(mod.dir);
  if (symbolCache.has(cacheKey)) return symbolCache.get(cacheKey)!;

  const files = fg
    .sync(["**/*.d.ts", "**/*.ts"], {
      cwd: mod.dir,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/dist/**", "**/build/**"],
    })
    .slice(0, 3000);

  const program = ts.createProgram(
    files.map((f) => path.join(mod.dir, f)),
    { allowJs: false, skipLibCheck: true, target: ts.ScriptTarget.ES2020 },
  );

  const symbols: Symbol[] = [];
  const srcFiles = program
    .getSourceFiles()
    .filter((sf) => sf.fileName.startsWith(mod.dir));

  for (const sf of srcFiles) {
    const rel = path.relative(mod.dir, sf.fileName).replace(/\\/g, "/");
    const lineOf = sf.getLineAndCharacterOfPosition.bind(sf);

    function visit(node: ts.Node) {
      const kind = tsKindToSymKind(node);
      if (kind) {
        let name = "default";
        if ("name" in node && (node as any).name?.getText) {
          name = (node as any).name.getText(sf);
        } else if (ts.isVariableStatement(node)) {
          const d = node.declarationList.declarations[0];
          if (d?.name) name = d.name.getText(sf);
        }

        const start = lineOf(node.getStart(sf));
        const end = lineOf(node.getEnd());
        const firstLine = sf.text.split(/\r?\n/)[start.line] || "";

        symbols.push({
          kind,
          name,
          file: rel,
          startLine: start.line + 1,
          endLine: end.line + 1,
          signature: firstLine.trim().slice(0, 200),
        });
      }
      node.forEachChild(visit);
    }
    visit(sf);
  }

  symbolCache.set(cacheKey, symbols);
  return symbols;
}

function readFileLines(
  absPath: string,
  start: number = 1,
  count: number = 500,
): string {
  const content = fs.readFileSync(absPath, "utf8");
  const lines = content.split(/\r?\n/);
  const startIdx = Math.max(0, start - 1);
  const endIdx = Math.min(lines.length, startIdx + count);
  return lines.slice(startIdx, endIdx).join("\n");
}

const server = new McpServer({
  name: "node-modules-docs",
  version: "0.3.0",
});

server.registerTool(
  "list_modules",
  {
    title: "List modules",
    description:
      "List all installed Node modules from all node_modules directories (including workspace packages)",
    inputSchema: {
      root: z
        .string()
        .optional()
        .describe("Project root directory (defaults to cwd)"),
      filter: z.string().optional().describe("Filter by module name substring"),
    },
  },
  async ({ root, filter }) => {
    const projectRoot = root
      ? path.resolve(root)
      : findProjectRoot(process.cwd());
    const modules = scanAllModules(projectRoot, filter);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              root: projectRoot,
              total: modules.length,
              modules: modules.map((m) => ({
                name: m.name,
                version: m.version,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "search",
  {
    title: "Search module files",
    description:
      "Search for pattern in module's .d.ts/.ts/.tsx/.jsx/.css/.scss/.sass/.less/.md files with code snippets",
    inputSchema: {
      root: z
        .string()
        .optional()
        .describe("Project root directory (defaults to cwd)"),
      module: z.string().describe("Module name (exact or substring match)"),
      pattern: z.string().describe("Regex pattern to search"),
      flags: z
        .string()
        .optional()
        .describe("Regex flags (e.g. 'i' for case-insensitive)"),
      context: z
        .number()
        .int()
        .nonnegative()
        .default(5)
        .describe("Lines of context around match"),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(20)
        .describe("Max results"),
    },
  },
  async ({ root, module, pattern, flags, context, limit }) => {
    const projectRoot = root
      ? path.resolve(root)
      : findProjectRoot(process.cwd());
    const mod = findModule(module, projectRoot);
    if (!mod) {
      return {
        content: [{ type: "text", text: `Module not found: ${module}` }],
        isError: true,
      };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Invalid regex: ${e.message}` }],
        isError: true,
      };
    }

    const moduleDocsDir = getModuleDocsDir(mod);
    const cachedDocs = docsCache.get(getModuleHash(mod)) || [];

    const codeFiles = fg.sync([
      "**/*.d.ts",
      "**/*.ts",
      "**/*.tsx",
      "**/*.jsx",
      "**/*.css",
      "**/*.scss",
      "**/*.sass",
      "**/*.less",
    ], {
      cwd: mod.dir,
      onlyFiles: true,
      ignore: [
        "**/node_modules/**",
        "**/test/**",
        "**/tests/**",
        "**/examples/**",
        "**/coverage/**",
      ],
    });

    const results: Array<{
      file: string;
      line: number;
      match: string;
      snippet: string;
    }> = [];

    for (const file of cachedDocs) {
      const abs = path.join(moduleDocsDir, file);
      if (!exists(abs)) continue;
      
      const content = fs.readFileSync(abs, "utf8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(regex);
        if (match) {
          const start = Math.max(0, i - context);
          const end = Math.min(lines.length, i + 1 + context);

          results.push({
            file: file.replace(/\\/g, "/"),
            line: i + 1,
            match: match[0],
            snippet: lines.slice(start, end).join("\n"),
          });

          if (results.length >= limit) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      module: mod.name,
                      total: results.length,
                      results,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
        }
      }
    }

    for (const file of codeFiles) {
      const abs = path.join(mod.dir, file);
      const content = fs.readFileSync(abs, "utf8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(regex);
        if (match) {
          const start = Math.max(0, i - context);
          const end = Math.min(lines.length, i + 1 + context);

          results.push({
            file: file.replace(/\\/g, "/"),
            line: i + 1,
            match: match[0],
            snippet: lines.slice(start, end).join("\n"),
          });

          if (results.length >= limit) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      module: mod.name,
                      total: results.length,
                      results,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              module: mod.name,
              total: results.length,
              results,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "read_file",
  {
    title: "Read module file",
    description: "Read a file from a module with optional line range",
    inputSchema: {
      root: z
        .string()
        .optional()
        .describe("Project root directory (defaults to cwd)"),
      module: z.string().describe("Module name"),
      file: z.string().describe("File path relative to module root"),
      startLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Start line (1-based)"),
      count: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe("Number of lines to read"),
    },
  },
  async ({ root, module, file, startLine, count }) => {
    const projectRoot = root
      ? path.resolve(root)
      : findProjectRoot(process.cwd());
    const mod = findModule(module, projectRoot);
    if (!mod) {
      return {
        content: [{ type: "text", text: `Module not found: ${module}` }],
        isError: true,
      };
    }

    const cachedDocs = docsCache.get(getModuleHash(mod)) || [];
    const isMarkdown = file.toLowerCase().endsWith('.md');
    const isCached = cachedDocs.includes(file);
    
    let abs: string;
    
    if (isMarkdown && isCached) {
      abs = path.join(getModuleDocsDir(mod), file);
      if (!exists(abs)) {
        abs = path.join(mod.dir, file);
      }
    } else {
      abs = path.join(mod.dir, file);
    }

    if (!exists(abs)) {
      return {
        content: [{ type: "text", text: `File not found: ${file}` }],
        isError: true,
      };
    }

    const content =
      startLine || count
        ? readFileLines(abs, startLine || 1, count || 500)
        : fs.readFileSync(abs, "utf8");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              module: mod.name,
              file: file.replace(/\\/g, "/"),
              content,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "list_symbols",
  {
    title: "List TypeScript symbols",
    description:
      "List TypeScript symbols (functions, classes, interfaces, etc.) from a module",
    inputSchema: {
      root: z
        .string()
        .optional()
        .describe("Project root directory (defaults to cwd)"),
      module: z.string().describe("Module name"),
      kind: z
        .enum([
          "function",
          "class",
          "interface",
          "type",
          "enum",
          "namespace",
          "variable",
        ])
        .optional(),
      name: z.string().optional().describe("Filter by symbol name (substring)"),
      limit: z.number().int().positive().max(500).default(100),
    },
  },
  async ({ root, module, kind, name, limit }) => {
    const projectRoot = root
      ? path.resolve(root)
      : findProjectRoot(process.cwd());
    const mod = findModule(module, projectRoot);
    if (!mod) {
      return {
        content: [{ type: "text", text: `Module not found: ${module}` }],
        isError: true,
      };
    }

    const symbols = indexSymbols(mod)
      .filter(
        (s) => (!kind || s.kind === kind) && (!name || s.name.includes(name)),
      )
      .slice(0, limit);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              module: mod.name,
              total: symbols.length,
              symbols,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "get_symbol",
  {
    title: "Get symbol code",
    description: "Get the full code for a specific symbol",
    inputSchema: {
      root: z
        .string()
        .optional()
        .describe("Project root directory (defaults to cwd)"),
      module: z.string(),
      file: z.string(),
      name: z.string(),
      padding: z
        .number()
        .int()
        .nonnegative()
        .default(10)
        .describe("Lines of padding around symbol"),
    },
  },
  async ({ root, module, file, name, padding }) => {
    const projectRoot = root
      ? path.resolve(root)
      : findProjectRoot(process.cwd());
    const mod = findModule(module, projectRoot);
    if (!mod) {
      return {
        content: [{ type: "text", text: `Module not found: ${module}` }],
        isError: true,
      };
    }

    const symbols = indexSymbols(mod);
    const symbol = symbols.find((s) => s.file === file && s.name === name);

    if (!symbol) {
      return {
        content: [
          { type: "text", text: `Symbol not found: ${name} in ${file}` },
        ],
        isError: true,
      };
    }

    const abs = path.join(mod.dir, file);
    const start = Math.max(1, symbol.startLine - padding);
    const count = symbol.endLine - symbol.startLine + 1 + 2 * padding;
    const code = readFileLines(abs, start, count);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              module: mod.name,
              file,
              symbol: {
                kind: symbol.kind,
                name: symbol.name,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
              },
              code,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);



try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  const projectRoot = findProjectRoot(process.cwd());
  console.error(`[mcp] node-modules-docs v0.3.0 ready. CWD=${process.cwd()}`);
  console.error(`[mcp] Initializing documentation cache...`);
  
  const { total, cached } = initializeDocsCache(projectRoot);
  console.error(`[mcp] Documentation cache initialized: ${cached}/${total} modules cached in ${DOCS_CACHE_DIR}`);
} catch (e) {
  console.error("Error starting server:", (e as Error).stack || e);
  process.exit(1);
}
