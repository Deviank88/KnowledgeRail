import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { uniqueImport } from "./paths.js";
import { pythonDeclaredNames, pythonManifest } from "./python-config.js";

export function createPythonImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths } = context;
  const declared = new Map<string, ReturnType<typeof pythonDeclaredNames>>();
  return (source, specifier) => {
    const match = /^(\.*)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?$/u.exec(specifier);
    if (!match || !specifier) return [];
    const level = match[1]!.length;
    const manifest = pythonManifest(context, source);
    if (manifest) {
      let names = declared.get(manifest.path);
      if (!names) { names = pythonDeclaredNames(context, manifest); declared.set(manifest.path, names); }
      let logical = match[2] ?? "";
      if (level) {
        const sourceNames = [...names].filter(([, files]) => files.has(source)).map(([name]) => name);
        if (sourceNames.length !== 1) return [];
        const parts = sourceNames[0]!.split(".");
        if (!/\/__init__\.pyi?$/u.test(`/${source}`)) parts.pop();
        if (level > parts.length) return [];
        logical = [...parts.slice(0, parts.length - level + 1), ...(logical ? [logical] : [])].join(".");
      }
      return uniqueImport(context, specifier, names.get(logical) ?? []);
    }
    const modulePath = (match[2] ?? "").replace(/\./gu, "/");
    const directory = posix.dirname(source);
    let packageRoot = directory;
    let packageDepth = 0;
    while (packageRoot !== "." && (paths.has(`${packageRoot}/__init__.py`) || paths.has(`${packageRoot}/__init__.pyi`))) {
      packageDepth++;
      packageRoot = posix.dirname(packageRoot);
    }
    // A regular-package chain supplies its root. A script outside a package
    // supplies only its own directory, never the repository or a guessed src/.
    let bases = [packageDepth ? packageRoot : directory];
    if (level > 0) {
      const parts = directory.split("/").filter((part) => part !== ".");
      if (level > packageDepth) return [];
      bases = [parts.slice(0, parts.length - level + 1).join("/")];
    }
    const candidates = [...new Set(bases)].flatMap((base) => {
      const parts = modulePath.split("/").filter(Boolean);
      for (let n = 1; n < parts.length; n++) {
        const packagePath = posix.join(base, ...parts.slice(0, n), "__init__");
        if (!paths.has(`${packagePath}.py`) && !paths.has(`${packagePath}.pyi`)) return [];
      }
      const resolved = posix.join(base, modulePath);
      return (modulePath ? [resolved, `${resolved}/__init__`] : [`${resolved}/__init__`])
        .flatMap((stem) => paths.has(`${stem}.py`) ? [`${stem}.py`]
          : paths.has(`${stem}.pyi`) ? [`${stem}.pyi`] : []);
    });
    return uniqueImport(context, specifier, candidates);
  };
}
