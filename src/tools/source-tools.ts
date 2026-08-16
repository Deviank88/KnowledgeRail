import type { McpServer } from "@modelcontextprotocol/server";
import * as nodePath from "node:path";
import type { Readable } from "node:stream";
import fg from "fast-glob";
import { z } from "zod";
import {
  docsCategoryDirReal,
  docsCategoryFilePathReal,
  validateGlobPattern,
  wikiDir,
} from "../core/paths.js";
import {
  sourceCompileNext,
  sourceCompilePlan,
  sourceCoverage,
  sourceFinalize,
  sourceRecordSegment,
} from "../core/ingestion/source-compiler.js";
import {
  readSourceCoverageLedger,
  sourceCoverageLedgerRef,
} from "../core/ingestion/coverage-ledger.js";
import {
  FILE_CATEGORIES,
  formatReportValidation,
  prepareRequestIngestionDrafts,
} from "../core/report-workflow.js";
import {
  normalizeSourceFile,
  normalizedOutputPath,
} from "../core/source-normalization-service.js";
import { readFileSafe } from "../core/utils.js";
import { errorResult, structuredTextResult, textResult } from "./helpers.js";
import { toolName, type ProtocolEra } from "../mcp/tool-names.js";

const CATEGORY_ENUM = [...FILE_CATEGORIES] as [
  (typeof FILE_CATEGORIES)[number],
  ...(typeof FILE_CATEGORIES)[number][],
];
const MAX_LIST_ENTRIES = 1_000;

async function boundedGlob(
  pattern: string,
  cwd: string,
  limit: number
): Promise<{ entries: fg.Entry[]; truncated: boolean }> {
  const entries: fg.Entry[] = [];
  const stream = fg.stream(pattern, {
    cwd: nodePath.resolve(cwd),
    absolute: false,
    dot: false,
    onlyFiles: true,
    stats: true,
    followSymbolicLinks: false,
  }) as Readable;
  let truncated = false;
  try {
    for await (const value of stream as Readable & AsyncIterable<fg.Entry>) {
      if (entries.length >= limit) {
        truncated = true;
        stream.destroy();
        break;
      }
      entries.push(value);
    }
  } finally {
    if (truncated && !stream.destroyed) stream.destroy();
  }
  return { entries, truncated };
}

function draftBlock(path: string, content: string): string {
  return [`## ${path}`, "", "```markdown", content, "```"].join("\n");
}

function sourceUri(normalizedFilename: string): string {
  return `docs/normalized/${normalizedFilename.replace(/\\/g, "/")}`;
}

function coverageLines(metrics: {
  sourceCoveragePercent: number;
  unresolvedSegmentCount: number;
  unrepresentedEvidenceCount: number;
  segmentsProcessed: number;
  segmentsIgnoredWithReason: number;
  totalSegments: number;
}): string[] {
  return [
    `- sourceCoveragePercent: ${metrics.sourceCoveragePercent.toFixed(2)}`,
    `- unresolvedSegmentCount: ${metrics.unresolvedSegmentCount}`,
    `- unrepresentedEvidenceCount: ${metrics.unrepresentedEvidenceCount}`,
    `- segmentsProcessed: ${metrics.segmentsProcessed}/${metrics.totalSegments}`,
    `- segmentsIgnoredWithReason: ${metrics.segmentsIgnoredWithReason}`,
  ];
}

export function registerSourceTools(server: McpServer, era: ProtocolEra = "modern"): void {
  server.registerTool(toolName("files", era), { description: "Internal docs file operation.", inputSchema: z.object({
              action: z.enum(["list", "read"]).optional().default("list"),
              category: z.enum(CATEGORY_ENUM).optional(),
              pattern: z.string().min(1).max(1024).optional().default("**/*"),
              path: z.string().optional(),
              max_chars: z.number().int().positive().optional(),
            }) }, async ({ action, category, pattern, path, max_chars }) => {
              try {
                if (action === "read") {
                  if (!category || !path) return errorResult("category and path are required for action=read.");
                  const absPath = await docsCategoryFilePathReal(category, path);
                  const content = await readFileSafe(absPath);
                  if (content === null) return errorResult(`File not found: docs/${category}/${path}`);
                  return textResult(max_chars && content.length > max_chars
                    ? `${content.slice(0, max_chars)}\n\n[Truncated: ${content.length - max_chars} more characters.]`
                    : content);
                }
                const safePattern = validateGlobPattern(pattern ?? "**/*");
                const categories = category ? [category] : FILE_CATEGORIES;
                const lines: string[] = [];
                const listed: Array<{ category: string; entries: string[]; truncated: boolean }> = [];
                let remaining = MAX_LIST_ENTRIES;
                let truncated = false;

                for (const cat of categories) {
                  const cwd = await docsCategoryDirReal(cat);
                  const result = remaining > 0
                    ? await boundedGlob(safePattern, cwd, remaining)
                    : { entries: [] as fg.Entry[], truncated: true };
                  remaining -= result.entries.length;
                  truncated ||= result.truncated;
                  listed.push({
                    category: cat,
                    entries: result.entries.map((entry) => entry.path.replace(/\\/g, "/")),
                    truncated: result.truncated,
                  });

                  lines.push(`## ${cat} (${result.entries.length}${result.truncated ? "+" : ""})`);
                  if (result.entries.length === 0) {
                    lines.push("_No files._", "");
                    continue;
                  }
                  for (const entry of result.entries) {
                    const sizeKB = entry.stats ? (entry.stats.size / 1024).toFixed(1) : "?";
                    const mtime = entry.stats
                      ? entry.stats.mtime.toISOString().slice(0, 16).replace("T", " ")
                      : "";
                    const normalized = normalizedOutputPath(cat, entry.path);
                    const normalizedAbs = await docsCategoryFilePathReal("normalized", normalized.rel);
                    const status = cat === "normalized"
                      ? "ready"
                      : (await readFileSafe(normalizedAbs)) === null ? "not-normalized" : "normalized";
                    lines.push(`- ${entry.path} (${sizeKB} KB, ${mtime}, ${status})`);
                  }
                  if (result.truncated) lines.push(`_Truncated at ${MAX_LIST_ENTRIES} total entries._`);
                  lines.push("");
                }

                if (truncated && !lines.some((line) => line.startsWith("_Truncated"))) {
                  lines.push(`_Truncated at ${MAX_LIST_ENTRIES} total entries._`);
                }
                return structuredTextResult(lines.join("\n").trimEnd(), {
                  pattern: safePattern,
                  maxEntries: MAX_LIST_ENTRIES,
                  truncated,
                  categories: listed,
                });
              } catch (error: unknown) {
                return errorResult(error);
              }
            });

  server.registerTool(toolName("normalizeSource", era), { description: "Normalize supported text, office, image or PDF sources into docs/normalized Markdown.", inputSchema: z.object({
              category: z.enum(CATEGORY_ENUM),
              path: z.string(),
              overwrite: z.boolean().optional().default(false),
            }) }, async ({ category, path: relPath, overwrite }) => {
              if (category === "normalized" || category === "deliverables" || category === "assets") {
                return errorResult(`Category cannot be normalized: ${category}.`);
              }
              const out = normalizedOutputPath(category, relPath);
              if (!overwrite && (await readFileSafe(out.abs)) !== null) {
                return errorResult(`Output already exists: docs/normalized/${out.rel}. Use overwrite=true.`);
              }

              try {
                const normalized = await normalizeSourceFile({ category, relPath, overwrite });
                return textResult(
                  [
                    `Normalized source: docs/normalized/${normalized.rel}`,
                    `Source: ${normalized.sourceLabel}`,
                    `Characters: ${normalized.chars}`,
                  ].join("\n")
                );
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return errorResult(
                  message.includes("ENOENT") ? `File not found: docs/${category}/${relPath}` : message
                );
              }
            });

  server.registerTool(toolName("prepareRequestIngestion", era), { description: "Validate a development report and prepare wiki drafts without writing them.", inputSchema: z.object({
              report_filename: z.string(),
            }) }, async ({ report_filename }) => {
              const content = await readFileSafe(
                await docsCategoryFilePathReal("reports", report_filename)
              );
              if (content === null) {
                return errorResult(`Report not found: docs/reports/${report_filename}`);
              }
              const prepared = prepareRequestIngestionDrafts(content, `docs/reports/${report_filename}`);
              if (!prepared.valid) {
                return errorResult(formatReportValidation(prepared.validation, report_filename));
              }
              return textResult(
                [
                  "# Request-ingestion drafts",
                  "",
                  "> Apply each draft with `knowledge_page action=write`, then record the operation with `action=append_log`.",
                  "",
                  ...prepared.drafts.map((draft) => draftBlock(draft.path, draft.content)),
                ].join("\n")
              );
            });

  server.registerTool(toolName("prepareSourceIngestion", era), { description: `Normalized-source coverage state machine: plan, next, record, coverage, finalize.`, inputSchema: z.object({
              action: z.enum(["plan", "next", "record", "coverage", "finalize"]).optional().default("next"),
              normalized_filename: z.string().describe("Filename relative to docs/normalized"),
              max_chars: z.number().int().positive().optional().default(12000),
              segment_max_chars: z.number().int().min(256).max(50000).optional(),
              segment_id: z.string().optional(),
              status: z.enum(["integrated", "duplicate", "irrelevant", "unresolved", "contradicted", "legacy_unverified"]).optional(),
              evidence_refs: z.array(z.string()).optional(),
              page_refs: z.array(z.string()).optional(),
              reason: z.string().optional(),
            }) }, async ({ action, normalized_filename, max_chars, segment_max_chars, segment_id, status, evidence_refs, page_refs, reason }) => {
              const content = await readFileSafe(
                await docsCategoryFilePathReal("normalized", normalized_filename)
              );
              if (content === null) {
                return errorResult(`Normalized source not found: docs/normalized/${normalized_filename}`);
              }
              const uri = sourceUri(normalized_filename);
              const unitBudget = max_chars ?? 12000;

              try {
                if (action === "plan") {
                  const result = await sourceCompilePlan({
                    wikiRoot: wikiDir(),
                    sourceUri: uri,
                    content,
                    segmentMaxChars: segment_max_chars ?? unitBudget,
                  });
                  return structuredTextResult([
                    "# Source-compilation plan",
                    "",
                    `- source: ${result.ledger.sourceUri}`,
                    `- sourceHash: ${result.ledger.sourceHash}`,
                    `- compilerVersion: ${result.ledger.compilerVersion}`,
                    `- state: ${result.ledger.state}`,
                    `- ledger: wiki/${sourceCoverageLedgerRef(uri)}`,
                    ...coverageLines(result.metrics),
                    "",
                    result.metrics.unresolvedSegmentCount > 0
                      ? "Use action=next to process the first unresolved unit."
                      : "No units are queued.",
                  ].join("\n"), {
                    action: "plan",
                    sourceUri: result.ledger.sourceUri,
                    sourceHash: result.ledger.sourceHash,
                    compilerVersion: result.ledger.compilerVersion,
                    ledgerRef: sourceCoverageLedgerRef(uri),
                    ledgerState: result.ledger.state,
                    metrics: result.metrics,
                    queueEmpty: result.metrics.unresolvedSegmentCount === 0,
                  });
                }

                if (action === "record") {
                  if (!segment_id || !status) {
                    return errorResult("segment_id and status are required for action=record.");
                  }
                  if (["integrated", "duplicate", "contradicted"].includes(status)) {
                    return errorResult(
                      "The integrated, duplicate, and contradicted states are derived only by knowledge_ingest action=apply_claims; coverage is reconciled automatically."
                    );
                  }
                  const result = await sourceRecordSegment({
                    wikiRoot: wikiDir(),
                    sourceUri: uri,
                    content,
                    segmentId: segment_id,
                    resolution: {
                      status,
                      evidenceRefs: evidence_refs,
                      pageRefs: page_refs,
                      reason,
                    },
                  });
                  return structuredTextResult([
                    `Segment recorded: ${segment_id} -> ${status}`,
                    `Source state: ${result.ledger.state}`,
                    ...coverageLines(result.metrics),
                  ].join("\n"), {
                    action: "record",
                    segmentId: segment_id,
                    segmentStatus: status,
                    ledgerState: result.ledger.state,
                    metrics: result.metrics,
                  });
                }

                if (action === "coverage") {
                  const result = await sourceCoverage({ wikiRoot: wikiDir(), sourceUri: uri, content });
                  return structuredTextResult([
                    "# Source coverage",
                    "",
                    `- source: ${result.ledger.sourceUri}`,
                    `- state: ${result.ledger.state}`,
                    ...coverageLines(result.metrics),
                    `- gaps: ${result.gaps.join(", ") || "none"}`,
                  ].join("\n"), {
                    action: "coverage",
                    sourceUri: result.ledger.sourceUri,
                    ledgerState: result.ledger.state,
                    metrics: result.metrics,
                    gaps: result.gaps,
                    readyForFinalization: result.gaps.length === 0,
                  });
                }

                if (action === "finalize") {
                  const result = await sourceFinalize({ wikiRoot: wikiDir(), sourceUri: uri, content });
                  return structuredTextResult([
                    "Source coverage finalized.",
                    `Source state: ${result.ledger.state}`,
                    ...coverageLines(result.metrics),
                  ].join("\n"), {
                    action: "finalize",
                    sourceUri: result.ledger.sourceUri,
                    ledgerState: result.ledger.state,
                    metrics: result.metrics,
                  });
                }

                if (!(await readSourceCoverageLedger(wikiDir(), uri))) {
                  await sourceCompilePlan({
                    wikiRoot: wikiDir(),
                    sourceUri: uri,
                    content,
                    segmentMaxChars: segment_max_chars ?? unitBudget,
                  });
                }
                const unit = await sourceCompileNext({
                  wikiRoot: wikiDir(),
                  sourceUri: uri,
                  content,
                  maxChars: unitBudget,
                });
                if (!unit) {
                  const result = await sourceCoverage({ wikiRoot: wikiDir(), sourceUri: uri, content });
                  return structuredTextResult([
                    "No unresolved segments are queued.",
                    `Source state: ${result.ledger.state}`,
                    ...coverageLines(result.metrics),
                    result.ledger.state === "fully_covered"
                      ? "Coverage is already finalized."
                      : "Use action=finalize to close coverage explicitly.",
                  ].join("\n"), {
                    action: "next",
                    sourceUri: result.ledger.sourceUri,
                    ledgerState: result.ledger.state,
                    metrics: result.metrics,
                    queueEmpty: true,
                  });
                }
                return structuredTextResult([
                  "# Evidence IR extraction unit",
                  "",
                  `> Segment: \`${unit.segment.id}\` (${unit.segment.start}-${unit.segment.end}, ${unit.segment.kind})`,
                  `> Unresolved queue: ${unit.queuedSegmentIds.length} segment(s), including the current one.`,
                  "> Extract claims with provenance and use `knowledge_ingest action=apply_claims`; record, link, validation and synthesis are orchestrated internally.",
                  "",
                  "```source",
                  unit.content,
                  "```",
                ].join("\n"), {
                  action: "next",
                  sourceUri: unit.sourceUri,
                  sourceHash: unit.sourceHash,
                  segment: unit.segment,
                  queuedSegmentIds: unit.queuedSegmentIds,
                  metrics: unit.metrics,
                  queueEmpty: false,
                });
              } catch (error: unknown) {
                return errorResult(error);
              }
            });

}
