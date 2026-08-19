import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteText } from "./fs-service.js";
import { readEvidenceIrStore } from "./ingestion/evidence-store.js";
import { withWikiFileLock } from "./lock-service.js";
import { wikiMetaDir } from "./manifest-service.js";
import { readFileSafe } from "./utils.js";
import { codeAnchorHash } from "./code-evidence/code-anchor.js";
import { defaultParserVersionForPath } from "./code-evidence/adapter-registry.js";
import { readConfinedRepositoryFile } from "./code-evidence/confined-reader.js";
import type { CodeAnchor } from "./code-evidence/types.js";

export const DRIFT_LEDGER_VERSION = 1 as const;

export type DriftVerdict = "fresh" | "drift_suspected" | "anchor_unresolvable";
export type DriftReason =
  | "content_changed"
  | "range_out_of_bounds"
  | "file_missing"
  | "parser_version_changed";

export interface DriftLedgerEntry {
  claimId: string;
  pagePaths: string[];
  anchor: CodeAnchor;
  checkedAt: string;
  observedRangeHash?: string;
  verdict: DriftVerdict;
  reason?: DriftReason;
}

export interface DriftLedger {
  version: typeof DRIFT_LEDGER_VERSION;
  checkedAt: string;
  entries: DriftLedgerEntry[];
}

export interface DriftEvaluation {
  verdict: DriftVerdict;
  reason?: DriftReason;
  observedRangeHash?: string;
}

export interface StaleClaimsForPage {
  claimIds: string[];
  reason: Exclude<DriftVerdict, "fresh">;
}

export interface DriftSummary {
  checkedAt: string;
  scope: "all" | "paths";
  paths: string[];
  totalAnchors: number;
  checkedAnchors: number;
  fresh: number;
  driftSuspected: number;
  anchorUnresolvable: number;
  topDrifted: Array<{
    claimId: string;
    pagePaths: string[];
    path: string;
    startLine: number;
    endLine: number;
    reason: DriftReason;
    citationCount: number;
  }>;
  recommendedClaimIds: string[];
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validAnchor(value: unknown): value is CodeAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Partial<CodeAnchor>;
  let normalizedPath: string;
  try {
    normalizedPath = typeof anchor.path === "string" ? normalizeRepositoryPath(anchor.path) : "";
  } catch {
    return false;
  }
  return typeof anchor.path === "string" && anchor.path === normalizedPath &&
    Number.isInteger(anchor.startLine) && Number.isInteger(anchor.endLine) &&
    (anchor.startLine ?? 0) >= 1 && (anchor.endLine ?? 0) >= (anchor.startLine ?? 1) &&
    typeof anchor.rangeHash === "string" && /^[a-f0-9]{64}$/.test(anchor.rangeHash) &&
    typeof anchor.parserVersion === "string" && anchor.parserVersion.trim().length > 0 &&
    validIsoTimestamp(anchor.capturedAt);
}

function validEntry(value: unknown): value is DriftLedgerEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DriftLedgerEntry>;
  return typeof entry.claimId === "string" && /^claim-[a-f0-9]{32}$/.test(entry.claimId) &&
    Array.isArray(entry.pagePaths) && entry.pagePaths.every((page) => typeof page === "string") &&
    validAnchor(entry.anchor) && validIsoTimestamp(entry.checkedAt) &&
    (entry.observedRangeHash === undefined || /^[a-f0-9]{64}$/.test(entry.observedRangeHash)) &&
    ["fresh", "drift_suspected", "anchor_unresolvable"].includes(entry.verdict ?? "") &&
    (entry.reason === undefined || [
      "content_changed", "range_out_of_bounds", "file_missing", "parser_version_changed",
    ].includes(entry.reason));
}

function validateLedger(value: unknown): DriftLedger {
  if (!value || typeof value !== "object") throw new Error("Drift ledger is not an object.");
  const ledger = value as Partial<DriftLedger>;
  if (
    ledger.version !== DRIFT_LEDGER_VERSION || !validIsoTimestamp(ledger.checkedAt) ||
    !Array.isArray(ledger.entries) || !ledger.entries.every(validEntry) ||
    new Set(ledger.entries.map((entry) => entry.claimId)).size !== ledger.entries.length
  ) throw new Error("Drift ledger has an unsupported or invalid schema.");
  return ledger as DriftLedger;
}

export function normalizeRepositoryPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//u, "").normalize("NFC");
  if (
    !normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) ||
    path.posix.normalize(normalized) !== normalized ||
    normalized.split("/").some((part) => !part || part === "." || part === "..") || normalized.includes("\0")
  ) throw new Error(`Invalid repository-relative drift path: ${value}`);
  return normalized;
}

function pathMatches(pathValue: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathValue === prefix || pathValue.startsWith(`${prefix.replace(/\/$/u, "")}/`));
}

export function evaluateCodeAnchor(params: {
  anchor: CodeAnchor;
  content: string | null;
  parserVersion?: string;
}): DriftEvaluation {
  if (params.content === null) return { verdict: "drift_suspected", reason: "file_missing" };
  let observedRangeHash: string;
  try {
    observedRangeHash = codeAnchorHash(params.content, params.anchor.startLine, params.anchor.endLine);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("out of bounds")) {
      return { verdict: "drift_suspected", reason: "range_out_of_bounds" };
    }
    throw error;
  }
  if (observedRangeHash !== params.anchor.rangeHash) {
    return { verdict: "drift_suspected", reason: "content_changed", observedRangeHash };
  }
  const parserChanged = (
    params.parserVersion ?? defaultParserVersionForPath(params.anchor.path) ?? params.anchor.parserVersion
  ) !== params.anchor.parserVersion;
  return {
    verdict: "fresh",
    ...(parserChanged ? { reason: "parser_version_changed" as const } : {}),
    observedRangeHash,
  };
}

export function driftLedgerFile(wikiRoot: string): string {
  return path.join(wikiMetaDir(wikiRoot), "drift", "ledger.json");
}

async function assertDriftPathSafe(wikiRoot: string, create: boolean): Promise<void> {
  const rootReal = await fs.realpath(wikiRoot);
  const expected: Array<{ directory: string; relative: string }> = [
    { directory: wikiMetaDir(wikiRoot), relative: ".knowledge-rail" },
    { directory: path.dirname(driftLedgerFile(wikiRoot)), relative: ".knowledge-rail/drift" },
  ];
  for (const item of expected) {
    try {
      const stat = await fs.lstat(item.directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Drift state directory is unsafe: ${item.relative}.`);
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (!create) return;
      await fs.mkdir(item.directory);
    }
    const real = await fs.realpath(item.directory);
    if (path.relative(rootReal, real).replace(/\\/g, "/") !== item.relative) {
      throw new Error(`Drift state directory resolves outside the wiki root: ${item.relative}.`);
    }
  }
  const file = driftLedgerFile(wikiRoot);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Drift ledger file is unsafe.");
    const real = await fs.realpath(file);
    if (path.relative(rootReal, real).replace(/\\/g, "/") !== ".knowledge-rail/drift/ledger.json") {
      throw new Error("Drift ledger resolves outside the wiki root.");
    }
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function emptyLedger(): DriftLedger {
  return { version: DRIFT_LEDGER_VERSION, checkedAt: new Date(0).toISOString(), entries: [] };
}

export async function readDriftLedger(wikiRoot: string): Promise<DriftLedger> {
  await assertDriftPathSafe(wikiRoot, false);
  const raw = await readFileSafe(driftLedgerFile(wikiRoot));
  if (raw === null) return emptyLedger();
  try {
    return validateLedger(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    throw new Error(`Cannot read drift ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeDriftLedger(wikiRoot: string, ledger: DriftLedger): Promise<void> {
  validateLedger(ledger);
  await assertDriftPathSafe(wikiRoot, true);
  await atomicWriteText(driftLedgerFile(wikiRoot), `${JSON.stringify(ledger, null, 2)}\n`);
}

type CurrentCodeRead =
  | { status: "readable"; content: string }
  | { status: "missing" }
  | { status: "unresolvable" };

async function readCurrentCode(
  repositoryRoot: string,
  repositoryRootReal: string,
  relativePath: string
): Promise<CurrentCodeRead> {
  try {
    const content = await readConfinedRepositoryFile({
      repositoryRoot,
      repositoryRootReal,
      relativePath,
      missing: "null",
      label: "Drift anchor",
    });
    return content === null ? { status: "missing" } : { status: "readable", content };
  } catch (error: unknown) {
    return { status: "unresolvable" };
  }
}

function pagePathsByClaim(store: Awaited<ReturnType<typeof readEvidenceIrStore>>): Map<string, string[]> {
  const pages = new Map<string, Set<string>>();
  const add = (claimId: string, pagePath: string | undefined): void => {
    if (!pagePath) return;
    const values = pages.get(claimId) ?? new Set<string>();
    values.add(pagePath);
    pages.set(claimId, values);
  };
  for (const synthesis of store.syntheses) {
    for (const claimId of synthesis.claimIds) add(claimId, synthesis.pagePath);
  }
  for (const resolution of store.resolutions) add(resolution.claimId, resolution.targetPagePath);
  return new Map([...pages].map(([claimId, values]) => [claimId, [...values].sort()]));
}

export async function detectCodeDrift(params: {
  repositoryRoot: string;
  wikiRoot: string;
  paths?: readonly string[];
  checkedAt?: string;
  topLimit?: number;
}): Promise<{ summary: DriftSummary; entries: DriftLedgerEntry[] }> {
  const checkedAt = params.checkedAt ?? new Date().toISOString();
  if (!validIsoTimestamp(checkedAt)) throw new Error("Drift checkedAt must be ISO-8601 compatible.");
  const prefixes = [...new Set((params.paths ?? []).map(normalizeRepositoryPath))].sort();
  const scope = prefixes.length > 0 ? "paths" as const : "all" as const;
  const repositoryRootReal = await fs.realpath(params.repositoryRoot);
  if (!(await fs.stat(repositoryRootReal)).isDirectory()) {
    throw new Error("Drift repository root is not a directory.");
  }
  const store = await readEvidenceIrStore(params.wikiRoot);
  const allAnchored = store.claims.filter((claim) => claim.codeAnchor !== undefined);
  const selected = allAnchored.filter((claim) =>
    scope === "all" || pathMatches(claim.codeAnchor!.path, prefixes)
  );
  const pages = pagePathsByClaim(store);
  const fileCache = new Map<string, Promise<CurrentCodeRead>>();
  const entries: DriftLedgerEntry[] = [];
  for (const claim of selected) {
    const anchor = claim.codeAnchor!;
    let content = fileCache.get(anchor.path);
    if (!content) {
      content = readCurrentCode(params.repositoryRoot, repositoryRootReal, anchor.path);
      fileCache.set(anchor.path, content);
    }
    const current = await content;
    const evaluation: DriftEvaluation = current.status === "unresolvable"
      ? { verdict: "anchor_unresolvable" }
      : evaluateCodeAnchor({
          anchor,
          content: current.status === "missing" ? null : current.content,
          parserVersion: defaultParserVersionForPath(anchor.path) ?? anchor.parserVersion,
        });
    entries.push({
      claimId: claim.id,
      pagePaths: pages.get(claim.id) ?? [],
      anchor,
      checkedAt,
      ...(evaluation.observedRangeHash ? { observedRangeHash: evaluation.observedRangeHash } : {}),
      verdict: evaluation.verdict,
      ...(evaluation.reason ? { reason: evaluation.reason } : {}),
    });
  }
  entries.sort((left, right) => left.claimId.localeCompare(right.claimId));

  const file = driftLedgerFile(params.wikiRoot);
  await withWikiFileLock(params.wikiRoot, file, async () => {
    const previous = await readDriftLedger(params.wikiRoot);
    const nextEntries = scope === "all"
      ? entries
      : [
          ...previous.entries.filter((entry) => !pathMatches(entry.anchor.path, prefixes)),
          ...entries,
        ]
          .sort((left, right) => left.claimId.localeCompare(right.claimId));
    await writeDriftLedger(params.wikiRoot, { version: DRIFT_LEDGER_VERSION, checkedAt, entries: nextEntries });
  });

  const inboundRelations = new Map<string, number>();
  for (const claim of store.claims) {
    for (const relation of claim.relations) {
      inboundRelations.set(relation.targetClaimId, (inboundRelations.get(relation.targetClaimId) ?? 0) + 1);
    }
  }
  const drifted = entries
    .filter((entry) => entry.verdict === "drift_suspected")
    .map((entry) => ({
      claimId: entry.claimId,
      pagePaths: entry.pagePaths,
      path: entry.anchor.path,
      startLine: entry.anchor.startLine,
      endLine: entry.anchor.endLine,
      reason: entry.reason ?? "content_changed" as DriftReason,
      citationCount: entry.pagePaths.length + (inboundRelations.get(entry.claimId) ?? 0),
    }))
    .sort((left, right) => right.citationCount - left.citationCount || left.claimId.localeCompare(right.claimId));
  const topLimit = Math.max(1, Math.min(100, params.topLimit ?? 20));
  const unresolvable = entries
    .filter((entry) => entry.verdict === "anchor_unresolvable")
    .map((entry) => ({
      claimId: entry.claimId,
      citationCount: entry.pagePaths.length + (inboundRelations.get(entry.claimId) ?? 0),
    }))
    .sort((left, right) => right.citationCount - left.citationCount || left.claimId.localeCompare(right.claimId));
  const recommendedClaimIds = [
    ...drifted.map((entry) => ({ claimId: entry.claimId, citationCount: entry.citationCount })),
    ...unresolvable,
  ]
    .sort((left, right) => right.citationCount - left.citationCount || left.claimId.localeCompare(right.claimId))
    .slice(0, 5)
    .map((entry) => entry.claimId);
  const summary: DriftSummary = {
    checkedAt,
    scope,
    paths: prefixes,
    totalAnchors: allAnchored.length,
    checkedAnchors: entries.length,
    fresh: entries.filter((entry) => entry.verdict === "fresh").length,
    driftSuspected: drifted.length,
    anchorUnresolvable: entries.filter((entry) => entry.verdict === "anchor_unresolvable").length,
    topDrifted: drifted.slice(0, topLimit),
    recommendedClaimIds,
  };
  return { summary, entries };
}

export async function staleClaimsByPage(wikiRoot: string): Promise<Map<string, StaleClaimsForPage>> {
  const ledger = await readDriftLedger(wikiRoot);
  const byPage = new Map<string, { claimIds: Set<string>; reason: Exclude<DriftVerdict, "fresh"> }>();
  for (const entry of ledger.entries) {
    if (entry.verdict === "fresh") continue;
    for (const pagePath of entry.pagePaths) {
      const state = byPage.get(pagePath) ?? { claimIds: new Set<string>(), reason: entry.verdict };
      state.claimIds.add(entry.claimId);
      if (entry.verdict === "anchor_unresolvable") state.reason = "anchor_unresolvable";
      byPage.set(pagePath, state);
    }
  }
  return new Map([...byPage].map(([pagePath, state]) => [pagePath, {
    claimIds: [...state.claimIds].sort(),
    reason: state.reason,
  }]));
}
