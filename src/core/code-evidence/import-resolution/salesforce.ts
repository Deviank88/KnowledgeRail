import type { CodeImportContext, CodeImportResolver } from "../types.js";
import { addName, uniqueImport } from "./paths.js";
import { salesforceOwner } from "./salesforce-config.js";

interface SalesforceInventory {
  structure: CodeImportContext["structure"];
  paths: CodeImportContext["paths"];
  imports: Map<string, Set<string>>;
  references: Map<string, Set<string>>;
  owners: Map<string, string | undefined>;
}

// The key belongs only to one reference-index construction. Values contain
// strings, never fragments, contexts or diagnostic callbacks. Nothing survives
// through the generation's ordinal postings after resolver construction ends.
const inventories = new WeakMap<CodeImportContext["fragmentsByPath"], SalesforceInventory>();

function inventory(context: CodeImportContext): SalesforceInventory {
  const cached = inventories.get(context.fragmentsByPath);
  if (cached?.structure === context.structure && cached?.paths === context.paths) return cached;
  const { paths, fragmentsByPath } = context;
  const names = new Map<string, Set<string>>();
  const references = new Map<string, Set<string>>();
  const owners = new Map<string, string | undefined>();
  for (const [path, fragments] of fragmentsByPath) {
    owners.set(path, salesforceOwner(context.structure, path));
    for (const fragment of fragments) if (fragment.kind === "class") {
      if (path.endsWith(".cls")) addName(references, fragment.qualifiedName, path);
      else if (path.endsWith(".object-meta.xml")) addName(references, `schema:${fragment.qualifiedName}`, path);
    }
  }
  for (const path of paths) {
    if (!owners.has(path)) owners.set(path, salesforceOwner(context.structure, path));
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
  const prepared = { structure: context.structure, paths, imports: names, references, owners };
  inventories.set(fragmentsByPath, prepared);
  return prepared;
}

/** Salesforce virtual specifiers refer to declarations, not npm packages. */
export function createSalesforceImportResolver(context: CodeImportContext): CodeImportResolver {
  const { imports: names, owners } = inventory(context);
  return (source, specifier) => {
    if (!context.paths.has(source)) return [];
    const owner = owners.get(source);
    if (owner === undefined) return [];
    const matches = names.get(specifier);
    return uniqueImport(context, specifier, [...(matches ?? [])].filter((path) => owners.get(path) === owner));
  };
}

export function createSalesforceReferenceResolver(context: CodeImportContext): CodeImportResolver {
  const { references: names, owners } = inventory(context);
  return (source, name) => {
    if (!context.fragmentsByPath.has(source)) return [];
    const owner = owners.get(source);
    return owner === undefined ? [] : uniqueImport(context, name, [...(names.get(name) ?? [])].filter((path) => owners.get(path) === owner));
  };
}
