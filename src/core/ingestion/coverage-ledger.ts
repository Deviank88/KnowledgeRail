import * as path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteText } from "../fs-service.js";
import { wikiMetaDir } from "../manifest-service.js";
import { ensureDir, readFileSafe } from "../utils.js";
import type { SourceSegmentKind } from "./source-segmentation.js";
import type { SourceSegmentStatus } from "./evidence-record.js";

export const SOURCE_COMPILER_VERSION = "source-coverage-v1";

export interface SourceCoverageLedgerSegment {
  id: string;
  start: number;
  end: number;
  hash: string;
  kind: SourceSegmentKind;
  heading?: string;
  status: SourceSegmentStatus;
  evidenceRefs: string[];
  pageRefs: string[];
  reason?: string;
  processedAt?: string;
}

export interface SourceCoverageLedger {
  version: 1;
  sourceUri: string;
  sourceHash: string;
  compilerVersion: string;
  segmentMaxChars: number;
  compiledAt: string;
  updatedAt: string;
  finalizedAt?: string;
  state: "open" | "fully_covered";
  segments: SourceCoverageLedgerSegment[];
}

export interface SourceCoverageMetrics {
  sourceCoveragePercent: number;
  unresolvedSegmentCount: number;
  unrepresentedEvidenceCount: number;
  segmentsProcessed: number;
  segmentsIgnoredWithReason: number;
  totalSegments: number;
}

const SEGMENT_KINDS = new Set<SourceSegmentKind>([
  "markdown_section",
  "report_section",
  "code_symbol",
  "table_block",
  "paragraph_group",
  "bounded_chunk",
]);
const SEGMENT_STATUSES = new Set<SourceSegmentStatus>([
  "integrated",
  "duplicate",
  "irrelevant",
  "unresolved",
  "contradicted",
  "legacy_unverified",
]);

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) =>
    typeof item === "string" && item.trim().length > 0
  );
}

function validLedgerSegment(value: unknown): value is SourceCoverageLedgerSegment {
  if (!value || typeof value !== "object") return false;
  const segment = value as Partial<SourceCoverageLedgerSegment>;
  if (
    typeof segment.id !== "string" || !segment.id.startsWith("seg-") ||
    !Number.isInteger(segment.start) || !Number.isInteger(segment.end) ||
    segment.start! < 0 || segment.end! <= segment.start! ||
    typeof segment.hash !== "string" || !/^[a-f0-9]{64}$/.test(segment.hash) ||
    !SEGMENT_KINDS.has(segment.kind as SourceSegmentKind) ||
    !SEGMENT_STATUSES.has(segment.status as SourceSegmentStatus) ||
    !validStringArray(segment.evidenceRefs) || !validStringArray(segment.pageRefs) ||
    (segment.reason !== undefined && typeof segment.reason !== "string") ||
    (segment.processedAt !== undefined && typeof segment.processedAt !== "string")
  ) return false;
  if (segment.status === "integrated" && (segment.evidenceRefs.length === 0 || segment.pageRefs.length === 0)) {
    return false;
  }
  if (segment.status === "duplicate" && segment.evidenceRefs.length === 0 && segment.pageRefs.length === 0) {
    return false;
  }
  if (
    ["irrelevant", "unresolved", "contradicted", "legacy_unverified"].includes(segment.status!) &&
    !segment.reason?.trim()
  ) return false;
  return true;
}

function validLedger(value: unknown, sourceUri: string): value is SourceCoverageLedger {
  if (!value || typeof value !== "object") return false;
  const ledger = value as Partial<SourceCoverageLedger>;
  if (
    ledger.version !== 1 || ledger.sourceUri !== sourceUri ||
    typeof ledger.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(ledger.sourceHash) ||
    ledger.compilerVersion !== SOURCE_COMPILER_VERSION ||
    !Number.isInteger(ledger.segmentMaxChars) || ledger.segmentMaxChars! < 256 ||
    typeof ledger.compiledAt !== "string" || typeof ledger.updatedAt !== "string" ||
    (ledger.state !== "open" && ledger.state !== "fully_covered") ||
    !Array.isArray(ledger.segments) || !ledger.segments.every(validLedgerSegment)
  ) return false;
  if (ledger.segments.length > 0) {
    if (ledger.segments[0]!.start !== 0) return false;
    for (let index = 1; index < ledger.segments.length; index++) {
      if (ledger.segments[index - 1]!.end !== ledger.segments[index]!.start) return false;
    }
  }
  if (new Set(ledger.segments.map((segment) => segment.id)).size !== ledger.segments.length) return false;
  if (ledger.state === "fully_covered") {
    if (typeof ledger.finalizedAt !== "string") return false;
    if (ledger.segments.some((segment) =>
      segment.status === "unresolved" || segment.status === "legacy_unverified"
    )) return false;
  }
  return true;
}

function ledgerKey(sourceUri: string): string {
  return createHash("sha256").update(sourceUri, "utf8").digest("hex");
}

export function sourceCoverageLedgerRef(sourceUri: string): string {
  return `.knowledge-rail/source-coverage/${ledgerKey(sourceUri)}.json`;
}

export function sourceCoverageDir(wikiRoot: string): string {
  return path.join(wikiMetaDir(wikiRoot), "source-coverage");
}

export function sourceCoverageLedgerFile(wikiRoot: string, sourceUri: string): string {
  return path.join(wikiRoot, sourceCoverageLedgerRef(sourceUri));
}

export function sourceCoverageMetrics(ledger: SourceCoverageLedger): SourceCoverageMetrics {
  const accounted = ledger.segments.filter((segment) =>
    !["unresolved", "legacy_unverified"].includes(segment.status)
  );
  const unresolved = ledger.segments.filter((segment) =>
    segment.status === "unresolved" || segment.status === "legacy_unverified"
  );
  const unrepresented = ledger.segments.filter((segment) =>
    segment.status !== "irrelevant" &&
    segment.evidenceRefs.length === 0 &&
    segment.pageRefs.length === 0
  );
  return {
    sourceCoveragePercent: ledger.segments.length === 0
      ? 100
      : (accounted.length / ledger.segments.length) * 100,
    unresolvedSegmentCount: unresolved.length,
    unrepresentedEvidenceCount: unrepresented.length,
    segmentsProcessed: accounted.length,
    segmentsIgnoredWithReason: ledger.segments.filter((segment) =>
      segment.status === "irrelevant" && Boolean(segment.reason)
    ).length,
    totalSegments: ledger.segments.length,
  };
}

export async function readSourceCoverageLedger(
  wikiRoot: string,
  sourceUri: string
): Promise<SourceCoverageLedger | null> {
  const raw = await readFileSafe(sourceCoverageLedgerFile(wikiRoot, sourceUri));
  if (!raw) return null;
  try {
    const ledger: unknown = JSON.parse(raw);
    return validLedger(ledger, sourceUri) ? ledger : null;
  } catch {
    return null;
  }
}

export async function writeSourceCoverageLedger(
  wikiRoot: string,
  ledger: SourceCoverageLedger
): Promise<void> {
  await ensureDir(sourceCoverageDir(wikiRoot));
  await atomicWriteText(
    sourceCoverageLedgerFile(wikiRoot, ledger.sourceUri),
    `${JSON.stringify(ledger, null, 2)}\n`
  );
}
