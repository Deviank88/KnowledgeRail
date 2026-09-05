import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { uniqueImport } from "./paths.js";

export function createPythonImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths } = context;
  return (source, specifier) => {
    const match = /^(\.*)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?$/u.exec(specifier);
    if (!match || !specifier) return [];
    const level = match[1]!.length;
    const modulePath = (match[2] ?? "").replace(/\./gu, "/");
    const directory = posix.dirname(source);
    let packageRoot = directory;
    let packageDepth = 0;
    while (packageRoot !== "." && (paths.has(`${packageRoot}/__init__.py`) || paths.has(`${packageRoot}/__init__.pyi`))) {
      packageDepth++;
      packageRoot = posix.dirname(packageRoot);
    }
    // A verified regular-package chain supplies its source root without exposing
    // every project's basename globally. Keep root/script-directory compatibility.
    let bases = [".", directory, ...(packageDepth ? [packageRoot] : [])];
    if (level > 0) {
      const parts = directory.split("/").filter((part) => part !== ".");
      if (level > (packageDepth || parts.length)) return [];
      bases = [parts.slice(0, parts.length - level + 1).join("/")];
    }
    const candidates = [...new Set(bases)].flatMap((base) => {
      const resolved = posix.join(base, modulePath);
      return (modulePath ? [resolved, `${resolved}/__init__`] : [`${resolved}/__init__`])
        .flatMap((stem) => paths.has(`${stem}.py`) ? [`${stem}.py`]
          : paths.has(`${stem}.pyi`) ? [`${stem}.pyi`] : []);
    });
    return uniqueImport(context, specifier, candidates);
  };
}
