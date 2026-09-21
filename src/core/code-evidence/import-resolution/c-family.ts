import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { localPath, uniqueImport } from "./paths.js";
import { nearestProjectManifest } from "../project-structure.js";
import type { CompileConfig, CmakeConfig } from "./c-config.js";

export function createCImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths } = context;
  const configurations = new Map<string, string[][]>();
  const directories = (source: string): string[][] => {
    const cached = configurations.get(source); if (cached) return cached;
    const compile = context.structure && nearestProjectManifest(context.structure, source, "compile_commands.json");
    let groups: string[][] = [];
    if (compile) {
      if (!compile.warning) groups = (compile.value as CompileConfig).entries.filter((entry) => entry.file === source).map((entry) => entry.directories);
    } else {
      const cmake = context.structure && nearestProjectManifest(context.structure, source, "CMakeLists.txt");
      if (cmake && !cmake.warning) {
        const lineage = [cmake];
        let child = cmake;
        while (posix.dirname(child.path) !== ".") {
          const parent = nearestProjectManifest(context.structure!, child.path, "CMakeLists.txt");
          // Start above the current directory; the nearest lookup includes self.
          const upper = nearestProjectManifest(context.structure!, posix.dirname(child.path), "CMakeLists.txt");
          if (!upper || upper === parent || upper.warning || !upper.references?.includes(child.path)) break;
          lineage.unshift(upper); child = upper;
        }
        const root = posix.dirname(lineage[0]!.path);
        const declaredPath = (base: string, value: string) => {
          const prefix = /^\$\{(?:PROJECT_SOURCE_DIR|CMAKE_SOURCE_DIR)\}\/?/u.exec(value);
          return prefix ? localPath(root, value.slice(prefix[0].length)) : localPath(base, value);
        };
        const roots = new Set<string>();
        for (const manifest of lineage) {
          const config = manifest.value as CmakeConfig, base = posix.dirname(manifest.path);
          if (config.blockedGlobal) { groups = []; configurations.set(source, groups); return groups; }
          const targets = config.targets.filter((target) => target.files.some((file) => declaredPath(base, file) === source));
          if (targets.some((target) => target.blocked)) { groups = []; configurations.set(source, groups); return groups; }
          for (const directory of [...config.directories, ...targets.flatMap((target) => target.directories)]) {
            const path = declaredPath(base, directory); if (path) roots.add(path);
          }
        }
        // Each declared CMake root is a candidate; competing headers remain
        // ambiguous when the build tool's complete ordering is not modeled.
        groups = [...roots].map((path) => [path]);
      }
    }
    configurations.set(source, groups); return groups;
  };
  return (source, specifier) => {
    const statements = context.fragmentsByPath.get(source)?.find((fragment) => fragment.kind === "module" && fragment.qualifiedName === source)?.importStatements;
    const kinds = statements?.filter((entry) => entry.specifier === specifier).map((entry) => entry.kind) ?? [];
    if (!kinds.includes("quote")) return [];
    if (kinds.includes("angle")) context.reportIssue?.({ status: "unresolved", matchedName: `<${specifier}>` });
    const path = localPath(posix.dirname(source), specifier);
    // An include points to the literal file; never manufacture its implementation twin.
    if (path && paths.has(path)) return [path];
    const matches = new Set<string>();
    // Stop at the first match within each configuration's ordered roots only.
    // Continue with other configurations so competing headers remain ambiguous.
    for (const roots of directories(source)) for (const root of roots) {
      const target = localPath(root, specifier);
      if (target && paths.has(target)) { matches.add(target); break; }
    }
    return uniqueImport(context, specifier, matches);
  };
}
