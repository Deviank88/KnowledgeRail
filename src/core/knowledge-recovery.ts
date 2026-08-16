import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseWikiResourceUri } from "../context/resource-uri.js";
import { atomicWriteText } from "./fs-service.js";
import { withWikiFileLock } from "./lock-service.js";
import { safeResolveWithin } from "./paths.js";
import { ensureDir, readFileSafe } from "./utils.js";
import { hasErrors, validateWikiPageContent } from "./wiki-validation.js";
import { readSourceCoverageLedger } from "./ingestion/coverage-ledger.js";
import { reconcileEvidenceCoverage } from "./ingestion/evidence-pipeline.js";
import { evidenceIrDir, readEvidenceIrStore } from "./ingestion/evidence-store.js";
import { sourceRecordSegment } from "./ingestion/source-compiler.js";

export const KNOWLEDGE_RECOVERY_DISCOVERY_METHODS = [
  "source_fallback",
  "code_index",
  "grep_fallback",
  "graph_widening",
  "contradiction_check",
] as const;

export const KNOWLEDGE_RECOVERY_RESOLUTIONS = [
  "pending",
  "page_updated",
  "new_page",
  "ledger_updated",
  "intentionally_ignored",
] as const;

export type KnowledgeRecoveryDiscoveryMethod =
  (typeof KNOWLEDGE_RECOVERY_DISCOVERY_METHODS)[number];
export type KnowledgeRecoveryResolution =
  (typeof KNOWLEDGE_RECOVERY_RESOLUTIONS)[number];

export interface KnowledgeRecoveryEventInput {
  evidenceRef: string;
  sourceUri: string;
  discoveredBy: KnowledgeRecoveryDiscoveryMethod;
  expectedWikiPages?: readonly string[];
  reason: string;
}

export interface KnowledgeRecoveryEvent {
  id: string;
  evidenceRef: string;
  sourceUri: string;
  discoveredBy: KnowledgeRecoveryDiscoveryMethod;
  expectedWikiPages: string[];
  reason: string;
  resolution: KnowledgeRecoveryResolution;
  occurrences: number;
  firstDiscoveredAt: string;
  lastDiscoveredAt: string;
  resolvedAt?: string;
  resolutionReason?: string;
  pageRefs: string[];
}

export interface KnowledgeRecoveryStore {
  version: 1;
  createdAt: string;
  updatedAt: string;
  totalEvidenceUsed: number;
  lateRecoveryEvidenceUsed: number;
  events: KnowledgeRecoveryEvent[];
}

export interface KnowledgeRecoveryMetrics {
  lateRecoveryRate: number;
  totalEvidenceUsed: number;
  lateRecoveryEvidenceUsed: number;
  knowledgeRecoveryPending: number;
  resolvedEventCount: number;
  uniqueRecoveryEventCount: number;
}

export interface KnowledgeRecoveryRecordResult {
  events: KnowledgeRecoveryEvent[];
  created: number;
  reused: number;
  reopened: number;
  metrics: KnowledgeRecoveryMetrics;
}

const DISCOVERY_METHODS = new Set<string>(KNOWLEDGE_RECOVERY_DISCOVERY_METHODS);
const RESOLUTIONS = new Set<string>(KNOWLEDGE_RECOVERY_RESOLUTIONS);
const CLAIM_ID = /^claim-[a-f0-9]{32}$/;
const SEGMENT_ID = /^seg-[a-f0-9]{24}$/;

function isoTimestamp(value: string): boolean {
  return value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must contain 1-${maximum} printable characters.`);
  }
  return normalized;
}

function normalizeDocsPath(value: string, label: string): string {
  const slashes = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(slashes);
  const parts = normalized.split("/");
  if (
    normalized !== slashes || !normalized.startsWith("docs/") ||
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Error(`${label} must be a normalized path inside docs/: ${value}`);
  }
  return normalized;
}

function validateCodeUri(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid code evidence URI: ${value}`);
  }
  if (parsed.protocol !== "code:" || parsed.hostname !== "repo" || parsed.username || parsed.password) {
    throw new Error(`${label} must use code://repo/: ${value}`);
  }
  let decoded: string[];
  try {
    decoded = parsed.pathname.replace(/^\/+/, "").split("/").map(decodeURIComponent);
  } catch {
    throw new Error(`${label} contains invalid percent encoding: ${value}`);
  }
  if (
    decoded.length === 0 || decoded.some((part) =>
      !part || part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0")
    )
  ) {
    throw new Error(`${label} contains an invalid repository path: ${value}`);
  }
  return value;
}

function normalizeSourceUri(value: string): string {
  const trimmed = boundedText(value, "Recovery source URI", 4_096);
  if (trimmed.startsWith("docs/") || trimmed.startsWith("docs\\")) {
    return normalizeDocsPath(trimmed, "Recovery source URI");
  }
  if (trimmed.startsWith("code://")) return validateCodeUri(trimmed, "Recovery source URI");
  if (trimmed.startsWith("knowledge-rail://")) {
    parseWikiResourceUri(trimmed);
    return trimmed;
  }
  throw new Error(`Unsupported recovery source URI: ${value}`);
}

function normalizeEvidenceRef(value: string, sourceUri: string): string {
  const trimmed = boundedText(value, "Recovery evidence ref", 4_096);
  if (CLAIM_ID.test(trimmed)) return trimmed;
  if (trimmed.startsWith("code://")) return validateCodeUri(trimmed, "Recovery evidence ref");
  if (trimmed.startsWith("knowledge-rail://")) {
    parseWikiResourceUri(trimmed);
    return trimmed;
  }
  const marker = trimmed.lastIndexOf("#");
  if (marker > 0 && SEGMENT_ID.test(trimmed.slice(marker + 1))) {
    const evidenceSource = normalizeDocsPath(trimmed.slice(0, marker), "Recovery evidence ref");
    if (evidenceSource !== sourceUri) {
      throw new Error("Recovery evidence ref and source URI identify different sources.");
    }
    return `${evidenceSource}#${trimmed.slice(marker + 1)}`;
  }
  throw new Error(`Unsupported recovery evidence ref: ${value}`);
}

function normalizePagePath(value: string): string {
  const slashes = value.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashes);
  const parts = normalized.split("/");
  if (
    normalized !== slashes || path.posix.isAbsolute(slashes) || !normalized.toLowerCase().endsWith(".md") ||
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\0")) ||
    parts[0]?.startsWith(".") || ["SCHEMA.md", "index.md", "log.md"].includes(normalized)
  ) {
    throw new Error(`Recovery page ref must be a relative wiki Markdown path: ${value}`);
  }
  return normalized;
}

function uniqueSorted(values: readonly string[], normalize: (value: string) => string): string[] {
  return [...new Set(values.map(normalize))].sort((left, right) => left.localeCompare(right));
}

function normalizeEventInput(input: KnowledgeRecoveryEventInput): KnowledgeRecoveryEventInput & {
  expectedWikiPages: string[];
} {
  const sourceUri = normalizeSourceUri(input.sourceUri);
  const evidenceRef = normalizeEvidenceRef(input.evidenceRef, sourceUri);
  if (!DISCOVERY_METHODS.has(input.discoveredBy)) {
    throw new Error(`Unsupported knowledge recovery discovery method: ${input.discoveredBy}.`);
  }
  return {
    evidenceRef,
    sourceUri,
    discoveredBy: input.discoveredBy,
    expectedWikiPages: uniqueSorted(input.expectedWikiPages ?? [], normalizePagePath),
    reason: boundedText(input.reason, "Recovery reason", 1_024),
  };
}

export function knowledgeRecoveryEventId(params: {
  evidenceRef: string;
  sourceUri: string;
}): string {
  const sourceUri = normalizeSourceUri(params.sourceUri);
  const evidenceRef = normalizeEvidenceRef(params.evidenceRef, sourceUri);
  return `recovery-${createHash("sha256")
    .update("knowledge-recovery-v1\0")
    .update(sourceUri)
    .update("\0")
    .update(evidenceRef)
    .digest("hex")
    .slice(0, 32)}`;
}

function emptyStore(now = new Date().toISOString()): KnowledgeRecoveryStore {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    totalEvidenceUsed: 0,
    lateRecoveryEvidenceUsed: 0,
    events: [],
  };
}

function eventIsValid(value: unknown): value is KnowledgeRecoveryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<KnowledgeRecoveryEvent>;
  try {
    if (
      typeof event.id !== "string" || typeof event.evidenceRef !== "string" ||
      typeof event.sourceUri !== "string" || typeof event.discoveredBy !== "string" ||
      typeof event.reason !== "string" || typeof event.resolution !== "string" ||
      !Array.isArray(event.expectedWikiPages) || !Array.isArray(event.pageRefs) ||
      !Number.isInteger(event.occurrences) || (event.occurrences ?? 0) < 1 ||
      typeof event.firstDiscoveredAt !== "string" || typeof event.lastDiscoveredAt !== "string" ||
      !isoTimestamp(event.firstDiscoveredAt) || !isoTimestamp(event.lastDiscoveredAt) ||
      !RESOLUTIONS.has(event.resolution)
    ) return false;
    const normalized = normalizeEventInput({
      evidenceRef: event.evidenceRef,
      sourceUri: event.sourceUri,
      discoveredBy: event.discoveredBy as KnowledgeRecoveryDiscoveryMethod,
      expectedWikiPages: event.expectedWikiPages,
      reason: event.reason,
    });
    if (
      event.id !== knowledgeRecoveryEventId(normalized) ||
      normalized.evidenceRef !== event.evidenceRef || normalized.sourceUri !== event.sourceUri ||
      normalized.reason !== event.reason ||
      JSON.stringify(normalized.expectedWikiPages) !== JSON.stringify(event.expectedWikiPages) ||
      JSON.stringify(uniqueSorted(event.pageRefs, normalizePagePath)) !== JSON.stringify(event.pageRefs)
    ) return false;
    if (event.resolution === "pending") {
      return event.resolvedAt === undefined && event.resolutionReason === undefined && event.pageRefs.length === 0;
    }
    if (
      typeof event.resolvedAt !== "string" || !isoTimestamp(event.resolvedAt) ||
      typeof event.resolutionReason !== "string" || !event.resolutionReason.trim()
    ) return false;
    if (boundedText(event.resolutionReason, "Recovery resolution reason", 1_024) !== event.resolutionReason) {
      return false;
    }
    if ((event.resolution === "page_updated" || event.resolution === "new_page") && event.pageRefs.length === 0) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function storeIsValid(value: unknown): value is KnowledgeRecoveryStore {
  if (!value || typeof value !== "object") return false;
  const store = value as Partial<KnowledgeRecoveryStore>;
  if (
    store.version !== 1 || typeof store.createdAt !== "string" || typeof store.updatedAt !== "string" ||
    !isoTimestamp(store.createdAt) || !isoTimestamp(store.updatedAt) ||
    !Number.isInteger(store.totalEvidenceUsed) || (store.totalEvidenceUsed ?? -1) < 0 ||
    !Number.isInteger(store.lateRecoveryEvidenceUsed) || (store.lateRecoveryEvidenceUsed ?? -1) < 0 ||
    (store.lateRecoveryEvidenceUsed ?? 0) > (store.totalEvidenceUsed ?? 0) ||
    !Array.isArray(store.events) || !store.events.every(eventIsValid)
  ) return false;
  const events = store.events;
  const ids = events.map((event) => event.id);
  return new Set(ids).size === ids.length &&
    events.reduce((sum, event) => sum + event.occurrences, 0) === store.lateRecoveryEvidenceUsed &&
    events.every((event, index) => index === 0 || events[index - 1]!.id.localeCompare(event.id) < 0);
}

export function knowledgeRecoveryStoreFile(wikiRoot: string): string {
  return path.join(evidenceIrDir(wikiRoot), "knowledge-recovery.json");
}

async function assertStorePathSafe(wikiRoot: string, create: boolean): Promise<void> {
  const workspaceRoot = path.dirname(path.resolve(wikiRoot));
  if (create) await fs.mkdir(workspaceRoot, { recursive: true });
  let workspaceReal: string;
  try {
    workspaceReal = await fs.realpath(workspaceRoot);
  } catch (error: unknown) {
    if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const docsDir = path.join(workspaceRoot, "docs");
  try {
    const docsReal = await fs.realpath(docsDir);
    if (path.relative(workspaceReal, docsReal).replace(/\\/g, "/") !== "docs") {
      throw new Error("Knowledge recovery docs directory does not resolve inside the workspace root.");
    }
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const storeDir = evidenceIrDir(wikiRoot);
  if (create) await ensureDir(storeDir);
  try {
    const storeDirReal = await fs.realpath(storeDir);
    if (path.relative(workspaceReal, storeDirReal).replace(/\\/g, "/") !== "docs/evidence-ir") {
      throw new Error("Knowledge recovery store does not resolve to docs/evidence-ir.");
    }
  } catch (error: unknown) {
    if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const storeFile = knowledgeRecoveryStoreFile(wikiRoot);
  try {
    const stat = await fs.lstat(storeFile);
    if (stat.isSymbolicLink()) throw new Error("Knowledge recovery store must not be a symbolic link.");
    const fileReal = await fs.realpath(storeFile);
    if (path.relative(workspaceReal, fileReal).replace(/\\/g, "/") !== "docs/evidence-ir/knowledge-recovery.json") {
      throw new Error("Knowledge recovery store resolves outside docs/evidence-ir.");
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function readKnowledgeRecoveryStore(wikiRoot: string): Promise<KnowledgeRecoveryStore> {
  await assertStorePathSafe(wikiRoot, false);
  const raw = await readFileSafe(knowledgeRecoveryStoreFile(wikiRoot));
  if (raw === null) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Knowledge recovery store is invalid JSON; refusing to overwrite durable debt.");
  }
  if (!storeIsValid(parsed)) {
    throw new Error("Knowledge recovery store is invalid; refusing to overwrite durable debt.");
  }
  return parsed;
}

async function mutateKnowledgeRecoveryStore<T>(
  wikiRoot: string,
  operation: (store: KnowledgeRecoveryStore) => Promise<T> | T
): Promise<T> {
  const key = path.resolve(knowledgeRecoveryStoreFile(wikiRoot));
  return withWikiFileLock(wikiRoot, key, async () => {
    const store = await readKnowledgeRecoveryStore(wikiRoot);
    const result = await operation(store);
    store.updatedAt = new Date().toISOString();
    if (!storeIsValid(store)) throw new Error("Refusing to persist an invalid knowledge recovery store.");
    await assertStorePathSafe(wikiRoot, true);
    await atomicWriteText(knowledgeRecoveryStoreFile(wikiRoot), `${JSON.stringify(store, null, 2)}\n`);
    return result;
  });
}

export function knowledgeRecoveryMetrics(store: KnowledgeRecoveryStore): KnowledgeRecoveryMetrics {
  return {
    lateRecoveryRate: store.totalEvidenceUsed === 0
      ? 0
      : store.lateRecoveryEvidenceUsed / store.totalEvidenceUsed,
    totalEvidenceUsed: store.totalEvidenceUsed,
    lateRecoveryEvidenceUsed: store.lateRecoveryEvidenceUsed,
    knowledgeRecoveryPending: store.events.filter((event) => event.resolution === "pending").length,
    resolvedEventCount: store.events.filter((event) => event.resolution !== "pending").length,
    uniqueRecoveryEventCount: store.events.length,
  };
}

export async function knowledgeRecoveryStatus(wikiRoot: string): Promise<{
  metrics: KnowledgeRecoveryMetrics;
  events: KnowledgeRecoveryEvent[];
}> {
  const store = await readKnowledgeRecoveryStore(wikiRoot);
  return { metrics: knowledgeRecoveryMetrics(store), events: store.events };
}

export async function recordKnowledgeRecoveryUsage(params: {
  wikiRoot: string;
  totalEvidenceUsed: number;
  events: readonly KnowledgeRecoveryEventInput[];
  timestamp?: string;
}): Promise<KnowledgeRecoveryRecordResult> {
  if (!Number.isInteger(params.totalEvidenceUsed) || params.totalEvidenceUsed < 0) {
    throw new Error("totalEvidenceUsed must be a non-negative integer.");
  }
  if (params.events.length > params.totalEvidenceUsed) {
    throw new Error("Late recovery events cannot exceed total evidence used.");
  }
  const timestamp = params.timestamp ?? new Date().toISOString();
  if (!isoTimestamp(timestamp)) throw new Error("Recovery timestamp must be ISO-8601 compatible.");
  const normalizedEvents = params.events.map(normalizeEventInput);

  return mutateKnowledgeRecoveryStore(params.wikiRoot, (store) => {
    store.totalEvidenceUsed += params.totalEvidenceUsed;
    store.lateRecoveryEvidenceUsed += normalizedEvents.length;
    const recorded: KnowledgeRecoveryEvent[] = [];
    let created = 0;
    let reused = 0;
    let reopened = 0;

    for (const input of normalizedEvents) {
      const id = knowledgeRecoveryEventId(input);
      const existing = store.events.find((event) => event.id === id);
      if (!existing) {
        const event: KnowledgeRecoveryEvent = {
          id,
          evidenceRef: input.evidenceRef,
          sourceUri: input.sourceUri,
          discoveredBy: input.discoveredBy,
          expectedWikiPages: input.expectedWikiPages,
          reason: input.reason,
          resolution: "pending",
          occurrences: 1,
          firstDiscoveredAt: timestamp,
          lastDiscoveredAt: timestamp,
          pageRefs: [],
        };
        store.events.push(event);
        recorded.push(event);
        created++;
        continue;
      }

      existing.occurrences++;
      existing.lastDiscoveredAt = timestamp;
      existing.expectedWikiPages = uniqueSorted(
        [...existing.expectedWikiPages, ...input.expectedWikiPages],
        normalizePagePath
      );
      if (existing.resolution === "pending") {
        reused++;
      } else {
        existing.resolution = "pending";
        existing.pageRefs = [];
        delete existing.resolvedAt;
        delete existing.resolutionReason;
        reopened++;
      }
      recorded.push(existing);
    }
    store.events.sort((left, right) => left.id.localeCompare(right.id));
    return {
      events: recorded,
      created,
      reused,
      reopened,
      metrics: knowledgeRecoveryMetrics(store),
    };
  });
}

interface SourceProvenance {
  sourceUri: string;
  segmentId: string;
  evidenceRef: string;
}

async function sourceProvenanceForEvent(
  wikiRoot: string,
  event: KnowledgeRecoveryEvent,
  requireClaim: boolean
): Promise<SourceProvenance | null> {
  if (!event.sourceUri.startsWith("docs/")) return null;
  if (CLAIM_ID.test(event.evidenceRef)) {
    const store = await readEvidenceIrStore(wikiRoot);
    const claim = store.claims.find((item) => item.id === event.evidenceRef);
    if (!claim) throw new Error(`Recovery event references an unknown Evidence IR claim: ${event.evidenceRef}.`);
    if (claim.sourceUri !== event.sourceUri) {
      throw new Error("Recovery event claim provenance does not match its source URI.");
    }
    return { sourceUri: claim.sourceUri, segmentId: claim.segmentId, evidenceRef: claim.id };
  }
  if (requireClaim) {
    throw new Error("Source-backed page recovery requires an Evidence IR claim reference.");
  }
  const marker = event.evidenceRef.lastIndexOf("#");
  const segmentId = marker > 0 ? event.evidenceRef.slice(marker + 1) : "";
  if (!SEGMENT_ID.test(segmentId) || event.evidenceRef.slice(0, marker) !== event.sourceUri) {
    throw new Error("Recovery event does not identify a valid source segment.");
  }
  return { sourceUri: event.sourceUri, segmentId, evidenceRef: event.evidenceRef };
}

async function readValidatedRecoveryPage(
  wikiRoot: string,
  pageRef: string,
  evidenceRef: string
): Promise<string> {
  const absolute = safeResolveWithin(wikiRoot, pageRef);
  const [rootReal, targetReal] = await Promise.all([
    fs.realpath(wikiRoot),
    fs.realpath(absolute),
  ]);
  const relative = path.relative(rootReal, targetReal);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Recovery page resolves outside the wiki root: ${pageRef}`);
  }
  const stat = await fs.stat(targetReal);
  if (!stat.isFile()) throw new Error(`Recovery page is not a regular file: ${pageRef}`);
  const content = await fs.readFile(targetReal, "utf8");
  const validation = await validateWikiPageContent(content, { checkSourceExists: false });
  if (hasErrors(validation.issues)) throw new Error(`Recovery page is not a valid wiki page: ${pageRef}.`);
  if (!content.includes(evidenceRef)) {
    throw new Error(`Recovery page does not preserve the exact evidence reference ${evidenceRef}: ${pageRef}.`);
  }
  return content;
}

async function readWorkspaceSource(wikiRoot: string, sourceUri: string): Promise<string> {
  const workspaceRoot = path.dirname(path.resolve(wikiRoot));
  const lexicalTarget = safeResolveWithin(workspaceRoot, sourceUri);
  const [rootReal, targetReal] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(lexicalTarget),
  ]);
  const relative = path.relative(rootReal, targetReal);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Recovery source resolves outside the workspace root: ${sourceUri}`);
  }
  const stat = await fs.stat(targetReal);
  if (!stat.isFile()) throw new Error(`Recovery source is not a regular file: ${sourceUri}`);
  return fs.readFile(targetReal, "utf8");
}

async function assertLedgerResolution(
  wikiRoot: string,
  provenance: SourceProvenance,
  pageRefs: readonly string[]
): Promise<void> {
  const ledger = await readSourceCoverageLedger(wikiRoot, provenance.sourceUri);
  if (!ledger) throw new Error("Recovery source coverage is unknown.");
  const segment = ledger.segments.find((item) => item.id === provenance.segmentId);
  if (!segment) throw new Error(`Recovery source segment no longer exists: ${provenance.segmentId}.`);
  if (segment.status === "unresolved" || segment.status === "legacy_unverified") {
    throw new Error(`Recovery source segment remains unresolved: ${provenance.segmentId}.`);
  }
  if (CLAIM_ID.test(provenance.evidenceRef) && !segment.evidenceRefs.includes(provenance.evidenceRef)) {
    throw new Error("Recovery source ledger does not reference the Evidence IR claim.");
  }
  if (pageRefs.length > 0 && !pageRefs.some((pageRef) => segment.pageRefs.includes(pageRef))) {
    throw new Error("Recovery source ledger does not reference the updated wiki page.");
  }
}

async function validateRecoveryResolution(params: {
  wikiRoot: string;
  event: KnowledgeRecoveryEvent;
  resolution: Exclude<KnowledgeRecoveryResolution, "pending">;
  pageRefs: string[];
  reason: string;
}): Promise<void> {
  const { event, resolution, pageRefs } = params;
  if (resolution === "page_updated" || resolution === "new_page") {
    if (pageRefs.length === 0) throw new Error(`${resolution} requires at least one page ref.`);
    if (
      event.expectedWikiPages.length > 0 &&
      !pageRefs.some((pageRef) => event.expectedWikiPages.includes(pageRef))
    ) {
      throw new Error("Recovery resolution does not include any expected wiki page.");
    }
    await Promise.all(pageRefs.map((pageRef) =>
      readValidatedRecoveryPage(params.wikiRoot, pageRef, event.evidenceRef)
    ));
    const provenance = await sourceProvenanceForEvent(params.wikiRoot, event, true);
    if (provenance) {
      await reconcileEvidenceCoverage(params.wikiRoot);
      await assertLedgerResolution(params.wikiRoot, provenance, pageRefs);
    }
    return;
  }

  const provenance = await sourceProvenanceForEvent(params.wikiRoot, event, false);
  if (resolution === "ledger_updated") {
    if (!provenance) throw new Error("ledger_updated requires a docs/ source with segment provenance.");
    await assertLedgerResolution(params.wikiRoot, provenance, []);
    return;
  }

  if (resolution === "intentionally_ignored" && provenance) {
    const ledger = await readSourceCoverageLedger(params.wikiRoot, provenance.sourceUri);
    if (!ledger) throw new Error("Recovery source coverage is unknown.");
    const segment = ledger.segments.find((item) => item.id === provenance.segmentId);
    if (!segment) throw new Error(`Recovery source segment no longer exists: ${provenance.segmentId}.`);
    const unrelatedRefs = segment.evidenceRefs.filter((ref) => ref !== provenance.evidenceRef);
    if (unrelatedRefs.length > 0 || segment.pageRefs.length > 0) {
      throw new Error("Cannot ignore one recovery event by overwriting a segment with other evidence or page refs.");
    }
    const content = await readWorkspaceSource(params.wikiRoot, provenance.sourceUri);
    await sourceRecordSegment({
      wikiRoot: params.wikiRoot,
      sourceUri: provenance.sourceUri,
      content,
      segmentId: provenance.segmentId,
      resolution: {
        status: "irrelevant",
        evidenceRefs: [provenance.evidenceRef],
        reason: `knowledge_recovery_intentionally_ignored: ${params.reason}`,
      },
    });
  }
}

export async function resolveKnowledgeRecoveryEvent(params: {
  wikiRoot: string;
  eventId: string;
  resolution: Exclude<KnowledgeRecoveryResolution, "pending">;
  pageRefs?: readonly string[];
  reason: string;
  timestamp?: string;
}): Promise<{ event: KnowledgeRecoveryEvent; metrics: KnowledgeRecoveryMetrics }> {
  if ((params.resolution as string) === "pending" || !RESOLUTIONS.has(params.resolution)) {
    throw new Error("Recovery resolution must close the pending event explicitly.");
  }
  const eventId = boundedText(params.eventId, "Recovery event ID", 128);
  if (!/^recovery-[a-f0-9]{32}$/.test(eventId)) throw new Error(`Invalid recovery event ID: ${eventId}.`);
  const reason = boundedText(params.reason, "Recovery resolution reason", 1_024);
  const pageRefs = uniqueSorted(params.pageRefs ?? [], normalizePagePath);
  const timestamp = params.timestamp ?? new Date().toISOString();
  if (!isoTimestamp(timestamp)) throw new Error("Recovery resolution timestamp must be ISO-8601 compatible.");

  return mutateKnowledgeRecoveryStore(params.wikiRoot, async (store) => {
    const target = store.events.find((item) => item.id === eventId);
    if (!target) throw new Error(`Unknown knowledge recovery event: ${eventId}.`);
    if (target.resolution !== "pending") {
      if (
        target.resolution === params.resolution && target.resolutionReason === reason &&
        JSON.stringify(target.pageRefs) === JSON.stringify(pageRefs)
      ) return { event: target, metrics: knowledgeRecoveryMetrics(store) };
      throw new Error(`Knowledge recovery event is already resolved: ${eventId}.`);
    }
    await validateRecoveryResolution({
      wikiRoot: params.wikiRoot,
      event: target,
      resolution: params.resolution,
      pageRefs,
      reason,
    });
    target.resolution = params.resolution;
    target.pageRefs = pageRefs;
    target.resolutionReason = reason;
    target.resolvedAt = timestamp;
    return { event: target, metrics: knowledgeRecoveryMetrics(store) };
  });
}
