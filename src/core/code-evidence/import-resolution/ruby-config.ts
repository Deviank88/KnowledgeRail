import { maskRubySourceDetailed } from "../keyword-block-engine.js";
import type { ProjectManifestSpec } from "../types.js";
import { localPath } from "./paths.js";

export interface GemspecConfig { requirePaths: string[]; notices: string[] }

export const GEMSPEC_MANIFEST: ProjectManifestSpec = {
  fileName: "*.gemspec",
  parse(content): GemspecConfig {
    const { masked, comments } = maskRubySourceDetailed(content);
    const specification = /\bGem::Specification\.new\s*(?:do|\{)\s*\|\s*(\w+)\s*\|/u.exec(masked);
    const receiver = specification?.[1];
    if (!receiver) return { requirePaths: [], notices: ["unsupported_gemspec"] };
    const assignments = [...masked.matchAll(/\b(\w+)\.require_paths\s*(=|\+=|<<)/gu)].filter((match) => match[1] === receiver);
    const accesses = [...masked.matchAll(/\b(\w+)\.require_paths\b/gu)].filter((match) => match[1] === receiver);
    // RubyGems declares this default on Gem::Specification itself. A repository
    // without a gemspec still has no declared load path.
    if (!assignments.length) return accesses.length ? { requirePaths: [], notices: ["dynamic_require_paths"] } : { requirePaths: ["lib"], notices: [] };
    const assignment = assignments[0]!;
    if (assignments.length !== 1 || assignment[2] !== "=") return { requirePaths: [], notices: ["dynamic_require_paths"] };
    const frames: number[] = [];
    for (const token of masked.slice(0, assignment.index).matchAll(/\b(?:if|unless|case|while|until|for|def|class|module|do|end)\b/gu)) {
      if (masked[token.index - 1] === "." || masked[token.index - 1] === ":") continue;
      if (token[0] === "end") frames.pop(); else frames.push(token.index);
    }
    if (accesses.length !== 1 || frames.some((offset) => offset < specification!.index || offset >= specification!.index + specification![0].length)) return { requirePaths: [], notices: ["dynamic_require_paths"] };
    // Remove comments only; string values and offsets retain their literal form.
    let clean = "", offset = 0;
    for (const comment of comments) { clean += content.slice(offset, comment.start) + content.slice(comment.start, comment.end).replace(/[^\r\n]/gu, " "); offset = comment.end; }
    clean += content.slice(offset);
    const tail = clean.slice(assignment.index + assignment[0].length);
    const literal = /^\s*(\[\s*(?:(?:'[^'\\]*'|"[^"\\#]*")(?:\s*,\s*(?:'[^'\\]*'|"[^"\\#]*"))*\s*,?)?\s*\]|%w\[[^\]\\]*\]|%w\([^\)\\]*\))/u.exec(tail);
    if (!literal || !/^[ \t]*(?:#[^\n]*)?(?:\r?\n|;|$)/u.test(tail.slice(literal[0].length))) return { requirePaths: [], notices: ["dynamic_require_paths"] };
    const value = literal[1]!;
    const requirePaths = value.startsWith("%w") ? value.slice(3, -1).trim().split(/\s+/u).filter(Boolean)
      : [...value.matchAll(/(['"])(.*?)\1/gu)].map((match) => match[2]!);
    if (requirePaths.some((path) => !path || localPath(".", path) === undefined) || requirePaths.length > 32) throw new Error("Invalid require_paths.");
    return { requirePaths, notices: [] };
  },
  notices: (value) => (value as GemspecConfig).notices,
};
