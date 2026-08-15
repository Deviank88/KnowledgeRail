import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  SOURCE_COMPILER_VERSION,
  readSourceCoverageLedger,
  sourceCoverageMetrics,
  writeSourceCoverageLedger,
  type SourceCoverageLedger,
  type SourceCoverageLedgerSegment,
  type SourceCoverageMetrics,
} from "./coverage-ledger.js";
import {
  normalizeSegmentResolution,
  type SourceSegmentResolution,
} from "./evidence-record.js";
import {
  segmentSource,
  sourceContentHash,
  sourceSegmentAccountingIsComplete,
} from "./source-segmentation.js";
import { safeResolveWithin } from "../paths.js";

const compilerLocks = new Map<string, Promise<void>>();

async function withCompilerLock<T>(
  wikiRoot: string,
  sourceUri: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${wikiRoot}\0${sourceUri}`;
  const previous = compilerLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate, () => gate);
  compilerLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (compilerLocks.get(key) === queued) compilerLocks.delete(key);
  }
}

export interface SourceCompilePlanResult {
  ledger: SourceCoverageLedger;
  metrics: SourceCoverageMetrics;
  created: boolean;
  refreshed: boolean;
}

export interface SourceCompileUnit {
  sourceUri: string;
  sourceHash: string;
  segment: SourceCoverageLedgerSegment;
  content: string;
  queuedSegmentIds: string[];
  metrics: SourceCoverageMetrics;
}

function normalizeSourceUri(sourceUri: string): string {
  const normalized = sourceUri.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith("docs/") || normalized.split("/").includes("..")) {
    throw new Error(`Source URI must stay inside docs/: ${sourceUri}`);
  }
  return normalized;
}

function pending(segment: SourceCoverageLedgerSegment): boolean {
  return segment.status === "unresolved" || segment.status === "legacy_unverified";
}

function assertCurrentSource(ledger: SourceCoverageLedger, content: string): void {
  const actualHash = sourceContentHash(content);
  if (actualHash !== ledger.sourceHash) {
    throw new Error("Source changed after compilation plan; run source_compile_plan again.");
  }
  let cursor = 0;
  for (const segment of ledger.segments) {
    if (
      segment.start !== cursor ||
      segment.end > content.length ||
      sourceContentHash(content.slice(segment.start, segment.end)) !== segment.hash
    ) {
      throw new Error("Source coverage ledger does not account for the current source; re-plan it.");
    }
    cursor = segment.end;
  }
  if (cursor !== content.length) {
    throw new Error("Source coverage ledger does not account for the current source; re-plan it.");
  }
}

function reusableSegment(
  segment: SourceCoverageLedgerSegment | undefined,
  hash: string
): SourceCoverageLedgerSegment | undefined {
  return segment?.hash === hash ? segment : undefined;
}

export async function sourceCompilePlan(params: {
  wikiRoot: string;
  sourceUri: string;
  content: string;
  segmentMaxChars?: number;
}): Promise<SourceCompilePlanResult> {
  const sourceUri = normalizeSourceUri(params.sourceUri);
  return withCompilerLock(params.wikiRoot, sourceUri, async () => {
    const segmentMaxChars = Math.max(256, Math.floor(params.segmentMaxChars ?? 8_000));
    const sourceHash = sourceContentHash(params.content);
    const existing = await readSourceCoverageLedger(params.wikiRoot, sourceUri);
    if (
      existing &&
      existing.sourceHash === sourceHash &&
      existing.segmentMaxChars === segmentMaxChars
    ) {
      assertCurrentSource(existing, params.content);
      return {
        ledger: existing,
        metrics: sourceCoverageMetrics(existing),
        created: false,
        refreshed: false,
      };
    }

    const planned = segmentSource(params.content, { sourceUri, maxChars: segmentMaxChars });
    if (!sourceSegmentAccountingIsComplete(params.content, planned)) {
      throw new Error("Source segmentation did not account for every source character.");
    }
    const previousById = new Map(existing?.segments.map((segment) => [segment.id, segment] as const));
    const now = new Date().toISOString();
    const segments: SourceCoverageLedgerSegment[] = planned.map((segment) => {
      const previous = reusableSegment(previousById.get(segment.id), segment.hash);
      return previous
        ? { ...previous, start: segment.start, end: segment.end, kind: segment.kind, heading: segment.heading }
        : {
          id: segment.id,
          start: segment.start,
          end: segment.end,
          hash: segment.hash,
          kind: segment.kind,
          ...(segment.heading ? { heading: segment.heading } : {}),
          status: "unresolved",
          evidenceRefs: [],
          pageRefs: [],
          reason: "pending_processing",
        };
    });
    const ledger: SourceCoverageLedger = {
      version: 1,
      sourceUri,
      sourceHash,
      compilerVersion: SOURCE_COMPILER_VERSION,
      segmentMaxChars,
      compiledAt: now,
      updatedAt: now,
      // A different source hash or segmentation budget is a new compilation
      // revision. Even if all content-addressed segments were reusable, closure
      // must be asserted explicitly for this revision.
      state: "open",
      segments,
    };
    await writeSourceCoverageLedger(params.wikiRoot, ledger);
    return {
      ledger,
      metrics: sourceCoverageMetrics(ledger),
      created: existing === null,
      refreshed: existing !== null,
    };
  });
}

export async function sourceCompileNext(params: {
  wikiRoot: string;
  sourceUri: string;
  content: string;
  maxChars: number;
}): Promise<SourceCompileUnit | null> {
  const sourceUri = normalizeSourceUri(params.sourceUri);
  const ledger = await readSourceCoverageLedger(params.wikiRoot, sourceUri);
  if (!ledger) throw new Error("Source coverage is unknown; run source_compile_plan first.");
  assertCurrentSource(ledger, params.content);
  const segment = ledger.segments.find(pending);
  if (!segment) return null;
  const content = params.content.slice(segment.start, segment.end);
  if (content.length > params.maxChars) {
    throw new Error(
      `The next segment requires ${content.length} characters; max_chars is ${params.maxChars}. ` +
      "Re-plan with a smaller segment budget or increase this unit budget."
    );
  }
  if (sourceContentHash(content) !== segment.hash) {
    throw new Error(`Segment integrity check failed: ${segment.id}.`);
  }
  return {
    sourceUri,
    sourceHash: ledger.sourceHash,
    segment,
    content,
    queuedSegmentIds: ledger.segments.filter(pending).map((item) => item.id),
    metrics: sourceCoverageMetrics(ledger),
  };
}

async function assertPageRefsExist(wikiRoot: string, pageRefs: readonly string[]): Promise<void> {
  for (const pageRef of pageRefs) {
    if (!pageRef.toLowerCase().endsWith(".md")) {
      throw new Error(`Referenced wiki page must be Markdown: ${pageRef}`);
    }
    const absolute = safeResolveWithin(wikiRoot, pageRef);
    try {
      const [rootReal, targetReal] = await Promise.all([
        fs.realpath(wikiRoot),
        fs.realpath(absolute),
      ]);
      const relative = path.relative(rootReal, targetReal);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Referenced wiki page resolves outside the wiki root: ${pageRef}`);
      }
      const stat = await fs.stat(targetReal);
      if (!stat.isFile()) throw new Error(`Referenced wiki page is not a regular file: ${pageRef}`);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("Referenced wiki page")) throw error;
      throw new Error(`Referenced wiki page does not exist: ${pageRef}`);
    }
  }
}

export async function sourceRecordSegment(params: {
  wikiRoot: string;
  sourceUri: string;
  content: string;
  segmentId: string;
  resolution: SourceSegmentResolution;
}): Promise<{ ledger: SourceCoverageLedger; metrics: SourceCoverageMetrics }> {
  const sourceUri = normalizeSourceUri(params.sourceUri);
  return withCompilerLock(params.wikiRoot, sourceUri, async () => {
    const ledger = await readSourceCoverageLedger(params.wikiRoot, sourceUri);
    if (!ledger) throw new Error("Source coverage is unknown; run source_compile_plan first.");
    assertCurrentSource(ledger, params.content);
    const segment = ledger.segments.find((item) => item.id === params.segmentId);
    if (!segment) throw new Error(`Unknown source segment: ${params.segmentId}.`);
    const resolution = normalizeSegmentResolution(params.resolution);
    await assertPageRefsExist(params.wikiRoot, resolution.pageRefs);
    Object.assign(segment, resolution, { processedAt: new Date().toISOString() });
    ledger.state = "open";
    delete ledger.finalizedAt;
    ledger.updatedAt = new Date().toISOString();
    await writeSourceCoverageLedger(params.wikiRoot, ledger);
    return { ledger, metrics: sourceCoverageMetrics(ledger) };
  });
}

export async function sourceCoverage(params: {
  wikiRoot: string;
  sourceUri: string;
  content?: string;
}): Promise<{ ledger: SourceCoverageLedger; metrics: SourceCoverageMetrics; gaps: string[] }> {
  const sourceUri = normalizeSourceUri(params.sourceUri);
  const ledger = await readSourceCoverageLedger(params.wikiRoot, sourceUri);
  if (!ledger) throw new Error("Source coverage is unknown; compile the source before treating it as ingested.");
  if (params.content !== undefined) assertCurrentSource(ledger, params.content);
  const gaps = ledger.segments.filter(pending).map((segment) => segment.id);
  return { ledger, metrics: sourceCoverageMetrics(ledger), gaps };
}

export async function sourceFinalize(params: {
  wikiRoot: string;
  sourceUri: string;
  content: string;
}): Promise<{ ledger: SourceCoverageLedger; metrics: SourceCoverageMetrics }> {
  const sourceUri = normalizeSourceUri(params.sourceUri);
  return withCompilerLock(params.wikiRoot, sourceUri, async () => {
    const current = await sourceCoverage({ ...params, sourceUri });
    if (current.gaps.length > 0) {
      throw new Error(
        `Cannot finalize source coverage: ${current.gaps.length} unresolved segment(s): ` +
        current.gaps.join(", ")
      );
    }
    for (const segment of current.ledger.segments) {
      normalizeSegmentResolution(segment);
      await assertPageRefsExist(params.wikiRoot, segment.pageRefs);
    }
    const now = new Date().toISOString();
    current.ledger.state = "fully_covered";
    current.ledger.finalizedAt = now;
    current.ledger.updatedAt = now;
    await writeSourceCoverageLedger(params.wikiRoot, current.ledger);
    return { ledger: current.ledger, metrics: sourceCoverageMetrics(current.ledger) };
  });
}
