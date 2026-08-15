import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import fg from "fast-glob";
import { atomicWriteText } from "./fs-service.js";
import { ensureDir, readFileSafe } from "./utils.js";

export interface ManifestEntry {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  logicalType: "wiki_page" | "control" | "doc";
}

export interface WikiManifest {
  version: 1;
  generatedAt: string;
  entries: ManifestEntry[];
}

export function wikiMetaDir(wikiRoot: string): string {
  return nodePath.join(wikiRoot, ".knowledge-rail");
}

export function manifestFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "manifest.json");
}

function logicalType(relPath: string): ManifestEntry["logicalType"] {
  return ["SCHEMA.md", "index.md", "log.md"].includes(relPath) ? "control" : "wiki_page";
}

async function fileHash(absPath: string): Promise<string> {
  const buffer = await fs.readFile(absPath);
  return createHash("sha256").update(buffer).digest("hex");
}

export async function buildManifest(wikiRoot: string): Promise<WikiManifest> {
  const files = await fg("**/*.md", {
    cwd: wikiRoot,
    dot: false,
    onlyFiles: true,
    ignore: [".knowledge-rail/**"],
  }).catch(() => [] as string[]);

  const entries: ManifestEntry[] = [];
  for (const relPath of files.sort()) {
    const absPath = nodePath.join(wikiRoot, relPath);
    const stat = await fs.stat(absPath);
    entries.push({
      path: relPath.replace(/\\/g, "/"),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: await fileHash(absPath),
      logicalType: logicalType(relPath.replace(/\\/g, "/")),
    });
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };
}

export async function saveManifest(wikiRoot: string, manifest: WikiManifest): Promise<void> {
  await ensureDir(wikiMetaDir(wikiRoot));
  await atomicWriteText(manifestFile(wikiRoot), JSON.stringify(manifest, null, 2) + "\n");
}

export async function rebuildManifest(wikiRoot: string): Promise<WikiManifest> {
  const manifest = await buildManifest(wikiRoot);
  await saveManifest(wikiRoot, manifest);
  return manifest;
}

export async function readManifest(wikiRoot: string): Promise<WikiManifest | null> {
  const raw = await readFileSafe(manifestFile(wikiRoot));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WikiManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function invalidateManifestEntries(
  wikiRoot: string,
  relPaths: string[]
): Promise<void> {
  const manifest = await readManifest(wikiRoot);
  if (!manifest) return;
  const invalid = new Set(relPaths.map((p) => p.replace(/\\/g, "/")));
  manifest.entries = manifest.entries.filter((entry) => !invalid.has(entry.path));
  manifest.generatedAt = new Date().toISOString();
  await saveManifest(wikiRoot, manifest);
}

