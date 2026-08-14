import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRetrievalContextManifest,
  estimateContextSize,
} from "../src/context/context-manifest.js";
import { readWikiResource } from "../src/context/resource-reader.js";
import {
  createSectionContext,
  formatSectionContext,
} from "../src/core/document-workflow.js";
import {
  clearRetrievalIndexes,
  searchRetrievalIndex,
} from "../src/core/retrieval-index.js";

interface LatencyStats {
  iterations: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function stats(samples: readonly number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    iterations: samples.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    meanMs: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
  };
}

function reductionPercent(smaller: number, larger: number): number {
  if (larger <= 0) return 0;
  return ((larger - smaller) / larger) * 100;
}

async function writeSyntheticWiki(wikiRoot: string, pageCount: number): Promise<void> {
  const dirs = ["requirements", "decisions", "analysis", "concepts"];
  const writes: Promise<void>[] = [];

  for (let index = 0; index < pageCount; index++) {
    const relevant = index % 37 === 0 || index % 53 === 0;
    const dir = dirs[index % dirs.length]!;
    const relPath = path.join(dir, `PAGE_${String(index).padStart(4, "0")}.md`);
    const filePath = path.join(wikiRoot, relPath);
    const type = dir === "requirements"
      ? "requirement"
      : dir === "decisions"
        ? "decision"
        : dir === "analysis"
          ? "analysis"
          : "concept";
    const targetEvidence = relevant
      ? [
          "Approval audit evidence requires user role timestamp motivation and immutable traceability.",
          `Policy AUD-${String(index).padStart(4, "0")} applies a retry-safe approval rule with explicit ownership.`,
        ].join(" ")
      : "This page describes unrelated operational details, ownership, scheduling, and generic validation.";
    const filler = Array.from({ length: 45 }, (_, item) =>
      `Operational note ${item + 1}: deterministic synthetic context for page ${index}.`
    ).join(" ");
    const markdown = [
      "---",
      `title: \"Synthetic ${String(index).padStart(4, "0")}\"`,
      `type: ${type}`,
      `tags: [synthetic${relevant ? ", audit, approval" : ""}]`,
      "created: 2026-08-13",
      "updated: 2026-08-13",
      `sources: [\"bench/source-${index % 11}.md\"]`,
      "---",
      "",
      "# Synthetic benchmark page",
      "",
      "## Summary",
      "",
      `Synthetic knowledge page ${index} used to measure context disclosure behavior.`,
      "",
      "## Evidence",
      "",
      targetEvidence,
      "",
      "## Operational detail",
      "",
      filler,
      "",
    ].join("\n");

    writes.push((async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, markdown, "utf8");
    })());
  }

  await Promise.all(writes);
}

async function main(): Promise<void> {
  const pageCount = positiveInteger(process.env["CONTEXT_BENCH_PAGES"], 500);
  const iterations = positiveInteger(process.env["CONTEXT_BENCH_ITERATIONS"], 15);
  const maxEvidence = positiveInteger(process.env["CONTEXT_BENCH_MAX_EVIDENCE"], 8);
  const readEvidence = positiveInteger(process.env["CONTEXT_BENCH_READ_EVIDENCE"], 3);
  const heuristicTokenBudget = positiveInteger(process.env["CONTEXT_BENCH_TOKEN_BUDGET"], 2_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-context-bench-"));
  const wikiRoot = path.join(root, "wiki");
  const sectionTitle = "Approval audit and traceability";
  const query = "approval audit user role timestamp motivation immutable traceability retry ownership";
  const legacySamples: number[] = [];
  const editorialSamples: number[] = [];
  const manifestSamples: number[] = [];
  const materializeSamples: number[] = [];

  clearRetrievalIndexes();
  try {
    await writeSyntheticWiki(wikiRoot, pageCount);

    // Warm the lexical index once so the repeated measurements compare steady-state paths.
    await searchRetrievalIndex({
      wikiRoot,
      query,
      maxResults: 20,
      profile: "coverage",
    });

    let legacyText = "";
    let editorialText = "";
    let manifestJson = "";
    let materializedText = "";
    let evidenceCount = 0;
    let gapCount = 0;

    for (let iteration = 0; iteration < iterations; iteration++) {
      const legacyStart = performance.now();
      const legacyHits = await searchRetrievalIndex({
        wikiRoot,
        query,
        maxResults: maxEvidence,
        profile: "coverage",
      });
      let remainingLegacyChars = 30_000;
      const legacyBodies: string[] = [];
      for (const hit of legacyHits) {
        if (remainingLegacyChars <= 0) break;
        const body = hit.record.body.slice(0, Math.min(6_000, remainingLegacyChars));
        legacyBodies.push(body);
        remainingLegacyChars -= body.length;
      }
      legacyText = legacyBodies.join("\n\n");
      legacySamples.push(performance.now() - legacyStart);

      const editorialStart = performance.now();
      const editorial = await createSectionContext({
        wikiRoot,
        sectionTitle,
        query,
        retrievalProfile: "coverage",
        maxPages: maxEvidence,
        maxCharsPerPage: 6_000,
        maxTotalChars: 30_000,
        useGraph: false,
      });
      editorialText = formatSectionContext(editorial, sectionTitle);
      editorialSamples.push(performance.now() - editorialStart);

      const manifestStart = performance.now();
      const hits = await searchRetrievalIndex({
        wikiRoot,
        query,
        maxResults: Math.max(maxEvidence * 2, 10),
        profile: "coverage",
      });
      const manifest = buildRetrievalContextManifest({
        intent: "document",
        objective: sectionTitle,
        hits,
        maxEvidence,
        heuristicTokenBudget,
        reason: "BM25 coverage seed",
      });
      manifestJson = JSON.stringify(manifest);
      evidenceCount = manifest.evidence.length;
      gapCount = manifest.gaps.length;
      manifestSamples.push(performance.now() - manifestStart);

      const materializeStart = performance.now();
      const reads: string[] = [];
      for (const evidence of manifest.evidence.slice(0, readEvidence)) {
        const resource = await readWikiResource({
          wikiRoot,
          resourceUri: evidence.uri,
          maxCharacters: 3_000,
        });
        reads.push(resource.text);
      }
      materializedText = reads.join("\n\n");
      materializeSamples.push(performance.now() - materializeStart);
    }

    const legacySize = estimateContextSize(legacyText);
    const editorialSize = estimateContextSize(editorialText);
    const manifestSize = estimateContextSize(manifestJson);
    const materializedSize = estimateContextSize(materializedText);
    const progressiveBytes = manifestSize.utf8Bytes + materializedSize.utf8Bytes;
    const progressiveHeuristicTokens = manifestSize.heuristicTokens + materializedSize.heuristicTokens;

    const report = {
      corpus: {
        pages: pageCount,
        iterations,
        maxEvidence,
        readEvidence,
        heuristicTokenBudget,
      },
      latency: {
        legacyContext: stats(legacySamples),
        editorialContext: stats(editorialSamples),
        manifest: stats(manifestSamples),
        materializeSelectedEvidence: stats(materializeSamples),
      },
      payload: {
        legacy: legacySize,
        editorial: editorialSize,
        manifestOnly: manifestSize,
        selectedEvidence: materializedSize,
        manifestPlusSelectedEvidence: {
          utf8Bytes: progressiveBytes,
          heuristicTokens: progressiveHeuristicTokens,
        },
        manifestReductionVsLegacyPercent: reductionPercent(manifestSize.utf8Bytes, legacySize.utf8Bytes),
        progressiveReductionVsLegacyPercent: reductionPercent(progressiveBytes, legacySize.utf8Bytes),
        editorialReductionVsLegacyPercent: reductionPercent(editorialSize.utf8Bytes, legacySize.utf8Bytes),
      },
      result: {
        evidenceCount,
        gapCount,
      },
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
