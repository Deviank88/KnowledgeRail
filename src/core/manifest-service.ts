import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import fg from "fast-glob";
import { atomicWriteText } from "./fs-service.js";
import { resolveRealWithin } from "./paths.js";
import { withWikiFileLock } from "./lock-service.js";
import { ensureDir, readFileSafe } from "./utils.js";

export const MANIFEST_VERSION = 2;

export type ManifestLogicalType = "wiki_page" | "control" | "doc";

export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
  logicalType: ManifestLogicalType;
}

export interface WikiManifest {
  version: 2;
  hashAlgorithm: "sha256";
  contentNormalization: "line-endings-lf";
  pathNormalization: "posix-unicode-nfc";
  entries: ManifestEntry[];
}

export interface LegacyManifestEntryV1 extends ManifestEntry {
  mtimeMs: number;
}

export interface LegacyWikiManifestV1 {
  version: 1;
  generatedAt: string;
  entries: LegacyManifestEntryV1[];
}

export type ReadableWikiManifest = WikiManifest | LegacyWikiManifestV1;

export function wikiMetaDir(wikiRoot: string): string {
  return nodePath.join(wikiRoot, ".knowledge-rail");
}

export function manifestFile(wikiRoot: string): string {
  return nodePath.join(wikiMetaDir(wikiRoot), "manifest.json");
}

export function normalizeManifestPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").normalize("NFC");
}

export function normalizeMarkdownBytes(buffer: Buffer): Buffer {
  if (!buffer.includes(0x0d)) return buffer;
  const normalized = Buffer.allocUnsafe(buffer.length);
  let outputIndex = 0;
  for (let inputIndex = 0; inputIndex < buffer.length; inputIndex++) {
    const byte = buffer[inputIndex];
    if (byte === 0x0d) {
      if (buffer[inputIndex + 1] === 0x0a) inputIndex++;
      normalized[outputIndex++] = 0x0a;
    } else {
      normalized[outputIndex++] = byte!;
    }
  }
  return normalized.subarray(0, outputIndex);
}

function logicalType(relPath: string): ManifestLogicalType {
  return ["SCHEMA.md", "index.md", "log.md"].includes(relPath) ? "control" : "wiki_page";
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePortablePaths(files: Array<{ sourcePath: string; manifestPath: string }>): void {
  const exact = new Map<string, string>();
  const caseFolded = new Map<string, string>();
  for (const file of files) {
    const existingExact = exact.get(file.manifestPath);
    if (existingExact !== undefined) {
      throw new Error(
        `Manifest path collision after POSIX/NFC normalization: ${existingExact} and ${file.sourcePath}.`
      );
    }
    exact.set(file.manifestPath, file.sourcePath);

    const portableKey = file.manifestPath.toLowerCase();
    const existingCaseFolded = caseFolded.get(portableKey);
    if (existingCaseFolded !== undefined && existingCaseFolded !== file.manifestPath) {
      throw new Error(
        `Manifest path collision on case-insensitive filesystems: ${existingCaseFolded} and ${file.manifestPath}.`
      );
    }
    caseFolded.set(portableKey, file.manifestPath);
  }
}

function validLogicalType(value: unknown): value is ManifestLogicalType {
  return value === "wiki_page" || value === "control" || value === "doc";
}

function validEntry(value: unknown, legacy: boolean): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LegacyManifestEntryV1>;
  if (
    typeof entry.path !== "string" || entry.path !== entry.path.replace(/\\/g, "/") ||
    (!legacy && entry.path !== normalizeManifestPath(entry.path)) ||
    nodePath.posix.isAbsolute(entry.path) ||
    !entry.path.toLowerCase().endsWith(".md") ||
    entry.path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    !Number.isSafeInteger(entry.size) || entry.size! < 0 ||
    typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    !validLogicalType(entry.logicalType)
  ) return false;
  return !legacy || (
    typeof entry.mtimeMs === "number" && Number.isFinite(entry.mtimeMs) && entry.mtimeMs >= 0
  );
}

function hasUniquePaths(entries: Array<{ path: string }>, caseInsensitive: boolean): boolean {
  return new Set(entries.map((entry) => caseInsensitive ? entry.path.toLowerCase() : entry.path)).size === entries.length;
}

function canonicalManifest(manifest: WikiManifest): WikiManifest {
  const entries = manifest.entries.map((entry) => ({
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
    logicalType: entry.logicalType,
  }));
  if (
    !entries.every((entry) => validEntry(entry, false)) ||
    !hasUniquePaths(entries, true)
  ) throw new Error("Manifest v2 contains invalid or non-portable entries.");
  entries.sort((left, right) => comparePaths(left.path, right.path));
  return {
    version: MANIFEST_VERSION,
    hashAlgorithm: "sha256",
    contentNormalization: "line-endings-lf",
    pathNormalization: "posix-unicode-nfc",
    entries,
  };
}

function parseManifest(raw: string): ReadableWikiManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<ReadableWikiManifest> & { entries?: unknown };
  if (!Array.isArray(candidate.entries)) return null;
  if (candidate.version === 2) {
    if (
      candidate.hashAlgorithm !== "sha256" ||
      candidate.contentNormalization !== "line-endings-lf" ||
      candidate.pathNormalization !== "posix-unicode-nfc" ||
      !candidate.entries.every((entry) => validEntry(entry, false)) ||
      !hasUniquePaths(candidate.entries as ManifestEntry[], true)
    ) return null;
    return canonicalManifest(candidate as WikiManifest);
  }
  if (candidate.version === 1) {
    const legacy = candidate as Partial<LegacyWikiManifestV1> & { entries: unknown[] };
    if (
      typeof legacy.generatedAt !== "string" || Number.isNaN(Date.parse(legacy.generatedAt)) ||
      !legacy.entries.every((entry) => validEntry(entry, true)) ||
      !hasUniquePaths(legacy.entries as LegacyManifestEntryV1[], false)
    ) return null;
    return legacy as LegacyWikiManifestV1;
  }
  return null;
}

export async function buildManifest(wikiRoot: string): Promise<WikiManifest> {
  const safeWikiRoot = await resolveRealWithin(
    nodePath.dirname(wikiRoot),
    nodePath.basename(wikiRoot)
  );
  const discovered = await fg("**/*.md", {
    cwd: safeWikiRoot,
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [".knowledge-rail/**", ".llm-wiki/**"],
  }).catch(() => [] as string[]);
  const files = discovered.map((sourcePath) => ({
    sourcePath,
    manifestPath: normalizeManifestPath(sourcePath),
  }));
  validatePortablePaths(files);
  files.sort((left, right) => comparePaths(left.manifestPath, right.manifestPath));

  const entries: ManifestEntry[] = [];
  for (const { sourcePath, manifestPath } of files) {
    const absPath = await resolveRealWithin(safeWikiRoot, sourcePath);
    const content = normalizeMarkdownBytes(await fs.readFile(absPath));
    entries.push({
      path: manifestPath,
      size: content.length,
      sha256: sha256(content),
      logicalType: logicalType(manifestPath),
    });
  }

  return {
    version: MANIFEST_VERSION,
    hashAlgorithm: "sha256",
    contentNormalization: "line-endings-lf",
    pathNormalization: "posix-unicode-nfc",
    entries,
  };
}

export async function saveManifest(wikiRoot: string, manifest: WikiManifest): Promise<void> {
  await ensureDir(wikiMetaDir(wikiRoot));
  await atomicWriteText(
    manifestFile(wikiRoot),
    JSON.stringify(canonicalManifest(manifest), null, 2) + "\n"
  );
}

export async function rebuildManifest(wikiRoot: string): Promise<WikiManifest> {
  return withWikiFileLock(wikiRoot, manifestFile(wikiRoot), async () => {
    const manifest = await buildManifest(wikiRoot);
    await saveManifest(wikiRoot, manifest);
    return manifest;
  });
}

export async function readManifest(wikiRoot: string): Promise<ReadableWikiManifest | null> {
  const raw = await readFileSafe(manifestFile(wikiRoot));
  return raw === null ? null : parseManifest(raw);
}

export async function invalidateManifestEntries(
  wikiRoot: string,
  relPaths: string[]
): Promise<void> {
  await withWikiFileLock(wikiRoot, manifestFile(wikiRoot), async () => {
    const existing = await readManifest(wikiRoot);
    if (!existing) return;
    const manifest = existing.version === MANIFEST_VERSION
      ? existing
      : await buildManifest(wikiRoot);
    const invalid = new Set(relPaths.map(normalizeManifestPath));
    manifest.entries = manifest.entries.filter((entry) => !invalid.has(entry.path));
    await saveManifest(wikiRoot, manifest);
  });
}
