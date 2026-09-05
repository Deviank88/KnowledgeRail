import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { localPath, uniqueImport } from "./paths.js";

export function createCImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths } = context;
  return (source, specifier) => {
    if (!/\.(?:h|hpp|hh|c|cpp|cc|cxx)$/iu.test(specifier)) return [];
    const candidates = [posix.dirname(source), "."].flatMap((base) => {
      const path = localPath(base, specifier);
      return path ? [path] : [];
    });
    // An include points to the literal file; never manufacture its implementation twin.
    return uniqueImport(context, specifier, candidates.filter((path) => paths.has(path)));
  };
}
