import { posix } from "node:path";
import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { localPath, uniqueImport } from "./paths.js";
import { createSalesforceImportResolver } from "./salesforce.js";
import { importConfig, createJavaScriptConfigSelector, type JavaScriptImportConfig } from "./javascript-config.js";
import { createPackageImportResolver } from "./javascript-packages.js";

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];
const SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"],
};

export function createJavaScriptImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths } = context;
  let salesforce: CodeImportResolver | undefined;
  let packages: CodeImportResolver | undefined;
  const configs = new Map<string, JavaScriptImportConfig | undefined>();
  const directories = new Map<string, JavaScriptImportConfig | undefined>();
  const selectConfig = context.structure ? createJavaScriptConfigSelector(context.structure) : undefined;
  const configFor = (source: string): JavaScriptImportConfig | undefined => {
    if (!context.structure?.manifests.size) return;
    if (directories.has(source)) return directories.get(source);
    const manifest = selectConfig?.(source);
    if (manifest?.warning === "ambiguous_tsconfig_ownership") return;
    if (manifest && !configs.has(manifest.path)) configs.set(manifest.path, importConfig(manifest, context.structure));
    const config = manifest ? configs.get(manifest.path) : undefined;
    directories.set(source, config);
    return config;
  };
  // Preserve ambiguity internally: an ambiguous first paths target must not
  // silently fall through to a later target and create a false definite edge.
  const candidates = (base: string, value: string): string[] => {
    const resolved = localPath(base, value);
    if (!resolved) return [];
    const extension = posix.extname(resolved).toLowerCase();
    if (extension && !EXTENSIONS.includes(extension)) return [];
    if (extension && paths.has(resolved)) return [resolved];
    return (extension
      ? (SUBSTITUTIONS[extension] ?? []).map((suffix) => resolved.slice(0, -extension.length) + suffix)
      : EXTENSIONS.flatMap((suffix) => [resolved + suffix, `${resolved}/index${suffix}`])).filter((candidate) => paths.has(candidate));
  };
  return (source, specifier) => {
    if (/^\.{1,2}\//u.test(specifier)) {
      const found = candidates(posix.dirname(source), specifier);
      return uniqueImport(context, specifier, found);
    }
    if (specifier.startsWith("node:")) return [];
    if (selectConfig?.(source)?.warning === "ambiguous_tsconfig_ownership") {
      context.reportIssue?.({ status: "ambiguous", reason: "competing_patterns", matchedName: specifier }); return [];
    }
    const config = configFor(source);
    if (config) {
      let targets = config.exact.get(specifier);
      let wildcard: string | undefined;
      if (!targets) {
        let prefixLength = -1;
        for (const pattern of config.patterns) {
          if (prefixLength > pattern.prefix.length) break;
          if (!specifier.startsWith(pattern.prefix) || !specifier.endsWith(pattern.suffix) || specifier.length < pattern.prefix.length + pattern.suffix.length) continue;
          if (targets) {
            const competing = config.patterns.filter((other) => other.prefix.length === prefixLength &&
              specifier.startsWith(other.prefix) && specifier.endsWith(other.suffix) && specifier.length >= other.prefix.length + other.suffix.length);
            context.reportIssue?.({ status: "ambiguous", reason: "competing_patterns",
              matchedName: competing.map((other) => `${other.prefix}*${other.suffix}`).join(", "),
              candidates: competing.flatMap((other) => other.targets.flatMap((target) => candidates(config.pathsBase,
                target.replace("*", () => specifier.slice(other.prefix.length, specifier.length - other.suffix.length))))) });
            return []; // Equally specific patterns: no arbitrary edge.
          }
          targets = pattern.targets;
          prefixLength = pattern.prefix.length;
          wildcard = specifier.slice(pattern.prefix.length, specifier.length - pattern.suffix.length);
        }
      }
      for (const target of targets ?? []) {
        const found = candidates(config.pathsBase, wildcard === undefined ? target : target.replace("*", () => wildcard!));
        if (found.length > 0) return uniqueImport(context, specifier, found);
      }
      if (config.baseUrl !== undefined) {
        const found = candidates(config.baseUrl, specifier);
        if (found.length > 0) return uniqueImport(context, specifier, found);
      }
      if (targets) return [];
    }
    if (specifier.startsWith("@salesforce/") || specifier.startsWith("c/")) {
      return (salesforce ??= createSalesforceImportResolver(context))(source, specifier);
    }
    return (packages ??= createPackageImportResolver(context, candidates))(source, specifier);
  };
}
