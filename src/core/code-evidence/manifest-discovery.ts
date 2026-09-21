import * as fs from "node:fs/promises";
import { posix, relative, isAbsolute } from "node:path";
import { safeResolveWithin } from "../paths.js";
import { literalGlob } from "./literal-glob.js";

/** Bounded directory enumeration shared by declared workspace formats. Never
 * follows symlinks, package installations, or executable build descriptions. */
export async function discoverManifestPatterns(repositoryRoot: string, patterns: readonly string[]): Promise<string[]> {
  if (patterns.length > 32) throw new Error("manifest_discovery_limit");
  const root = await fs.realpath(repositoryRoot), results = new Set<string>();
  let entries = 0;
  for (const pattern of patterns.filter((value) => !value.startsWith("!"))) {
    if (pattern.startsWith("/") || pattern.split("/").includes("..") || /[\\\0{}\[\]]/u.test(pattern)) throw new Error("Invalid manifest pattern.");
    const parts = pattern.split("/");
    if (parts.length > 16 || parts.includes("**")) throw new Error("manifest_discovery_limit");
    const pending = [{ directory: ".", offset: 0 }];
    const matchers = parts.map((part) => literalGlob(part, { questionMark: true, pathSegments: true }));
    while (pending.length) {
      const { directory, offset } = pending.pop()!;
      const part = parts[offset]!;
      if (!part.includes("*") && !part.includes("?")) {
        const target = posix.join(directory, part);
        if (offset === parts.length - 1) results.add(target);
        else pending.push({ directory: target, offset: offset + 1 });
      } else {
        try {
          const absolute = directory === "." ? root : safeResolveWithin(repositoryRoot, directory);
          const real = await fs.realpath(absolute), within = relative(root, real);
          if (within === ".." || within.startsWith("../") || within.startsWith("..\\") || isAbsolute(within)) throw new Error("outside_repository");
          const handle = await fs.opendir(absolute);
          for await (const entry of handle) {
            if (++entries > 16_384) throw new Error("manifest_discovery_limit");
            if (entry.isSymbolicLink() || ["node_modules", ".git", "vendor", ".venv"].includes(entry.name) || !matchers[offset]!(entry.name)) continue;
            const target = posix.join(directory, entry.name);
            if (offset === parts.length - 1 && entry.isFile()) results.add(target);
            else if (offset < parts.length - 1 && entry.isDirectory()) pending.push({ directory: target, offset: offset + 1 });
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (results.size > 32 || pending.length > 256) throw new Error("manifest_discovery_limit");
    }
  }
  const excluded = patterns.filter((value) => value.startsWith("!")).map((value) => literalGlob(value.slice(1), { pathSegments: true, questionMark: true }));
  return [...results].filter((value) => !excluded.some((matches) => matches(value))).sort();
}
