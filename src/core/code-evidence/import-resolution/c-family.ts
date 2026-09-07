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
        const config = cmake.value as CmakeConfig, base = posix.dirname(cmake.path);
        const targets = config.targets.filter((target) => target.files.some((file) => localPath(base, file) === source));
        // Each declared CMake root is a candidate; competing headers remain
        // ambiguous when the build tool's complete ordering is not modeled.
        groups = [...new Set([...config.directories, ...targets.flatMap((target) => target.directories)])]
          .flatMap((directory) => { const path = localPath(base, directory); return path ? [[path]] : []; });
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
