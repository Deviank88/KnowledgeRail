import type { CodeImportContext, CodeImportResolver, KnowledgeFragment } from "../types.js";
import { addName, uniqueImport } from "./paths.js";

type DeclarationLanguage = "java" | "kotlin" | "csharp" | "php";
const EXTENSIONS: Record<DeclarationLanguage, RegExp> = {
  java: /\.java$/iu, kotlin: /\.(?:kt|kts)$/iu, csharp: /\.cs$/iu, php: /\.php$/iu,
};

export function createDeclarationImportResolver(context: CodeImportContext, language: DeclarationLanguage): CodeImportResolver {
  const names = new Map<string, Set<string>>();
  const containers = new Map<string, Set<string>>();
  const separator = language === "php" ? "\\" : ".";
  const nameOf = (fragment: KnowledgeFragment) => fragment.qualifiedName.replace(/#/gu, ".");
  for (const [path, fragments] of context.fragmentsByPath) {
    if (!EXTENSIONS[language].test(path)) continue;
    for (const fragment of fragments) {
      if (!["class", "function", "method"].includes(fragment.kind)) continue;
      const name = nameOf(fragment);
      addName(names, name, path);
      // Namespace imports describe a group. Type/member lookup still requires a
      // unique file, so duplicate declarations across source trees stay unresolved.
      if (language !== "csharp" || fragment.kind === "class") {
        const end = name.lastIndexOf(separator);
        if (end > 0) addName(containers, name.slice(0, end), path);
      }
    }
  }
  const resolveName = (name: string): string[] => {
    const matches = names.get(name);
    if (matches) return uniqueImport(context, name, matches);
    if (language === "csharp" && containers.has(name)) return [...containers.get(name)!];
    return uniqueImport(context, name, []);
  };
  return (_source, raw) => {
    if (language === "php") {
      // The extractor retains grouped clauses and aliases as a single specifier.
      const clause = raw.replace(/^(?:function|const)\s+/u, "");
      const group = /^(.*?)\{([^{}]*)\}$/u.exec(clause);
      const parts = (group ? group[2]! : clause).split(",");
      return [...new Set(parts.flatMap((part) => {
        const name = `${group?.[1] ?? ""}${part.trim().replace(/\s+as\s+\w+$/iu, "")}`.replace(/^\\/u, "");
        return /^[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*$/u.test(name) ? resolveName(name) : [];
      }))];
    }
    const name = raw.replace(/\s+as\s+\w+$/u, "");
    if (language !== "csharp" && name.endsWith(".*")) return [...(containers.get(name.slice(0, -2)) ?? [])];
    return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(name) ? resolveName(name) : [];
  };
}
