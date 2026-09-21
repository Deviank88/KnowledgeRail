import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { addName, uniqueImport } from "./paths.js";
import { salesforceOwner } from "./salesforce-config.js";

/** Salesforce virtual specifiers refer to declarations, not npm packages. */
export function createSalesforceImportResolver(context: CodeImportContext): CodeImportResolver {
  const { paths, fragmentsByPath } = context;
  const names = new Map<string, Set<string>>();
  const owners = new Map<string, string | undefined>();
  for (const path of paths) {
    owners.set(path, salesforceOwner(context.structure, path));
    if (path.endsWith(".cls")) {
      for (const fragment of fragmentsByPath.get(path) ?? []) {
        if (fragment.kind === "method") addName(names, `@salesforce/apex/${fragment.qualifiedName}`, path);
      }
    } else if (/\.(?:object|field)-meta\.xml$/iu.test(path)) {
      for (const fragment of fragmentsByPath.get(path) ?? []) {
        if (fragment.kind !== "module" && fragment.kind !== "comment") addName(names, `@salesforce/schema/${fragment.qualifiedName}`, path);
      }
    } else if (/\.(?:labels|resource|messageChannel)-meta\.xml$/iu.test(path)) {
      for (const fragment of fragmentsByPath.get(path) ?? []) {
        if (fragment.kind === "module" || fragment.kind === "comment") continue;
        const name = fragment.qualifiedName;
        if (path.endsWith(".labels-meta.xml") && !name.includes("__")) addName(names, `@salesforce/label/c.${name}`, path);
        else if (path.endsWith(".resource-meta.xml")) addName(names, `@salesforce/resourceUrl/${name}`, path);
        else if (path.endsWith(".messageChannel-meta.xml")) addName(names, `@salesforce/messageChannel/${name}__c`, path);
      }
    }
    const component = /(?:^|\/)lwc\/([^/]+)\/\1\.js$/u.exec(path);
    if (component) addName(names, `c/${component[1]}`, path);
  }
  return (source, specifier) => {
    const owner = owners.get(source);
    if (owner === undefined) return [];
    const matches = names.get(specifier);
    return uniqueImport(context, specifier, [...(matches ?? [])].filter((path) => owners.get(path) === owner));
  };
}

export function createSalesforceReferenceResolver(context: CodeImportContext): CodeImportResolver {
  const names = new Map<string, Set<string>>();
  const owners = new Map<string, string | undefined>();
  for (const [path, fragments] of context.fragmentsByPath) {
    owners.set(path, salesforceOwner(context.structure, path));
    for (const fragment of fragments) if (fragment.kind === "class") {
      if (path.endsWith(".cls")) addName(names, fragment.qualifiedName, path);
      else if (path.endsWith(".object-meta.xml")) addName(names, `schema:${fragment.qualifiedName}`, path);
    }
  }
  return (source, name) => {
    const owner = owners.get(source);
    return owner === undefined ? [] : uniqueImport(context, name, [...(names.get(name) ?? [])].filter((path) => owners.get(path) === owner));
  };
}
