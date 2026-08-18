import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import fg from "fast-glob";
import { z } from "zod";
import { atomicWriteText, unlinkWithLock } from "../core/fs-service.js";
import { withKeyedLock, withWikiFileLock } from "../core/lock-service.js";
import { readWikiResource } from "../context/resource-reader.js";
import { formatGraphQueryResult } from "../core/graph-index.js";
import { retrieveWikiHybrid } from "../core/hybrid-retrieval.js";
import {
  isExternalLinkTarget,
  MARKDOWN_LINK_RE,
  resolveWikiLinkName,
  splitAnchor,
  WIKI_LINK_RE,
  wikiLinkNameVariants,
  wikiLinkTargets,
} from "../core/link-resolution.js";
import { invalidateManifestEntries } from "../core/manifest-service.js";
import {
  docsDir,
  relativePathFrom,
  resolveRealWithin,
  safeResolveWithin,
  wikiDir,
} from "../core/paths.js";
import { searchRetrievalIndex } from "../core/retrieval-index.js";
import { buildTraceabilityText } from "../core/traceability-service.js";
import {
  applyWikiMigration,
  formatMigrationPlan,
  planWikiMigration,
  rollbackWikiMigration,
} from "../core/migration-service.js";
import {
  ensureDir,
  frontmatterString,
  isNodeError,
  readFileSafe,
  type Frontmatter,
} from "../core/utils.js";
import {
  appendLog,
  listWikiPageMetadata,
} from "../core/wiki-index-service.js";
import { ensureWikiStructure } from "../core/wiki-structure-service.js";
import { toolName, type ProtocolEra } from "../mcp/tool-names.js";
import {
  formatValidationIssues,
  hasErrors,
  validateWikiPageContent,
} from "../core/wiki-validation.js";
import { errorResult, finalizePageMutation, textResult } from "./helpers.js";

const CONTROL_FILES = ["SCHEMA.md", "index.md", "log.md"];

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

/**
 * Non-blocking cleanliness warnings for a page being written: [[wikilinks]]
 * pointing to pages that do not exist yet, and titles duplicating another page.
 */
async function pageContentWarnings(
  relPath: string,
  content: string,
  frontmatter: Frontmatter
): Promise<string[]> {
  const warnings: string[] = [];
  const pages = await listWikiPageMetadata();
  const knownFiles = new Set([...pages.map((p) => normalizeRel(p.path)), normalizeRel(relPath)]);
  const titlesByPath = new Map(
    pages.flatMap((page) =>
      page.title ? [[normalizeRel(page.path), page.title] as const] : []
    )
  );
  const currentTitle = frontmatterString(frontmatter, "title");
  if (currentTitle) titlesByPath.set(normalizeRel(relPath), currentTitle);

  for (const name of new Set(wikiLinkTargets(content))) {
    if (resolveWikiLinkName(name, knownFiles, titlesByPath).length === 0) {
      warnings.push(`[[${name}]] does not match any existing page.`);
    }
  }

  const title = frontmatterString(frontmatter, "title");
  const duplicates = title
    ? pages.filter((p) => p.title === title && normalizeRel(p.path) !== normalizeRel(relPath))
    : [];
  if (duplicates.length > 0) {
    warnings.push(
      `Duplicate title: '${title}' is also used by ${duplicates.map((p) => p.path).join(", ")}.`
    );
  }

  return warnings;
}

function formatWarnings(warnings: string[]): string[] {
  return warnings.length > 0
    ? ["Warning:", ...warnings.map((w) => `  - ${w}`)]
    : [];
}

function withWikiMutationLock<T>(
  operation: () => Promise<T>,
  crossProcess = true
): Promise<T> {
  const root = wikiDir();
  return crossProcess
    ? withWikiFileLock(root, `${root}:wiki-mutation`, async () => {
        await recoverPendingWikiMoves(root);
        return operation();
      })
    : withKeyedLock(`${root}:wiki-read-transaction`, operation);
}

interface LinkChange {
  file: string;
  type: "wikilink" | "mdlink";
  oldRef: string;
  newRef: string;
  valid: boolean;
}

interface MoveJournal {
  version: 1;
  id: string;
  createdAt: string;
  files: Array<{ path: string; existed: boolean; contentBase64?: string }>;
}

let moveFailureAfterWritesForTests: number | null = null;

export function setWikiMoveFailureAfterWritesForTests(value: number | null): void {
  moveFailureAfterWritesForTests = value;
}

function maybeInjectMoveFailure(writeCount: number): void {
  if (moveFailureAfterWritesForTests !== null && writeCount >= moveFailureAfterWritesForTests) {
    throw new Error("Injected wiki move failure.");
  }
}

async function moveJournalDirectory(wikiRoot: string): Promise<string> {
  return resolveRealWithin(wikiRoot, ".knowledge-rail/move-journals");
}

async function restoreMoveJournal(wikiRoot: string, journalPath: string): Promise<void> {
  const parsed = JSON.parse(await fs.readFile(journalPath, "utf8")) as Partial<MoveJournal>;
  if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error("Wiki move journal is invalid; refusing automatic recovery.");
  }
  for (const snapshot of parsed.files) {
    if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.existed !== "boolean") {
      throw new Error("Wiki move journal contains an invalid file snapshot.");
    }
    const target = await resolveRealWithin(wikiRoot, snapshot.path);
    if (snapshot.existed) {
      if (typeof snapshot.contentBase64 !== "string") {
        throw new Error("Wiki move journal is missing recovery content.");
      }
      await atomicWriteText(target, Buffer.from(snapshot.contentBase64, "base64").toString("utf8"));
    } else {
      await unlinkWithLock(target).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }
  await fs.unlink(journalPath);
}

async function recoverPendingWikiMoves(wikiRoot: string): Promise<void> {
  const directory = await moveJournalDirectory(wikiRoot);
  const names = await fs.readdir(directory).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names.filter((value) => /^[a-f0-9-]+\.json$/i.test(value)).sort()) {
    await restoreMoveJournal(wikiRoot, await resolveRealWithin(directory, name));
  }
}

async function prepareMoveJournal(
  wikiRoot: string,
  relPaths: readonly string[]
): Promise<string> {
  const directory = await moveJournalDirectory(wikiRoot);
  await ensureDir(directory);
  const journal: MoveJournal = {
    version: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    files: [],
  };
  for (const relPath of [...new Set(relPaths)]) {
    const target = await resolveRealWithin(wikiRoot, relPath);
    const content = await fs.readFile(target).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    });
    journal.files.push({
      path: relPath.replace(/\\/g, "/"),
      existed: content !== null,
      ...(content ? { contentBase64: content.toString("base64") } : {}),
    });
  }
  const journalPath = await resolveRealWithin(directory, `${journal.id}.json`);
  await atomicWriteText(journalPath, `${JSON.stringify(journal)}\n`);
  return journalPath;
}

/**
 * Rewrite relative markdown links in `content`. Each local target is resolved
 * from `fromDir` (relative to wiki/); `mapTarget` decides whether (and towards
 * where) the link must be rewritten. Rewrites are validated by re-resolving.
 */
function rewriteMarkdownLinks(options: {
  wikiRoot: string;
  content: string;
  file: string;
  fromDir: string;
  mapTarget: (resolvedAbs: string) => { newFromDir: string; destAbs: string } | null;
  changes: LinkChange[];
}): string {
  return options.content.replace(
    MARKDOWN_LINK_RE,
    (match, text: string, target: string) => {
      if (isExternalLinkTarget(target)) return match;
      const { path: targetPath, anchor } = splitAnchor(target);
      try {
        const resolvedAbs = safeResolveWithin(
          options.wikiRoot,
          nodePath.join(options.fromDir, targetPath)
        );
        const mapped = options.mapTarget(resolvedAbs);
        if (!mapped) return match;
        const newFromAbs = nodePath.resolve(options.wikiRoot, mapped.newFromDir);
        const rawRel = nodePath.relative(newFromAbs, mapped.destAbs).replace(/\\/g, "/");
        if (rawRel === targetPath) return match;
        let valid = false;
        try {
          valid =
            safeResolveWithin(options.wikiRoot, nodePath.join(mapped.newFromDir, rawRel)) ===
            mapped.destAbs;
        } catch {
          valid = false;
        }
        const newRef = `[${text}](${rawRel + anchor})`;
        options.changes.push({ file: options.file, type: "mdlink", oldRef: match, newRef, valid });
        return valid ? newRef : match;
      } catch {
        return match;
      }
    }
  );
}

export function registerWikiTools(
  server: McpServer,
  era: ProtocolEra = "modern",
  testHooks: { afterEditRead?: () => Promise<void> } = {}
): void {
  server.registerTool(toolName("init", era), { description: "Create the wiki/ and docs/ structure (index.md, log.md, SCHEMA.md). Idempotent: existing files are preserved unless force=true.", inputSchema: z.object({
              force: z.boolean().optional().default(false).describe("Overwrite SCHEMA.md when it already exists"),
            }) }, async ({ force }) => {
              await ensureWikiStructure(force);
              return textResult(
                [
                  "Wiki initialized: wiki/",
                  "  docs/      → docs/",
                  "  index.md   → wiki/index.md",
                  "  log.md     → wiki/log.md",
                  "  SCHEMA.md  → wiki/SCHEMA.md",
                ].join("\n")
              );
            });

  server.registerTool(toolName("writePage", era), { description: "Create or overwrite a wiki page (path relative to wiki/, required YAML frontmatter). Validate content, report broken wikilinks and duplicate titles, and rebuild index.md.", inputSchema: z.object({
              path: z.string().describe("Path relative to wiki/ (for example 'concepts/RAG.md')"),
              content: z.string().describe("Complete Markdown content, including frontmatter"),
            }) }, async ({ path: relPath, content }) => withWikiMutationLock(async () => {
              const absPath = await resolveRealWithin(wikiDir(), relPath);
              const validation = await validateWikiPageContent(content, { checkSourceExists: true });
              if (hasErrors(validation.issues)) {
                return errorResult(
                  `Validation failed for ${relPath}:\n\n${formatValidationIssues(validation.issues)}`
                );
              }

              await ensureDir(nodePath.dirname(absPath));
              await atomicWriteText(absPath, content);

              const warnings = [
                ...validation.issues.map((i) => `${i.severity} ${i.code}: ${i.message}`),
                ...(await pageContentWarnings(relPath, content, validation.frontmatter)),
              ];
              const indexLine = await finalizePageMutation([relPath]);
              return textResult(
                [
                  `Written: ${relPath}`,
                  `Title: ${frontmatterString(validation.frontmatter, "title") ?? "(missing)"} [${frontmatterString(validation.frontmatter, "type") ?? "?"}]`,
                  indexLine,
                  ...formatWarnings(warnings),
                ].join("\n")
              );
            }));

  server.registerTool(toolName("editPage", era), { description: "Perform a targeted wiki-page edit by replacing old_string with new_string. Revalidate the resulting page and rebuild index.md.", inputSchema: z.object({
              path: z.string().describe("Path relative to wiki/"),
              old_string: z.string().describe("Exact text to replace"),
              new_string: z.string().describe("Replacement text"),
              replace_all: z
                .boolean()
                .optional()
                .default(false)
                .describe("Replace every occurrence (by default old_string must be unique)"),
            }) }, async ({ path: relPath, old_string, new_string, replace_all }) => withWikiMutationLock(async () => {
              const absPath = await resolveRealWithin(wikiDir(), relPath);
              const content = await readFileSafe(absPath);
              if (content === null) {
                return errorResult(`Page not found: ${relPath}`);
              }
              await testHooks.afterEditRead?.();
              if (old_string === new_string) {
                return errorResult("old_string and new_string are identical.");
              }

              const occurrences = content.split(old_string).length - 1;
              if (occurrences === 0) {
                return errorResult(`old_string was not found in ${relPath}.`);
              }
              if (occurrences > 1 && !replace_all) {
                return errorResult(
                  `old_string occurs ${occurrences} times in ${relPath}. Make it unique or use replace_all=true.`
                );
              }

              const updated = replace_all
                ? content.split(old_string).join(new_string)
                : content.replace(old_string, new_string);
              const validation = await validateWikiPageContent(updated, { checkSourceExists: true });
              if (hasErrors(validation.issues)) {
                return errorResult(
                  `Edit blocked because the resulting page is invalid.\n\n${formatValidationIssues(validation.issues)}`
                );
              }

              await atomicWriteText(absPath, updated);
              const warnings = await pageContentWarnings(relPath, updated, validation.frontmatter);
              const indexLine = await finalizePageMutation([relPath]);
              return textResult(
                [
                  `Edited: ${relPath} (${replace_all ? occurrences : 1} replacement(s))`,
                  indexLine,
                  ...formatWarnings(warnings),
                ].join("\n")
              );
            }));

  server.registerTool(toolName("readPage", era), {
            description:
              "Internal bounded path/URI page read; MCP 2.0 agents should prefer resources/read for selected passage links.",
            inputSchema: z.object({
              path: z.string().optional().describe("Wiki path; exclusive with resource_uri."),
              resource_uri: z.string().startsWith("knowledge-rail://page/").optional()
                .describe("Exact knowledge_context URI; exclusive with path."),
              max_chars: z.number().int().min(1).max(50_000).default(6_000)
                .describe("Output cap; default 6000."),
            }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
          }, async ({ path: relPath, resource_uri, max_chars }) => {
              try {
                const read = await readWikiResource({
                  wikiRoot: wikiDir(),
                  path: relPath,
                  resourceUri: resource_uri,
                  maxCharacters: max_chars,
                });
                const returnedCharacters = [...read.text].length;
                const label = read.heading ? `${read.title} — ${read.heading}` : read.title;
                const truncation = read.truncated
                  ? `\n\n[Truncated: ${returnedCharacters}/${read.totalCharacters} characters returned]`
                  : "";
                return textResult(`# ${label}\n\n${read.text}${truncation}`);
              } catch (error: unknown) {
                return errorResult(error);
              }
            });

  server.registerTool(toolName("deletePage", era), { description: "Delete a wiki page and rebuild index.md.", inputSchema: z.object({
              path: z.string().describe("Path relative to wiki/"),
            }) }, async ({ path: relPath }) => withWikiMutationLock(async () => {
              try {
                await unlinkWithLock(await resolveRealWithin(wikiDir(), relPath));
              } catch (err: unknown) {
                if (isNodeError(err) && err.code === "ENOENT") {
                  return errorResult(`Page not found: ${relPath}`);
                }
                throw err;
              }
              const indexLine = await finalizePageMutation([relPath]);
              return textResult(`Deleted: ${relPath}\n${indexLine}`);
            }));

  server.registerTool(toolName("movePage", era), { description: "Move or rename a wiki page and update [[wikilinks]] and relative Markdown links across the wiki. dry_run=true returns only a preview.", inputSchema: z.object({
              old_path: z.string().describe("Current path relative to wiki/"),
              new_path: z.string().describe("New path relative to wiki/"),
              dry_run: z.boolean().optional().default(false),
            }) }, async ({ old_path: relOld, new_path: relNew, dry_run }) => withWikiMutationLock(async () => {
              const absOld = await resolveRealWithin(wikiDir(), relOld);
              const absNew = await resolveRealWithin(wikiDir(), relNew);
              const canonicalWikiRoot = await resolveRealWithin(
                nodePath.dirname(wikiDir()),
                nodePath.basename(wikiDir())
              );

              const oldContent = await readFileSafe(absOld);
              if (oldContent === null) {
                return errorResult(`Page not found: ${relOld}`);
              }
              if ((await readFileSafe(absNew)) !== null) {
                return errorResult(`Destination already exists: ${relNew}. Delete it first.`);
              }

              const oldFilename = nodePath.basename(relOld, ".md");
              const newFilename = nodePath.basename(relNew, ".md");
              const filenameChanged = oldFilename !== newFilename;
              const dirChanged = nodePath.dirname(relOld) !== nodePath.dirname(relNew);
              const oldVariants = wikiLinkNameVariants(oldFilename);
              const newWikiName = newFilename.replace(/_/g, " ");

              const changes: LinkChange[] = [];
              const updatedFiles = new Map<string, string>();
              const allFiles = await fg("**/*.md", {
                cwd: wikiDir(),
                absolute: false,
                followSymbolicLinks: false,
                ignore: CONTROL_FILES,
              });

              for (const f of allFiles) {
                if (f === relOld) continue;
                const raw = await readFileSafe(await resolveRealWithin(wikiDir(), f));
                if (!raw) continue;

                let current = raw;
                if (filenameChanged) {
                  current = current.replace(WIKI_LINK_RE, (match, inner: string) => {
                    const pipeIdx = inner.indexOf("|");
                    const name = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
                    const alias = pipeIdx >= 0 ? inner.slice(pipeIdx) : "";
                    if (!oldVariants.includes(name)) return match;
                    const newRef = `[[${newWikiName}${alias}]]`;
                    changes.push({ file: f, type: "wikilink", oldRef: match, newRef, valid: true });
                    return newRef;
                  });
                }
                if (filenameChanged || dirChanged) {
                  const fileDir = nodePath.dirname(f);
                  current = rewriteMarkdownLinks({
                    wikiRoot: canonicalWikiRoot,
                    content: current,
                    file: f,
                    fromDir: fileDir,
                    mapTarget: (resolvedAbs) =>
                      resolvedAbs === absOld ? { newFromDir: fileDir, destAbs: absNew } : null,
                    changes,
                  });
                }
                if (current !== raw) updatedFiles.set(f, current);
              }

              // Relative links inside the moved page must keep pointing at their targets
              const movedContent = dirChanged
                ? rewriteMarkdownLinks({
                    wikiRoot: canonicalWikiRoot,
                    content: oldContent,
                    file: relOld,
                    fromDir: nodePath.dirname(relOld),
                    mapTarget: (resolvedAbs) => ({
                      newFromDir: nodePath.dirname(relNew),
                      destAbs: resolvedAbs,
                    }),
                    changes,
                  })
                : oldContent;

              const applied = changes.filter((c) => c.valid);
              const warnings = changes.filter((c) => !c.valid);
              const changeLines = [
                ...applied.map((c) => `  [${c.type}] ${c.file}: ${c.oldRef} → ${c.newRef}`),
                ...(warnings.length > 0
                  ? [
                      "",
                      "WARNING — links could not be validated and were left unchanged:",
                      ...warnings.map((c) => `  [${c.type}] ${c.file}: ${c.oldRef}`),
                    ]
                  : []),
              ];

              if (dry_run) {
                return textResult(
                  [
                    `DRY RUN: ${relOld} → ${relNew}`,
                    `${applied.length} reference(s) to update; ${warnings.length} could not be validated:`,
                    ...changeLines,
                  ].join("\n")
                );
              }

              const journalPath = await prepareMoveJournal(canonicalWikiRoot, [
                relOld,
                relNew,
                ...updatedFiles.keys(),
                "index.md",
              ]);
              let writeCount = 0;
              try {
                await ensureDir(nodePath.dirname(absNew));
                await atomicWriteText(absNew, movedContent);
                maybeInjectMoveFailure(++writeCount);
                await unlinkWithLock(absOld);
                maybeInjectMoveFailure(++writeCount);
                for (const [f, content] of updatedFiles) {
                  await atomicWriteText(await resolveRealWithin(canonicalWikiRoot, f), content);
                  maybeInjectMoveFailure(++writeCount);
                }
                const indexLine = await finalizePageMutation([relOld, relNew, ...updatedFiles.keys()]);
                await fs.unlink(journalPath);
                return textResult(
                  [
                    `Moved: ${relOld} → ${relNew}`,
                    `Updated ${updatedFiles.size} file(s) and ${applied.length} reference(s).`,
                    indexLine,
                    ...changeLines,
                  ].join("\n")
                );
              } catch (error: unknown) {
                await restoreMoveJournal(canonicalWikiRoot, journalPath);
                throw error;
              }
            }, !dry_run));

  server.registerTool(toolName("appendLog", era), { description: "Append a timestamped entry to log.md.", inputSchema: z.object({
              entry: z.string().describe("Log entry text (Markdown)"),
              level: z.enum(["INFO", "WARN", "ACTION", "DECISION"]).optional().default("ACTION"),
            }) }, async ({ entry, level }) => withWikiMutationLock(async () => {
              await appendLog(entry, level ?? "ACTION");
              await invalidateManifestEntries(wikiDir(), ["log.md"]);
              return textResult("Log entry appended.");
            }));

  server.registerTool(toolName("search", era), { description: "Internal lexical diagnostic used by knowledge_context mode=search.", inputSchema: z.object({
              query: z.string().optional(),
              max_results: z.number().int().positive().optional().default(10),
              page_types: z.array(z.string()).optional(),
              retrieval_profile: z.enum(["precision", "balanced", "coverage"]).optional().default("balanced"),
            }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ query, max_results, page_types, retrieval_profile }) => {
              const top = await searchRetrievalIndex({
                wikiRoot: wikiDir(),
                query,
                maxResults: max_results ?? 10,
                pageTypes: page_types,
                profile: retrieval_profile,
                persist: false,
              });
              if (top.length === 0) {
                return textResult(query ? `No results for: "${query}"` : "No wiki pages.");
              }
              const lines = top.map(
                (r, i) =>
                  query
                    ? `${i + 1}. **${r.title}** (${r.path}) [${r.type}]\n   Score: ${r.score.toFixed(4)} | Section: ${r.heading}\n   > ${r.excerpt}`
                    : `${i + 1}. ${r.path} | ${r.title} [${r.type}]${r.record.updated ? ` (${r.record.updated})` : ""}`
              );
              return textResult(lines.join("\n\n"));
            });

  server.registerTool(toolName("graphQuery", era), { description: "Internal graph diagnostic used by knowledge_context mode=graph.", inputSchema: z.object({
              query: z.string().optional().default(""),
              max_nodes: z.number().int().positive().optional().default(12),
              max_depth: z.number().int().min(0).optional().default(1),
              page_types: z.array(z.string()).optional(),
              view: z.enum(["subgraph", "traceability"]).optional().default("subgraph"),
            }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async ({ query, max_nodes, max_depth, page_types, view }) => {
              if (view === "traceability") return textResult(await buildTraceabilityText());
              if (!(query ?? "").trim()) {
              return textResult("Provide a query for the subgraph view; use view=traceability for the complete matrix.");
            }
            const hybrid = await retrieveWikiHybrid({
              wikiRoot: wikiDir(),
              query,
              maxResults: max_nodes,
              lexicalPoolSize: Math.max(max_nodes * 4, 20),
              seedCount: Math.max(1, Math.ceil(max_nodes / 2)),
              graphMaxNodes: max_nodes,
              graphMaxDepth: max_depth,
              graphBeamWidth: Math.max(max_nodes * 2, 16),
              graphMaxVisitedNodes: Math.max(max_nodes * 6, 48),
              pageTypes: page_types,
              profile: "balanced",
              semanticEnabled: true,
              persistDerivedIndexes: false,
            });
            const stats = hybrid.graphResult.stats;
            return textResult(
              [
                formatGraphQueryResult(hybrid.graphResult),
                "",
                "## Retrieval stats",
                "- lexical candidates: " + hybrid.lexicalHits.length,
                "- semantic candidates: " + hybrid.semanticHits.length,
                "- semantic available: " + hybrid.semantic.available,
                ...(hybrid.semantic.error ? ["- semantic error: " + hybrid.semantic.error] : []),
                "- graph seeds: " + stats.seedCount,
                "- visited nodes: " + stats.visitedNodes,
                "- visited edges: " + stats.visitedEdges,
                "- truncated frontier: " + stats.truncatedFrontierCount,
                "- widening level: W" + hybrid.wideningLevel,
                "- display coverage sufficient: " + hybrid.coverage.displaySufficient,
                "- full-pool coverage sufficient: " + hybrid.coverage.sufficient,
                "- evidence gaps: " + (hybrid.coverage.evidenceGaps.join(", ") || "none"),
                "- display-budget gaps: " + (hybrid.coverage.budgetLimitedGaps.join(", ") || "none"),
              ].join("\n")
            );
            });

  server.registerTool(toolName("migrate", era), { description: "Plan, apply, or roll back the conservative wiki v1/v2/v3 and pre-rebrand .llm-wiki namespace migration to v4; plan is the default.", inputSchema: z.object({
              action: z.enum(["plan", "apply", "rollback"]).optional(),
              target_version: z.string().optional().default("4"),
              dry_run: z.boolean().optional(),
              backup: z.boolean().optional().default(false),
              run_id: z.string().optional(),
            }) }, async ({ action, target_version, dry_run, backup, run_id }) => {
              const operation = action ?? ((dry_run ?? true) ? "plan" : "apply");
              if (operation === "plan") return textResult(formatMigrationPlan(await planWikiMigration(wikiDir(), target_version)));
              try {
                if (operation === "rollback") {
                  if (!run_id) return errorResult("run_id is required for rollback.");
                  const result = await rollbackWikiMigration(wikiDir(), run_id);
                  return textResult(`Rollback completed: ${result.runId}\nDerived files restored: ${result.restoredFiles}`);
                }
                const result = await applyWikiMigration(wikiDir(), {
                  targetVersion: target_version,
                  backup: backup ?? false,
                  projectRoot: nodePath.dirname(docsDir()),
                });
                return textResult(
                  `${formatMigrationPlan(result.plan)}\n\n` +
                  `Migration completed: ${result.runId}\nBackup: ${result.backupDir}\n` +
                  `Journal: ${result.journalFile}\nCoverage: ${result.coverageReportFile}\n` +
                  `Canonical SHA-256: ${result.canonicalDigest}`
                );
              } catch (error: unknown) {
                return errorResult(error instanceof Error ? error.message : String(error));
              }
            });

  server.registerTool(toolName("lint", era), { description: "Check wiki health: frontmatter, orphan pages, missing [[wikilinks]], broken Markdown links, duplicate titles, and empty files.", inputSchema: z.object({
              include_orphans: z.boolean().optional().default(true),
              include_missing: z.boolean().optional().default(true),
              include_broken_links: z.boolean().optional().default(true),
            }) }, async ({ include_orphans, include_missing, include_broken_links }) => {
              const files = await fg("**/*.md", {
                cwd: wikiDir(),
                absolute: false,
                followSymbolicLinks: false,
                ignore: CONTROL_FILES,
              });

              type LintIssue = { severity: "ERROR" | "WARN" | "INFO"; code: string; detail: string };
              const report: LintIssue[] = [];
              const contentMap = new Map<string, string>();
              const titleToPaths = new Map<string, string[]>();
              const titlesByPath = new Map<string, string>();

              for (const f of files) {
                const content = await readFileSafe(await resolveRealWithin(wikiDir(), f));
                if (content === null) continue;
                if (content.trim() === "") {
                  report.push({ severity: "ERROR", code: "EMPTY_FILE", detail: `${f}: empty file` });
                  continue;
                }
                contentMap.set(f, content);
                const validation = await validateWikiPageContent(content, { checkSourceExists: true });
                for (const item of validation.issues) {
                  report.push({ severity: item.severity, code: item.code, detail: `${f}: ${item.message}` });
                }
                const title = frontmatterString(validation.frontmatter, "title");
                if (title) {
                  titlesByPath.set(normalizeRel(f), title);
                  titleToPaths.set(title, [...(titleToPaths.get(title) ?? []), f]);
                }
              }

              const inboundCount = new Map<string, number>(files.map((f) => [f, 0]));
              const missingPages = new Set<string>();

              for (const [filePath, content] of contentMap) {
                for (const name of wikiLinkTargets(content)) {
                  const matches = resolveWikiLinkName(name, files, titlesByPath);
                  if (matches.length === 0) {
                    missingPages.add(name);
                  } else {
                    for (const f of matches) inboundCount.set(f, (inboundCount.get(f) ?? 0) + 1);
                  }
                }

                if (include_broken_links) {
                  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
                    const target = match[2];
                    if (!target || isExternalLinkTarget(target)) continue;
                    const { path: targetPath } = splitAnchor(target);
                    try {
                      const resolvedAbs = safeResolveWithin(
                        wikiDir(),
                        nodePath.join(nodePath.dirname(filePath), targetPath)
                      );
                      if (!contentMap.has(relativePathFrom(wikiDir(), resolvedAbs))) {
                        report.push({ severity: "ERROR", code: "BROKEN_LINK", detail: `${filePath} -> ${target}` });
                      }
                    } catch (err: unknown) {
                      report.push({
                        severity: "ERROR",
                        code: "BROKEN_LINK_ESCAPE",
                        detail: `${filePath} -> ${target}: ${err instanceof Error ? err.message : String(err)}`,
                      });
                    }
                  }
                }
              }

              for (const [title, titlePaths] of titleToPaths) {
                if (titlePaths.length > 1) {
                  report.push({ severity: "WARN", code: "DUPLICATE_TITLE", detail: `${title}: ${titlePaths.join(", ")}` });
                }
              }
              if (include_orphans) {
                for (const [f, count] of inboundCount) {
                  if (count === 0) {
                    report.push({ severity: "INFO", code: "ORPHAN", detail: `${f} (no page links to it)` });
                  }
                }
              }
              if (include_missing) {
                for (const name of missingPages) {
                  report.push({
                    severity: "ERROR",
                    code: "MISSING_WIKILINK",
                    detail: `[[${name}]] is referenced but does not exist`,
                  });
                }
              }

              if (report.length === 0) {
                return textResult("Wiki lint passed. No problems found.");
              }
              const order = { ERROR: 0, WARN: 1, INFO: 2 } as const;
              report.sort(
                (a, b) =>
                  order[a.severity] - order[b.severity] ||
                  a.code.localeCompare(b.code) ||
                  a.detail.localeCompare(b.detail)
              );
              return textResult(
                `Wiki lint: ${report.length} problem(s):\n\n` +
                  report.map((item) => `${item.severity} ${item.code}: ${item.detail}`).join("\n")
              );
            });

}
