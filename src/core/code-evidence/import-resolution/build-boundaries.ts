import { posix } from "node:path";
import { maskBraceLanguage } from "../brace-language-engine.js";
import { childText, elementSpans, wellFormedXml } from "../manifest-xml.js";
import { literalGlob } from "../literal-glob.js";
import { nearestProjectManifest } from "../project-structure.js";
import type { ProjectManifestSpec, ProjectStructure } from "../types.js";
import { localPath } from "./paths.js";

interface BuildBoundary { modules: string[]; removed: string[]; notices: string[] }
function projectXml(content: string): BuildBoundary {
  if (!wellFormedXml(content) || !/<Project\b/u.test(content)) throw new Error("Invalid MSBuild boundary.");
  const removed: string[] = [], notices = new Set<string>();
  const visible = content.replace(/<!--[\s\S]*?-->/gu, " ");
  const conditioned = /\bCondition\s*=/u.test(visible);
  for (const match of visible.matchAll(/<Compile\b([^>]*?)\/?\s*>/gu)) {
    const value = /\bRemove\s*=\s*(["'])(.*?)\1/u.exec(match[1]!)?.[2];
    if (value === undefined) continue;
    if (conditioned || /[$@%]/u.test(value)) { notices.add("unsupported_compile_remove"); continue; }
    for (const entry of value.split(";")) {
      const normalized = entry.replace(/\\/gu, "/");
      if (localPath(".", normalized)) removed.push(normalized); else notices.add("unsupported_compile_remove");
    }
  }
  return { modules: [], removed, notices: [...notices] };
}
export const CSHARP_BUILD_PROPS: ProjectManifestSpec = { fileName: "Directory.Build.props", parse: projectXml,
  notices: (value) => (value as BuildBoundary).notices };
export const CSHARP_PROJECT_MANIFEST: ProjectManifestSpec = { fileName: "*.csproj", parse: projectXml,
  notices: (value) => (value as BuildBoundary).notices };
export const MAVEN_MANIFEST: ProjectManifestSpec = {
  fileName: "pom.xml", referenceDepth: 8,
  parse(content): BuildBoundary {
    if (!wellFormedXml(content)) throw new Error("Invalid Maven boundary.");
    const modules: string[] = [], notices = new Set<string>();
    const visible = content.replace(/<profiles\b[\s\S]*?<\/profiles>/gu, (value) => " ".repeat(value.length));
    if (visible !== content) notices.add("unsupported_maven_profiles");
    for (const parent of elementSpans(visible, "modules")) {
      const body = visible.slice(parent.bodyStart, parent.bodyEnd);
      for (const span of elementSpans(body, "module")) {
        const value = childText(body.slice(span.start, span.end), "module");
        if (value && !/[$*?]/u.test(value) && localPath(".", value)) modules.push(value);
        else notices.add("unsupported_maven_module");
      }
    }
    return { modules, removed: [], notices: [...notices] };
  },
  references: (value, path) => (value as BuildBoundary).modules.map((directory) => posix.join(posix.dirname(path), directory, "pom.xml")),
  notices: (value) => (value as BuildBoundary).notices,
};
export const GRADLE_MANIFESTS: readonly ProjectManifestSpec[] = ["settings.gradle", "settings.gradle.kts"].map((fileName) => ({
  fileName,
  parse(content): BuildBoundary {
    const masked = maskBraceLanguage(content, "kotlin"), modules: string[] = [], notices = new Set<string>();
    let scanned = 0, depth = 0;
    for (const match of masked.matchAll(/^[ \t]*include\b/gmu)) {
      for (; scanned < match.index; scanned++) { if (masked[scanned] === "{") depth++; else if (masked[scanned] === "}") depth--; }
      if (depth !== 0) { notices.add("unsupported_gradle_include"); continue; }
      const tail = content.slice(match.index + match[0].length).split(/\r?\n/u)[0]!.trim();
      const args = tail.replace(/^\(/u, "").replace(/\)\s*;?$/u, "").replace(/\s*\/\/.*$/u, "");
      if (!/^(?:["'][A-Za-z0-9_:-]+["']\s*,?\s*)+$/u.test(args)) { notices.add("unsupported_gradle_include"); continue; }
      for (const value of args.matchAll(/["']([^"']+)["']/gu)) modules.push(value[1]!.replace(/^:/u, "").replace(/:/gu, "/"));
    }
    if (/\bprojectDir\b/u.test(masked)) { modules.length = 0; notices.add("unsupported_gradle_project_directory"); }
    return { modules, removed: [], notices: [...notices] };
  },
  notices: (value) => (value as BuildBoundary).notices,
}));

/** A build boundary identifies a declared reactor/workspace, not a classpath.
 * Identical packages in its modules remain ambiguous: dependencies are not executed. */
export function createJvmBoundary(structure: ProjectStructure | undefined): (source: string) => string | undefined {
  const parents = new Map<string, string>();
  const gradleMembers = new Map<string, string>();
  for (const manifest of structure?.manifests.values() ?? []) if (manifest.fileName.startsWith("settings.gradle") && !manifest.warning) {
    for (const module of (manifest.value as BuildBoundary).modules) {
      const directory = localPath(posix.dirname(manifest.path), module);
      if (directory && directory !== posix.dirname(manifest.path)) gradleMembers.set(directory, manifest.path);
    }
  }
  for (const manifest of structure?.manifests.values() ?? []) if (manifest.fileName === "pom.xml" && !manifest.warning) {
    for (const child of manifest.references ?? []) if (child !== manifest.path) parents.set(child, manifest.path);
  }
  const cache = new Map<string, string | undefined>();
  return (source) => {
    if (!structure) return;
    const directory = posix.dirname(source);
    if (cache.has(directory)) return cache.get(directory);
    const boundaries = ["pom.xml", "settings.gradle", "settings.gradle.kts"].flatMap((name) => {
      const manifest = nearestProjectManifest(structure, source, name); return manifest ? [manifest] : [];
    }).sort((a, b) => b.path.split("/").length - a.path.split("/").length);
    const boundary = boundaries[0];
    if (!boundary) { cache.set(directory, undefined); return; }
    let root = boundary.path;
    const visited = new Set<string>();
    while (!visited.has(root)) {
      const parent = parents.get(root) ?? (root.includes("settings.gradle") ? gradleMembers.get(posix.dirname(root)) : undefined);
      if (!parent) break;
      visited.add(root); root = parent;
    }
    // Invalid boundaries never expose their declarations to other projects.
    const result = boundary.warning ? `invalid:${boundary.path}` : root;
    cache.set(directory, result); return result;
  };
}

export function createCompileMembership(structure: ProjectStructure | undefined): (source: string) => boolean {
  const matchers = new Map<string, Array<(value: string) => boolean>>();
  const results = new Map<string, boolean>();
  return (source) => {
    if (!structure) return true;
    if (results.has(source)) return results.get(source)!;
    for (const name of ["*.csproj", "Directory.Build.props"]) {
      const manifest = nearestProjectManifest(structure, source, name);
      if (!manifest || manifest.warning) continue;
      let excludes = matchers.get(manifest.path);
      if (!excludes) {
        excludes = ((manifest.value as BuildBoundary).removed ?? []).map((pattern) => literalGlob(pattern, { pathSegments: true, questionMark: true }));
        matchers.set(manifest.path, excludes);
      }
      if (excludes.some((matches) => matches(posix.relative(posix.dirname(manifest.path), source)))) { results.set(source, false); return false; }
    }
    results.set(source, true); return true;
  };
}
