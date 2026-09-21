import { posix } from "node:path";
import { parseManifestJson } from "../manifest-json.js";
import type { ProjectManifest, ProjectManifestSpec, ProjectStructure } from "../types.js";
import { localPath } from "./paths.js";
import { PACKAGE_MANIFEST, PNPM_WORKSPACE_MANIFEST } from "./javascript-packages.js";
import { literalGlob } from "../literal-glob.js";

interface PathMapping { pattern: string; targets: string[] }
interface JavaScriptConfig { baseUrl?: string; paths?: PathMapping[]; extends?: string; references?: string[]; include?: string[]; exclude?: string[]; files?: string[] }
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
  for (const key of ["include", "exclude", "files"] as const) if (parsed[key] !== undefined) {
    if (!Array.isArray(parsed[key]) || !(parsed[key] as unknown[]).every((value) => typeof value === "string" && !/[\\\0{}\[\]]/u.test(value) && !posix.isAbsolute(value))) throw new Error(`Invalid ${key}.`);
    config[key] = parsed[key] as string[];
  }
  if (parsed.references !== undefined) {
    if (!Array.isArray(parsed.references)) throw new Error("Invalid project references.");
    config.references = parsed.references.map((entry) => {
      if (!object(entry) || !pathValue(entry.path)) throw new Error("Invalid project reference.");
      return entry.path.endsWith(".json") ? entry.path : posix.join(entry.path, "tsconfig.json");
    });
  }
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
  return [...(config.extends ? [config.extends] : []), ...(config.references ?? [])].map((value) => {
    const reference = localPath(directory, value);
    if (!reference) throw new Error("Config reference leaves repository.");
    return reference;
  });
}

export const JAVASCRIPT_PROJECT_MANIFESTS: readonly ProjectManifestSpec[] = [...["tsconfig.json", "jsconfig.json"]
  .map((fileName): ProjectManifestSpec => ({ fileName, parse: parseConfig, references: configReferences, referenceDepth: 8,
    referenceNotices(value, path, manifests) {
      const config = value as JavaScriptConfig;
      const parent = config.extends ? manifests.get(localPath(posix.dirname(path), config.extends) ?? "") : undefined;
      return (parent?.value as JavaScriptConfig | undefined)?.extends ? ["manifest_reference_depth"] : [];
    },
  })), PACKAGE_MANIFEST, PNPM_WORKSPACE_MANIFEST];

/** One local inheritance level; relative options keep their declaring origin.
 * A child paths object replaces the whole parent object, as in TypeScript. */
export function importConfig(manifest: ProjectManifest, structure: ProjectStructure): JavaScriptImportConfig | undefined {
  if (manifest.warning || !manifest.value) return;
  const config = manifest.value as JavaScriptConfig;
  const parent = config.extends ? structure.manifests.get(localPath(posix.dirname(manifest.path), config.extends) ?? "") : undefined;
  if (config.extends && (!parent || parent.warning || (parent.value as JavaScriptConfig | undefined)?.extends || !parent.value)) return;
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

/** Compile ownership selectors once per manifest generation. Explicit file
 * membership takes precedence over an unscoped umbrella config; overlapping
 * explicit projects stay ambiguous instead of borrowing arbitrary aliases. */
export function createJavaScriptConfigSelector(structure: ProjectStructure): (source: string) => ProjectManifest | undefined {
  const directories = new Map<string, Array<{ manifest: ProjectManifest; explicit: boolean; matches: (path: string) => boolean }>>();
  for (const manifest of structure.manifests.values()) {
    if (!["tsconfig.json", "jsconfig.json"].includes(manifest.fileName)) continue;
    const config = manifest.value as JavaScriptConfig | undefined;
    const directory = posix.dirname(manifest.path);
    const parent = config?.extends ? structure.manifests.get(localPath(directory, config.extends) ?? "") : undefined;
    const inherited = !parent?.warning ? parent?.value as JavaScriptConfig | undefined : undefined;
    const values = (key: "include" | "exclude" | "files") => config?.[key] ?? inherited?.[key]?.map((entry) => posix.relative(directory, posix.join(posix.dirname(parent!.path), entry)));
    const includes = values("include")?.map((pattern) => literalGlob(pattern, { pathPrefix: true, pathSegments: true, questionMark: true }));
    const excludes = values("exclude")?.map((pattern) => literalGlob(pattern, { pathPrefix: true, pathSegments: true, questionMark: true }));
    const fileList = values("files");
    const files = fileList ? new Set(fileList.map((file) => posix.normalize(file))) : undefined;
    const entries = directories.get(directory) ?? [];
    entries.push({ manifest, explicit: files !== undefined || includes !== undefined,
      matches: (source) => {
        const relative = posix.relative(directory, source);
        return files?.has(relative) || (includes ? includes.some((matches) => matches(relative)) : files === undefined) && !excludes?.some((matches) => matches(relative));
      } });
    directories.set(directory, entries);
  }
  const cache = new Map<string, ProjectManifest | undefined>();
  return (source) => {
    if (cache.has(source)) return cache.get(source);
    let directory = posix.dirname(source), result: ProjectManifest | undefined;
    while (true) {
      const entries = directories.get(directory);
      if (entries?.length) {
        const matching = entries.filter((entry) => entry.matches(source));
        const explicit = matching.filter((entry) => entry.explicit);
        const selected = explicit.length ? explicit : matching.filter(({ manifest }) => posix.basename(manifest.path) === "tsconfig.json");
        const candidates = selected.length ? selected : matching.filter(({ manifest }) => posix.basename(manifest.path) === "jsconfig.json");
        result = candidates.length > 1 ? { path: posix.join(directory, "tsconfig.json"), fileName: "tsconfig.json", warning: "ambiguous_tsconfig_ownership" }
          : candidates[0]?.manifest;
        break;
      }
      if (directory === ".") break;
      directory = posix.dirname(directory);
    }
    cache.set(source, result); return result;
  };
}
