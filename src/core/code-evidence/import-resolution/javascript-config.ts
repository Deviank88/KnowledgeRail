import { posix } from "node:path";
import { parseManifestJson } from "../manifest-json.js";
import type { ProjectManifest, ProjectManifestSpec, ProjectStructure } from "../types.js";
import { localPath } from "./paths.js";

interface PathMapping { pattern: string; targets: string[] }
interface JavaScriptConfig { baseUrl?: string; paths?: PathMapping[]; extends?: string }
export interface JavaScriptImportConfig {
  baseUrl?: string;
  pathsBase: string;
  exact: ReadonlyMap<string, readonly string[]>;
  patterns: readonly (PathMapping & { prefix: string; suffix: string })[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\\?#\0]/u.test(value) &&
    !posix.isAbsolute(value) && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
}

function parseConfig(content: string): JavaScriptConfig {
  const parsed = parseManifestJson(content);
  if (!object(parsed) || (parsed.compilerOptions !== undefined && !object(parsed.compilerOptions))) throw new Error("Invalid config.");
  const options = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
  const config: JavaScriptConfig = {};
  if (parsed.extends !== undefined) {
    if (!pathValue(parsed.extends) || !/^\.{1,2}\//u.test(parsed.extends)) throw new Error("Only a local extends is supported.");
    config.extends = parsed.extends.endsWith(".json") ? parsed.extends : `${parsed.extends}.json`;
  }
  if (options.baseUrl !== undefined) {
    if (options.baseUrl !== "" && !pathValue(options.baseUrl)) throw new Error("Invalid baseUrl.");
    config.baseUrl = options.baseUrl;
  }
  // rootDir controls output layout, not import identity. Do not use it as an
  // inferred module root or retain a second copy of an unused option.
  if (options.paths !== undefined) {
    if (!object(options.paths)) throw new Error("Invalid paths.");
    config.paths = Object.entries(options.paths).map(([pattern, targets]) => {
      if (!pattern || pattern.split("*").length > 2 || !Array.isArray(targets) || !targets.length ||
          !targets.every((target) => pathValue(target) && target.split("*").length <= 2 && (pattern.includes("*") || !target.includes("*")))) {
        throw new Error("Invalid path mapping.");
      }
      return { pattern, targets: targets as string[] };
    });
  }
  return config;
}

function configReferences(value: unknown, manifestPath: string): string[] {
  const config = value as JavaScriptConfig;
  const directory = posix.dirname(manifestPath);
  if (config.baseUrl !== undefined && localPath(directory, config.baseUrl) === undefined) throw new Error("baseUrl leaves repository.");
  if (!config.extends) return [];
  const reference = localPath(directory, config.extends);
  if (!reference) throw new Error("extends leaves repository.");
  return [reference];
}

export const JAVASCRIPT_PROJECT_MANIFESTS: readonly ProjectManifestSpec[] = ["tsconfig.json", "jsconfig.json"]
  .map((fileName) => ({ fileName, parse: parseConfig, references: configReferences }));

/** One local inheritance level; relative options keep their declaring origin.
 * A child paths object replaces the whole parent object, as in TypeScript. */
export function importConfig(manifest: ProjectManifest, structure: ProjectStructure): JavaScriptImportConfig | undefined {
  if (manifest.warning || !manifest.value) return;
  const config = manifest.value as JavaScriptConfig;
  const parent = manifest.references?.[0] ? structure.manifests.get(manifest.references[0]) : undefined;
  if (config.extends && (!parent || parent.warning || parent.references?.length || !parent.value)) return;
  const inherited = parent?.value as JavaScriptConfig | undefined;
  const baseOwner = config.baseUrl !== undefined ? manifest : parent;
  const baseValue = config.baseUrl ?? inherited?.baseUrl;
  const baseUrl = baseValue !== undefined && baseOwner ? localPath(posix.dirname(baseOwner.path), baseValue) : undefined;
  if (baseValue !== undefined && baseUrl === undefined) return;
  const pathsOwner = config.paths !== undefined ? manifest : parent;
  const mappings = config.paths ?? inherited?.paths ?? [];
  const exact = new Map<string, readonly string[]>();
  const patterns: Array<PathMapping & { prefix: string; suffix: string }> = [];
  for (const mapping of mappings) {
    const star = mapping.pattern.indexOf("*");
    if (star === -1) exact.set(mapping.pattern, mapping.targets);
    else patterns.push({ ...mapping, prefix: mapping.pattern.slice(0, star), suffix: mapping.pattern.slice(star + 1) });
  }
  patterns.sort((a, b) => b.prefix.length - a.prefix.length);
  return { baseUrl, pathsBase: baseUrl ?? posix.dirname(pathsOwner?.path ?? manifest.path), exact, patterns };
}

/** Nearest config boundary, with tsconfig precedence in the same directory.
 * Config includes/excludes and project references are outside this resolver. */
export function nearestJavaScriptConfig(structure: ProjectStructure, directory: string): ProjectManifest | undefined {
  while (true) {
    const manifest = structure.manifests.get(posix.join(directory, "tsconfig.json")) ?? structure.manifests.get(posix.join(directory, "jsconfig.json"));
    if (manifest || directory === ".") return manifest;
    directory = posix.dirname(directory);
  }
}
