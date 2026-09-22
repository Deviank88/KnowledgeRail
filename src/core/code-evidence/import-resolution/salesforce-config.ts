import { posix } from "node:path";
import { parseManifestJson } from "../manifest-json.js";
import { childText, wellFormedXml } from "../manifest-xml.js";
import { nearestProjectManifest } from "../project-structure.js";
import type { ProjectManifestSpec, ProjectStructure, KnowledgeFragment } from "../types.js";
import { localPath } from "./paths.js";

export interface SalesforceConfig { packages: string[]; namespace?: string; notices: string[] }
export const SALESFORCE_MANIFEST: ProjectManifestSpec = {
  fileName: "sfdx-project.json",
  parse(content): SalesforceConfig {
    const value = parseManifestJson(content) as Record<string, unknown>;
    if (!value || typeof value !== "object" || !Array.isArray(value.packageDirectories)) throw new Error("Invalid Salesforce manifest.");
    const packages: string[] = [], notices = new Set<string>();
    for (const entry of value.packageDirectories) {
      if (!entry || typeof entry.path !== "string" || !localPath(".", entry.path) || /[*?]/u.test(entry.path)) {
        notices.add("unsupported_salesforce_package_directory"); continue;
      }
      packages.push(entry.path);
    }
    if (value.namespace !== undefined && (typeof value.namespace !== "string" || !/^(?:[A-Za-z]\w*)?$/u.test(value.namespace))) {
      throw new Error("Invalid Salesforce namespace.");
    }
    return { packages: [...new Set(packages)], namespace: value.namespace as string | undefined, notices: [...notices] };
  },
  notices: (value) => (value as SalesforceConfig).notices,
};

export const APEX_STATUS_MANIFEST: ProjectManifestSpec = {
  fileName: "apex-status",
  companion: { extensions: [".cls", ".trigger"], suffix: "-meta.xml" },
  parse(content) {
    if (!wellFormedXml(content)) throw new Error("Invalid Apex metadata.");
    const status = childText(content, "status");
    if (status !== undefined && !["Active", "Inactive", "Deleted"].includes(status)) throw new Error("Unsupported Apex status.");
    return status ? { status } : {};
  },
};

/** A malformed/unsupported boundary remains a boundary; it never leaks names
 * into its parent project. Without a manifest, preserve the legacy inventory. */
export function salesforceOwner(structure: ProjectStructure | undefined, source: string): string | undefined {
  if (!structure) return "";
  const manifest = nearestProjectManifest(structure, source, SALESFORCE_MANIFEST.fileName);
  if (!manifest) return "";
  if (manifest.warning) return;
  const config = manifest.value as SalesforceConfig;
  const root = posix.dirname(manifest.path);
  if (!config.packages.some((entry) => {
    const base = localPath(root, entry);
    return base !== undefined && (base === "." || source.startsWith(base + "/"));
  })) return;
  return manifest.path;
}

export function applyApexStatuses(fragments: readonly KnowledgeFragment[], structure: ProjectStructure): KnowledgeFragment[] {
  const extensions = APEX_STATUS_MANIFEST.companion!.extensions;
  return fragments.map((fragment) => {
    const path = fragment.path.toLowerCase();
    if (!extensions.some((extension) => path.endsWith(extension))) return fragment;
    const value = structure.manifests.get(fragment.path + "-meta.xml")?.value as { status?: KnowledgeFragment["deploymentStatus"] } | undefined;
    if (value?.status && ["Active", "Inactive", "Deleted"].includes(value.status)) return { ...fragment, deploymentStatus: value.status };
    if (fragment.deploymentStatus !== undefined) {
      const { deploymentStatus: _status, ...source } = fragment;
      return source;
    }
    return fragment;
  });
}
