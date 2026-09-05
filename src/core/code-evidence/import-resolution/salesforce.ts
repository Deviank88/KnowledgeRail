import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { addName, uniqueImport } from "./paths.js";

/** Salesforce virtual specifiers refer to declarations, not npm packages. */
export function createSalesforceImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths, fragmentsByPath } = context;
  const names = new Map<string, Set<string>>();
  for (const path of paths) {
    if (path.endsWith(".cls")) {
      for (const fragment of fragmentsByPath.get(path) ?? []) {
        if (fragment.kind === "method") addName(names, `@salesforce/apex/${fragment.qualifiedName}`, path);
      }
    } else if (/\.(?:object|field)-meta\.xml$/iu.test(path)) {
      for (const fragment of fragmentsByPath.get(path) ?? []) {
        if (fragment.kind !== "module" && fragment.kind !== "comment") addName(names, `@salesforce/schema/${fragment.qualifiedName}`, path);
      }
    }
    const component = /(?:^|\/)lwc\/([^/]+)\/\1\.js$/u.exec(path);
    if (component) addName(names, `c/${component[1]}`, path);
  }
  return (_source, specifier) => {
    const matches = names.get(specifier);
    return uniqueImport(context, specifier, matches ?? []);
  };
}
