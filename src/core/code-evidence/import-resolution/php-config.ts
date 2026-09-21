import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver, KnowledgeFragment, ProjectManifestSpec } from "../types.js";
import { nearestProjectManifest } from "../project-structure.js";
import { createDeclarationImportResolver } from "./declarations.js";
import { localPath } from "./paths.js";
import { literalGlob } from "../literal-glob.js";
import { dependencyNames } from "./classification.js";

interface ComposerConfig {
  prefixes: Array<{ prefix: string; directories: string[]; psr0?: boolean }>;
  classmap: string[];
  files?: string[];
  excluded: string[];
  dependencies: string[];
}

function paths(value: unknown, exclusions = false): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("Invalid Composer paths.");
  const entries = (value as string[]).map((entry) => exclusions ? entry.replace(/^\//u, "") : entry);
  if (entries.some((entry) => localPath(".", entry || ".") === undefined)) throw new Error("Invalid Composer paths.");
  return entries;
}

function pathPattern(pattern: string): (value: string) => boolean {
  const normalized = pattern.replace(/^\.\//u, "").replace(/\/+$/u, "");
  return literalGlob(normalized === "." ? "" : normalized, { pathPrefix: true });
}
export const COMPOSER_MANIFEST: ProjectManifestSpec = { fileName: "composer.json", parse(content) {
  const root: unknown = JSON.parse(content);
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("Invalid Composer manifest.");
  const prefixes: ComposerConfig["prefixes"] = [];
  const classmap: string[] = [], excluded: string[] = [];
  let files: string[] | undefined;
  for (const section of ["autoload", "autoload-dev"]) {
    const autoload = (root as Record<string, unknown>)[section];
    if (autoload === undefined) continue;
    if (!autoload || typeof autoload !== "object" || Array.isArray(autoload)) throw new Error("Invalid Composer autoload.");
    const fields = autoload as Record<string, unknown>;
    if (fields.classmap !== undefined) classmap.push(...paths(fields.classmap));
    if (fields.files !== undefined) (files ??= []).push(...paths(fields.files));
    if (fields["exclude-from-classmap"] !== undefined) excluded.push(...paths(fields["exclude-from-classmap"], true));
    for (const mode of ["psr-4", "psr-0"]) {
    const psr4 = fields[mode];
    if (psr4 === undefined) continue;
    if (!psr4 || typeof psr4 !== "object" || Array.isArray(psr4)) throw new Error("Invalid Composer PSR-4.");
    for (const [prefix, value] of Object.entries(psr4)) {
      const directories = Array.isArray(value) ? value : [value];
      if ((prefix !== "" && !(mode === "psr-4" ? /^(?:[A-Za-z_]\w*\\)+$/u : /^[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*\\?$/u).test(prefix)) || !directories.length ||
          directories.some((dir) => typeof dir !== "string" || localPath(".", dir || ".") === undefined)) throw new Error("Invalid PSR-4 mapping.");
      prefixes.push({ prefix, directories: directories as string[], ...(mode === "psr-0" ? { psr0: true } : {}) });
    }
    }
  }
  return { prefixes, classmap, files, excluded, dependencies: dependencyNames((root as Record<string, unknown>).require) } satisfies ComposerConfig;
} };

export function createPhpImportResolver(context: CodeImportContext): CodeImportResolver {
  const owner = (source: string) => context.structure && nearestProjectManifest(context.structure, source, "composer.json");
  const cached = new Map<string, CodeImportResolver>();
  return (source, specifier) => {
    const manifest = owner(source), key = manifest?.path ?? "";
    if (manifest?.warning) return [];
    let resolve = cached.get(key);
    if (!resolve) {
      const fragmentsByPath = new Map<string, readonly KnowledgeFragment[]>();
      const config = manifest?.value as ComposerConfig | undefined;
      const classmaps = config?.classmap.map(pathPattern) ?? [], exclusions = config?.excluded.map(pathPattern) ?? [];
      const loadedFiles = new Set(config?.files?.map((file) => localPath(posix.dirname(manifest!.path), file)));
      for (const [path, fragments] of context.fragmentsByPath) {
        if (owner(path)?.path !== manifest?.path) continue;
        const relative = manifest ? posix.relative(posix.dirname(manifest.path), path) : path;
        const fromClassmap = classmaps.some((matches) => matches(relative)) && !exclusions.some((matches) => matches(relative));
        fragmentsByPath.set(path, fragments.filter((fragment) => {
          if (!manifest || !config) return true;
          if (fragment.kind !== "class") return config.files === undefined || !["function", "constant"].includes(fragment.kind) || loadedFiles.has(path);
          // Metadata-only Composer files do not declare a PSR-4 layout.
          // Preserve declaration-based resolution inside the project boundary.
          if (!config.prefixes.length && !config.classmap.length && config.files === undefined) return true;
          if (loadedFiles.has(path) || fromClassmap) return true;
          const mappings = config.prefixes.filter(({ prefix }) => fragment.qualifiedName.startsWith(prefix));
          if (!mappings.length) return false;
          const longest = Math.max(-1, ...mappings.filter(({ psr0 }) => !psr0).map(({ prefix }) => prefix.length));
          return mappings.filter(({ prefix, psr0 }) => psr0 || prefix.length === longest).some(({ prefix, directories, psr0 }) =>
            directories.some((directory) => localPath(posix.dirname(manifest.path), posix.join(directory || ".",
              `${psr0 ? fragment.qualifiedName.split("\\").map((part, index, parts) => index === parts.length - 1 ? part.replace(/_/gu, "/") : part).join("/")
                : fragment.qualifiedName.slice(prefix.length).replace(/\\/gu, "/")}.php`)) === path));
        }));
      }
      resolve = createDeclarationImportResolver({ ...context, fragmentsByPath }, "php"); cached.set(key, resolve);
    }
    return resolve(source, specifier);
  };
}
