import type { McpServer } from "@modelcontextprotocol/server";
import fg from "fast-glob";
import { z } from "zod";
import { docsCategoryDir, docsCategoryFilePath, wikiDir } from "../core/paths.js";
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
              pattern: z.string().optional().default("**/*"),
              path: z.string().optional(),
              max_chars: z.number().int().positive().optional(),
            }) }, async ({ action, category, pattern, path, max_chars }) => {
              if (action === "read") {
                if (!category || !path) return errorResult("category e path sono obbligatori per action=read.");
                const content = await readFileSafe(docsCategoryFilePath(category, path));
                if (content === null) return errorResult(`File non trovato: docs/${category}/${path}`);
                return textResult(max_chars && content.length > max_chars
                  ? `${content.slice(0, max_chars)}\n\n[Truncated: ${content.length - max_chars} more characters.]`
                  : content);
              }
              const categories = category ? [category] : FILE_CATEGORIES;
              const lines: string[] = [];

              for (const cat of categories) {
                const entries = await fg(pattern ?? "**/*", {
                  cwd: docsCategoryDir(cat),
                  dot: false,
                  onlyFiles: true,
                  stats: true,
                }).catch(() => [] as fg.Entry[]);

                lines.push(`## ${cat} (${entries.length})`);
                if (entries.length === 0) {
                  lines.push("_Nessun file._", "");
                  continue;
                }
                for (const entry of entries as fg.Entry[]) {
                  const sizeKB = entry.stats ? (entry.stats.size / 1024).toFixed(1) : "?";
                  const mtime = entry.stats
                    ? entry.stats.mtime.toISOString().slice(0, 16).replace("T", " ")
                    : "";
                  const status =
                    cat === "normalized"
                      ? "ready"
                      : (await readFileSafe(normalizedOutputPath(cat, entry.path).abs)) === null
                        ? "not-normalized"
                        : "normalized";
                  lines.push(`- ${entry.path} (${sizeKB} KB, ${mtime}, ${status})`);
                }
                lines.push("");
              }

              return textResult(lines.join("\n").trimEnd());
            });

  server.registerTool(toolName("normalizeSource", era), { description: "Normalize supported text, office, image or PDF sources into docs/normalized Markdown.", inputSchema: z.object({
              category: z.enum(CATEGORY_ENUM),
              path: z.string(),
              overwrite: z.boolean().optional().default(false),
            }) }, async ({ category, path: relPath, overwrite }) => {
              if (category === "normalized" || category === "deliverables" || category === "assets") {
                return errorResult(`Categoria non normalizzabile: ${category}.`);
              }
              const out = normalizedOutputPath(category, relPath);
              if (!overwrite && (await readFileSafe(out.abs)) !== null) {
                return errorResult(`Output già esistente: docs/normalized/${out.rel}. Usare overwrite=true.`);
              }

              try {
                const normalized = await normalizeSourceFile({ category, relPath, overwrite });
                return textResult(
                  [
                    `Fonte normalizzata: docs/normalized/${normalized.rel}`,
                    `Origine: ${normalized.sourceLabel}`,
                    `Caratteri: ${normalized.chars}`,
                  ].join("\n")
                );
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return errorResult(
                  message.includes("ENOENT") ? `File non trovato: docs/${category}/${relPath}` : message
                );
              }
            });

  server.registerTool(toolName("prepareRequestIngestion", era), { description: "Validate a development report and prepare wiki drafts without writing them.", inputSchema: z.object({
              report_filename: z.string(),
            }) }, async ({ report_filename }) => {
              const content = await readFileSafe(docsCategoryFilePath("reports", report_filename));
              if (content === null) {
                return errorResult(`Report non trovato: docs/reports/${report_filename}`);
              }
              const prepared = prepareRequestIngestionDrafts(content, `docs/reports/${report_filename}`);
              if (!prepared.valid) {
                return errorResult(formatReportValidation(prepared.validation, report_filename));
              }
              return textResult(
                [
                  "# Bozze ingestione richiesta",
                  "",
                  "> Applicare ogni bozza con `knowledge_page action=write`, poi registrare l'operazione con `action=append_log`.",
                  "",
                  ...prepared.drafts.map((draft) => draftBlock(draft.path, draft.content)),
                ].join("\n")
              );
            });

  server.registerTool(toolName("prepareSourceIngestion", era), { description: `Normalized-source coverage state machine: plan, next, record, coverage, finalize.`, inputSchema: z.object({
              action: z.enum(["plan", "next", "record", "coverage", "finalize"]).optional().default("next"),
              normalized_filename: z.string().describe("Nome file relativo a docs/normalized"),
              max_chars: z.number().int().positive().optional().default(12000),
              segment_max_chars: z.number().int().min(256).max(50000).optional(),
              segment_id: z.string().optional(),
              status: z.enum(["integrated", "duplicate", "irrelevant", "unresolved", "contradicted", "legacy_unverified"]).optional(),
              evidence_refs: z.array(z.string()).optional(),
              page_refs: z.array(z.string()).optional(),
              reason: z.string().optional(),
            }) }, async ({ action, normalized_filename, max_chars, segment_max_chars, segment_id, status, evidence_refs, page_refs, reason }) => {
              const content = await readFileSafe(docsCategoryFilePath("normalized", normalized_filename));
              if (content === null) {
                return errorResult(`Fonte normalizzata non trovata: docs/normalized/${normalized_filename}`);
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
                    "# Piano compilazione fonte",
                    "",
                    `- source: ${result.ledger.sourceUri}`,
                    `- sourceHash: ${result.ledger.sourceHash}`,
                    `- compilerVersion: ${result.ledger.compilerVersion}`,
                    `- state: ${result.ledger.state}`,
                    `- ledger: wiki/${sourceCoverageLedgerRef(uri)}`,
                    ...coverageLines(result.metrics),
                    "",
                    result.metrics.unresolvedSegmentCount > 0
                      ? "Usare action=next per processare la prima unità unresolved."
                      : "Nessuna unità in coda.",
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
                    return errorResult("segment_id e status sono obbligatori per action=record.");
                  }
                  if (["integrated", "duplicate", "contradicted"].includes(status)) {
                    return errorResult(
                      "Gli stati integrated, duplicate e contradicted sono derivati esclusivamente da knowledge_ingest action=apply_claims; la coverage verrà riconciliata automaticamente."
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
                    `Segmento registrato: ${segment_id} -> ${status}`,
                    `Stato fonte: ${result.ledger.state}`,
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
                    "# Coverage fonte",
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
                    "Coverage fonte finalizzata.",
                    `Stato fonte: ${result.ledger.state}`,
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
                    "Nessun segmento unresolved in coda.",
                    `Stato fonte: ${result.ledger.state}`,
                    ...coverageLines(result.metrics),
                    result.ledger.state === "fully_covered"
                      ? "Coverage già finalizzata."
                      : "Usare action=finalize per chiudere esplicitamente la coverage.",
                  ].join("\n"), {
                    action: "next",
                    sourceUri: result.ledger.sourceUri,
                    ledgerState: result.ledger.state,
                    metrics: result.metrics,
                    queueEmpty: true,
                  });
                }
                return structuredTextResult([
                  "# Unità estrazione Evidence IR",
                  "",
                  `> Segmento: \`${unit.segment.id}\` (${unit.segment.start}-${unit.segment.end}, ${unit.segment.kind})`,
                  `> Coda unresolved: ${unit.queuedSegmentIds.length} segmenti (incluso quello corrente).`,
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
