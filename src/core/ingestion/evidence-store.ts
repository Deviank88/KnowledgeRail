import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteText } from "../fs-service.js";
import { withWikiFileLock } from "../lock-service.js";
import { ensureDir, readFileSafe } from "../utils.js";
import { evidenceClaimIsValid, type EvidenceClaim } from "./evidence-claim.js";
import { WIKI_PAGE_TYPES } from "../wiki-validation.js";

export const EVIDENCE_IR_VERSION = "evidence-ir-v1";

export type EvidenceLinkDisposition =
  | "candidate_update"
  | "candidate_new_page"
  | "duplicate"
  | "contradiction"
  | "supersedes"
  | "ambiguous";

export interface EvidenceLinkResolution {
  claimId: string;
  disposition: EvidenceLinkDisposition;
  targetClaimIds: string[];
  candidatePagePaths: string[];
  targetPagePath?: string;
  targetPageTitle?: string;
  targetPageType?: string;
  reason: string;
  resolvedAt: string;
}

export interface EvidenceSynthesisRecord {
  pagePath: string;
  claimIds: string[];
  contentHash: string;
  synthesizedAt: string;
}

export interface EvidenceIrStore {
  version: 1;
  compilerVersion: string;
  createdAt: string;
  updatedAt: string;
  claims: EvidenceClaim[];
  resolutions: EvidenceLinkResolution[];
  syntheses: EvidenceSynthesisRecord[];
}

const DISPOSITIONS = new Set<EvidenceLinkDisposition>([
  "candidate_update",
  "candidate_new_page",
  "duplicate",
  "contradiction",
  "supersedes",
  "ambiguous",
]);
const PAGE_TYPES = new Set<string>(WIKI_PAGE_TYPES);

function validPagePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return normalized === value && path.posix.normalize(normalized) === normalized &&
    !path.posix.isAbsolute(normalized) &&
    normalized.toLowerCase().endsWith(".md") &&
    !parts.includes("..") && !parts.includes(".") && !parts.some((part) => !part) && !parts[0]?.startsWith(".") &&
    !["SCHEMA.md", "index.md", "log.md"].includes(normalized);
}

export function evidenceIrDir(wikiRoot: string): string {
  return path.join(path.dirname(path.resolve(wikiRoot)), "docs", "evidence-ir");
}

export function evidenceIrStoreFile(wikiRoot: string): string {
  return path.join(evidenceIrDir(wikiRoot), "store.json");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

function resolutionIsValid(value: unknown): value is EvidenceLinkResolution {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EvidenceLinkResolution>;
  return typeof item.claimId === "string" && /^claim-[a-f0-9]{32}$/.test(item.claimId) &&
    DISPOSITIONS.has(item.disposition as EvidenceLinkDisposition) &&
    stringArray(item.targetClaimIds) && stringArray(item.candidatePagePaths) &&
    item.candidatePagePaths.every(validPagePath) &&
    (item.targetPagePath === undefined ||
      (typeof item.targetPagePath === "string" && validPagePath(item.targetPagePath))) &&
    (item.targetPageTitle === undefined || typeof item.targetPageTitle === "string") &&
    (item.targetPageType === undefined ||
      (typeof item.targetPageType === "string" && PAGE_TYPES.has(item.targetPageType))) &&
    typeof item.reason === "string" && item.reason.trim().length > 0 &&
    typeof item.resolvedAt === "string";
}

function synthesisIsValid(value: unknown): value is EvidenceSynthesisRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EvidenceSynthesisRecord>;
  return typeof item.pagePath === "string" && validPagePath(item.pagePath) &&
    stringArray(item.claimIds) && typeof item.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(item.contentHash) && typeof item.synthesizedAt === "string";
}

function storeIsValid(value: unknown): value is EvidenceIrStore {
  if (!value || typeof value !== "object") return false;
  const store = value as Partial<EvidenceIrStore>;
  if (
    store.version !== 1 || store.compilerVersion !== EVIDENCE_IR_VERSION ||
    typeof store.createdAt !== "string" || typeof store.updatedAt !== "string" ||
    !Array.isArray(store.claims) || !store.claims.every(evidenceClaimIsValid) ||
    !Array.isArray(store.resolutions) || !store.resolutions.every(resolutionIsValid) ||
    !Array.isArray(store.syntheses) || !store.syntheses.every(synthesisIsValid)
  ) return false;
  const claimIds = new Set(store.claims.map((claim) => claim.id));
  if (claimIds.size !== store.claims.length) return false;
  if (store.claims.some((claim) => claim.relations.some((relation) =>
    relation.targetClaimId === claim.id || !claimIds.has(relation.targetClaimId)
  ))) return false;
  if (new Set(store.resolutions.map((item) => item.claimId)).size !== store.resolutions.length) return false;
  if (store.resolutions.some((item) =>
    !claimIds.has(item.claimId) || item.targetClaimIds.some((id) => !claimIds.has(id))
  )) return false;
  return store.syntheses.every((item) => item.claimIds.every((id) => claimIds.has(id)));
}

function emptyStore(now = new Date().toISOString()): EvidenceIrStore {
  return {
    version: 1,
    compilerVersion: EVIDENCE_IR_VERSION,
    createdAt: now,
    updatedAt: now,
    claims: [],
    resolutions: [],
    syntheses: [],
  };
}

export async function readEvidenceIrStore(wikiRoot: string): Promise<EvidenceIrStore> {
  const storeDir = evidenceIrDir(wikiRoot);
  const workspaceRoot = path.dirname(path.resolve(wikiRoot));
  try {
    const [workspaceReal, storeDirReal] = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.realpath(storeDir),
    ]);
    const relative = path.relative(workspaceReal, storeDirReal);
    if (relative.replace(/\\/g, "/") !== "docs/evidence-ir") {
      throw new Error("Evidence IR store does not resolve to docs/evidence-ir inside the workspace root.");
    }
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const storeFile = evidenceIrStoreFile(wikiRoot);
  try {
    const [workspaceReal, storeFileReal] = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.realpath(storeFile),
    ]);
    const relative = path.relative(workspaceReal, storeFileReal);
    if (relative.replace(/\\/g, "/") !== "docs/evidence-ir/store.json") {
      throw new Error("Evidence IR store file does not resolve to docs/evidence-ir/store.json inside the workspace root.");
    }
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const raw = await readFileSafe(storeFile);
  if (raw === null) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Evidence IR store is invalid JSON; refusing to overwrite durable evidence.");
  }
  if (!storeIsValid(parsed)) {
    throw new Error("Evidence IR store is invalid; refusing to overwrite durable evidence.");
  }
  return parsed;
}

async function writeEvidenceIrStore(wikiRoot: string, store: EvidenceIrStore): Promise<void> {
  if (!storeIsValid(store)) throw new Error("Refusing to persist an invalid Evidence IR store.");
  const workspaceRoot = path.dirname(path.resolve(wikiRoot));
  const workspaceReal = await fs.realpath(workspaceRoot);
  const storeDir = evidenceIrDir(wikiRoot);
  const docsDir = path.dirname(storeDir);
  try {
    const docsReal = await fs.realpath(docsDir);
    const docsRelative = path.relative(workspaceReal, docsReal);
    if (docsRelative.replace(/\\/g, "/") !== "docs") {
      throw new Error("Evidence IR docs directory does not resolve inside the workspace root.");
    }
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await ensureDir(storeDir);
  const storeDirReal = await fs.realpath(storeDir);
  const relative = path.relative(workspaceReal, storeDirReal);
  if (relative.replace(/\\/g, "/") !== "docs/evidence-ir") {
    throw new Error("Evidence IR store does not resolve to docs/evidence-ir inside the workspace root.");
  }
  await atomicWriteText(evidenceIrStoreFile(wikiRoot), `${JSON.stringify(store, null, 2)}\n`);
}

export async function mutateEvidenceIrStore<T>(
  wikiRoot: string,
  operation: (store: EvidenceIrStore) => Promise<T> | T
): Promise<T> {
  const key = path.resolve(evidenceIrStoreFile(wikiRoot));
  return withWikiFileLock(wikiRoot, key, async () => {
    const store = await readEvidenceIrStore(wikiRoot);
    const result = await operation(store);
    store.updatedAt = new Date().toISOString();
    await writeEvidenceIrStore(wikiRoot, store);
    return result;
  });
}
