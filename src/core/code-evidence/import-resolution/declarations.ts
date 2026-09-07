import type { CodeImportContext, CodeImportResolver, KnowledgeFragment, ProjectManifestSpec } from "../types.js";
import { nearestProjectManifest } from "../project-structure.js";
import { addName, uniqueImport } from "./paths.js";

type DeclarationLanguage = "java" | "kotlin" | "csharp" | "php";
const EXTENSIONS: Record<DeclarationLanguage, RegExp> = {
  java: /\.(?:java|kt|kts)$/iu, kotlin: /\.(?:java|kt|kts)$/iu, csharp: /\.cs$/iu, php: /\.php$/iu,
};

/** Identity boundary only: no MSBuild evaluation or inferred Compile items. */
export const CSHARP_PROJECT_MANIFEST: ProjectManifestSpec = { fileName: "*.csproj", parse(content) {
  if (!/<Project(?:\s[^<>]*|)\s*(?:\/>|>[\s\S]*<\/Project>)/u.test(content)) throw new Error("Invalid project boundary.");
  return {};
} };

export function createDeclarationImportResolver(context: CodeImportContext, language: DeclarationLanguage): CodeImportResolver {
  const names = new Map<string, Set<string>>();
  const containers = new Map<string, Set<string>>();
  const declarations = new Map<string, KnowledgeFragment[]>();
  const separator = language === "php" ? "\\" : ".";
  const nameOf = (fragment: KnowledgeFragment) => fragment.qualifiedName.replace(/#/gu, ".");
  for (const [path, fragments] of context.fragmentsByPath) {
    if (!EXTENSIONS[language].test(path)) continue;
    for (const fragment of fragments) {
      if (!["class", "function", "method", "constant"].includes(fragment.kind)) continue;
      const name = nameOf(fragment);
      const key = language === "php" ? `${fragment.kind}:${name}` : name;
      addName(names, key, path);
      if (language === "csharp" && fragment.kind === "class") {
        const bucket = declarations.get(name) ?? [];
        bucket.push(fragment); declarations.set(name, bucket);
      }
      // Namespace imports describe a group. Type/member lookup still requires a
      // unique file, so duplicate declarations across source trees stay unresolved.
      if (language !== "csharp" || fragment.kind === "class") {
        const end = name.lastIndexOf(separator);
        if (end > 0) addName(containers, name.slice(0, end), path);
      }
    }
  }
  const resolveName = (name: string, key = name): string[] => {
    const matches = names.get(key);
    if (matches) {
      if (language === "csharp" && matches.size > 1) {
        const parts = declarations.get(name) ?? [];
        const signatures = parts.map((part) => {
          const declaration = /\bpartial\s+(class|interface|struct|record(?:\s+(?:class|struct))?)\s+\w+\s*(<[^<>]*>)?/u.exec(part.definition);
          return declaration && `${declaration[1]}:${declaration[2]?.split(",").length ?? 0}`;
        });
        const owners = parts.map((part) => context.structure && nearestProjectManifest(context.structure, part.path, "*.csproj"));
        if (new Set(parts.map((part) => part.path)).size === matches.size && signatures.length && signatures.every(Boolean) &&
            new Set(signatures).size === 1 && !owners.some((owner) => owner?.warning) && new Set(owners.map((owner) => owner?.path)).size === 1) return [...matches];
      }
      return uniqueImport(context, name, matches);
    }
    if (language === "csharp" && containers.has(name)) return [...containers.get(name)!];
    return uniqueImport(context, name, []);
  };
  return (source, raw) => {
    if (language === "java") {
      const statements = context.fragmentsByPath.get(source)?.find((fragment) => fragment.kind === "module" && fragment.qualifiedName === source)?.importStatements;
      if (statements?.some((entry) => entry.specifier === raw && entry.kind === "static")) {
        return resolveName(raw.slice(0, raw.lastIndexOf(".")));
      }
    }
    if (language === "php") {
      // The extractor retains grouped clauses and aliases as a single specifier.
      const leadingKind = /^(function|const)\s+/u.exec(raw)?.[1];
      const clause = raw.replace(/^(?:function|const)\s+/u, "");
      const group = /^(.*?)\{([^{}]*)\}$/u.exec(clause);
      const parts = (group ? group[2]! : clause).split(",");
      return [...new Set(parts.flatMap((part) => {
        const kind = /^(function|const)\s+/u.exec(part.trim())?.[1] ?? leadingKind;
        const name = `${group?.[1] ?? ""}${part.trim().replace(/^(?:function|const)\s+/u, "").replace(/\s+as\s+\w+$/iu, "")}`.replace(/^\\/u, "");
        return /^[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*$/u.test(name) ? resolveName(name, `${kind === "const" ? "constant" : kind ?? "class"}:${name}`) : [];
      }))];
    }
    const name = raw.replace(/\s+as\s+\w+$/u, "");
    if (language !== "csharp" && name.endsWith(".*")) return [...(containers.get(name.slice(0, -2)) ?? [])];
    return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(name) ? resolveName(name) : [];
  };
}
