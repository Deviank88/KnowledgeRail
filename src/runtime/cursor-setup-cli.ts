import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { atomicWriteText } from "../core/fs-service.js";
import { PRODUCT_VERSION } from "../product.js";
import { discoverWorkspaceFromCwd } from "../mcp/workspace-discovery.js";

const MAX_CURSOR_CONFIG_BYTES = 1024 * 1024;
const CURSOR_CONFIG_RELATIVE_PATH = ".cursor/mcp.json";

type JsonRecord = Record<string, unknown>;

export interface CursorSetupResult {
  root: string;
  configPath: string;
  changed: boolean;
}

interface WritableText {
  write(value: string): unknown;
}

export interface CursorSetupIo {
  stdout: WritableText;
}

const DEFAULT_IO: CursorSetupIo = { stdout: process.stdout };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return relative === "" || (
    !relative.startsWith(`..${nodePath.sep}`) &&
    relative !== ".." &&
    !nodePath.isAbsolute(relative)
  );
}

async function ensureSafeCursorDirectory(root: string): Promise<string> {
  const cursorDirectory = nodePath.join(root, ".cursor");
  const before = await fs.lstat(cursorDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (before && (!before.isDirectory() || before.isSymbolicLink())) {
    throw new Error(".cursor must be a real directory inside the project root.");
  }
  if (!before) await fs.mkdir(cursorDirectory, { recursive: true, mode: 0o755 });

  const canonical = await fs.realpath(cursorDirectory);
  if (!insideRoot(root, canonical)) {
    throw new Error(".cursor resolves outside the project root.");
  }
  return canonical;
}

async function readCursorConfig(configPath: string): Promise<JsonRecord> {
  const stat = await fs.lstat(configPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return {};
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(".cursor/mcp.json must be a regular file inside the project root.");
  }
  if (stat.size > MAX_CURSOR_CONFIG_BYTES) {
    throw new Error(".cursor/mcp.json is too large to update safely.");
  }

  const raw = await fs.readFile(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(".cursor/mcp.json contains invalid JSON; fix it before running setup again.");
  }
  if (!isRecord(parsed)) throw new Error(".cursor/mcp.json must contain a JSON object.");
  return parsed;
}

function mergedCursorConfig(config: JsonRecord): JsonRecord {
  const existingServers = config["mcpServers"];
  if (existingServers !== undefined && !isRecord(existingServers)) {
    throw new Error(".cursor/mcp.json field mcpServers must be a JSON object.");
  }
  const servers = existingServers ?? {};
  const existingKnowledgeRail = servers["knowledge-rail"];
  if (existingKnowledgeRail !== undefined && !isRecord(existingKnowledgeRail)) {
    throw new Error(".cursor/mcp.json server knowledge-rail must be a JSON object.");
  }
  const compatibleExisting = Object.fromEntries(
    Object.entries(existingKnowledgeRail ?? {}).filter(
      ([key]) => !["url", "headers", "auth"].includes(key)
    )
  );

  return {
    ...config,
    mcpServers: {
      ...servers,
      "knowledge-rail": {
        ...compatibleExisting,
        type: "stdio",
        command: "npx",
        args: [
          "-y",
          `knowledge-rail@${PRODUCT_VERSION}`,
          "--root",
          "${workspaceFolder}",
        ],
      },
    },
  };
}

export async function installCursorSetup(startPath = process.cwd()): Promise<CursorSetupResult> {
  const resolution = await discoverWorkspaceFromCwd(startPath);
  const root = resolution.root;
  const cursorDirectory = await ensureSafeCursorDirectory(root);
  const configPath = nodePath.join(cursorDirectory, "mcp.json");
  if (!insideRoot(root, configPath)) throw new Error("Cursor configuration resolves outside the project root.");

  const current = await readCursorConfig(configPath);
  const merged = mergedCursorConfig(current);
  const semanticallyChanged = JSON.stringify(current) !== JSON.stringify(merged);
  if (semanticallyChanged) {
    await atomicWriteText(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  }
  return { root, configPath, changed: semanticallyChanged };
}

export async function runCursorSetup(
  suppliedPath: string | undefined,
  io: CursorSetupIo = DEFAULT_IO
): Promise<void> {
  const result = await installCursorSetup(suppliedPath ?? process.cwd());
  const action = result.changed ? "Configured" : "Already configured";
  io.stdout.write(`${action} Cursor for ${result.root} in ${CURSOR_CONFIG_RELATIVE_PATH}.\n`);
}
