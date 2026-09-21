import { posix } from "node:path";
import { manifestStrings, manifestTable, parseManifestToml } from "../manifest-toml.js";
import type { ProjectManifestSpec } from "../types.js";
import { localPath } from "./paths.js";
import { dependencyNames } from "./classification.js";

export interface CargoConfig { name?: string; roots: string[]; members: string[]; notices: string[]; dependencies: string[] }
export const CARGO_MANIFEST: ProjectManifestSpec = { fileName: "Cargo.toml", parse(content) {
  const root = parseManifestToml(content, [["package", "name"], ["lib", "path"], ["bin", "path"]]);
  const pkg = manifestTable(root.package), lib = manifestTable(root.lib);
  const name = pkg.name;
  if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z_][\w-]*$/u.test(name))) throw new Error("Invalid Cargo package name.");
  const members: string[] = [], notices = new Set<string>();
  try {
    const workspace = manifestTable(parseManifestToml(content, [["workspace", "members"]]).workspace);
    for (const member of manifestStrings(workspace.members) ?? []) {
      if (!localPath(".", member)) notices.add("invalid_cargo_workspace_member");
      else if (/[{}\[\]]/u.test(member) || member.includes("**")) notices.add("unsupported_cargo_workspace_glob");
      else if (members.length === 32) notices.add("cargo_workspace_member_limit");
      else if (!members.includes(member)) members.push(member);
    }
  } catch { notices.add("invalid_cargo_workspace_members"); }
  const roots: string[] = [];
  if (name !== undefined) {
    if (lib.path !== undefined && typeof lib.path !== "string") throw new Error("Invalid Cargo lib path.");
    roots.push(typeof lib.path === "string" ? lib.path : "src/lib.rs");
    if (root.bin !== undefined && !Array.isArray(root.bin)) throw new Error("Invalid Cargo bin targets.");
    const bins = (root.bin ?? []) as unknown[];
    for (const value of bins) {
      const bin = manifestTable(value);
      if (typeof bin.path !== "string") throw new Error("Explicit Cargo bin targets require literal paths.");
      roots.push(bin.path);
    }
    if (!bins.length) roots.push("src/main.rs");
  }
  if (roots.some((path) => !localPath(".", path) || !path.endsWith(".rs"))) throw new Error("Invalid Cargo target path.");
  const dependencies: string[] = [];
  for (const fields of [["dependencies"], ["dev-dependencies"], ["workspace", "dependencies"]]) {
    try {
      const projected = parseManifestToml(content, [fields]);
      const value = fields.reduce<unknown>((value, key) => manifestTable(value)[key], projected);
      dependencies.push(...dependencyNames(value).map((name) => name.replace(/-/gu, "_")));
    } catch { notices.add("unsupported_cargo_dependencies"); }
  }
  return { ...(typeof name === "string" ? { name: name.replace(/-/gu, "_") } : {}), roots, members, notices: [...notices], dependencies } satisfies CargoConfig;
}, notices(value) {
  return (value as CargoConfig).notices;
}, references(value, path) {
  return (value as CargoConfig).members.filter((member) => !/[*?]/u.test(member)).map((member) => {
    const target = localPath(posix.dirname(path), posix.join(member, "Cargo.toml"));
    if (!target) throw new Error("Cargo member escapes repository.");
    return target;
  });
}, referencePatterns(value, path) {
  return (value as CargoConfig).members.filter((member) => /[*?]/u.test(member)).map((member) => posix.join(posix.dirname(path), member, "Cargo.toml"));
} };
