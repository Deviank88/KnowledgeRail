import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { posix, relative, isAbsolute, resolve } from "node:path";
import { mapConcurrent } from "../concurrent-map.js";
import { safeResolveWithin } from "../paths.js";
import type { KnowledgeAdapterRegistry } from "./adapter-registry.js";
import type { ProjectManifest, ProjectManifestSpec, ProjectStructure } from "./types.js";

export const MAX_PROJECT_MANIFEST_BYTES = 256 * 1024;
const MANIFEST_READ_CONCURRENCY = 16;

interface Candidate { path: string; spec: ProjectManifestSpec }
interface RecordState { fingerprint: string; digest: string; manifest?: ProjectManifest; valueEstimatedBytes?: number }

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stamp(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
}

/** Ancestors come from indexed paths, never a conventional source-root name. */
function candidatesFor(paths: Iterable<string>, registry: KnowledgeAdapterRegistry): Candidate[] {
  const candidates = new Map<string, ProjectManifestSpec>();
  const registrations = registry.registrations.filter(({ adapter }) => adapter.projectManifests?.length);
  for (const path of paths) {
    const specs = registrations.find(({ adapter, extensionClaims }) =>
      extensionClaims.some((claim) => path.toLowerCase().endsWith(claim)) && adapter.supports({ path })
    )?.adapter.projectManifests;
    if (!specs?.length) continue;
    let directory = posix.dirname(path);
    while (true) {
      for (const spec of specs) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(spec.fileName)) throw new Error("Invalid adapter manifest filename.");
        candidates.set(posix.join(directory, spec.fileName), spec);
      }
      if (directory === ".") break;
      const parent = posix.dirname(directory);
      if (directory === parent || directory === ".." || directory.startsWith("../") || posix.isAbsolute(directory)) {
        throw new Error("Manifest inventory must contain repository-relative paths.");
      }
      directory = parent;
    }
  }
  return [...candidates].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, spec]) => ({ path, spec }));
}

/**
 * One disposable reader per code generation. Discover ancestor manifests once;
 * recheck known boundaries (including removed ones) and root manifests on queries.
 * New nested manifests require index refresh/update, as new source files do.
 * Retain compact parsed data, not manifest text or missing ancestor records.
 */
export class ProjectStructureReader {
  readonly repositoryRoot: string;
  private candidates: Candidate[];
  private records = new Map<string, RecordState>();
  private current?: ProjectStructure;
  private pending?: Promise<ProjectStructure>;
  /** Conservative admission estimate; not a V8 heap measurement. */
  estimatedBytes = 0;

  constructor(repositoryRoot: string, paths: Iterable<string>, registry: KnowledgeAdapterRegistry) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.candidates = candidatesFor(paths, registry);
  }

  load(): Promise<ProjectStructure> {
    if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async read(candidate: Candidate, rootReal: string): Promise<RecordState> {
    const { path, spec } = candidate;
    let leafExists = false;
    try {
      await fs.lstat(safeResolveWithin(this.repositoryRoot, path));
      leafExists = true;
      const target = await fs.realpath(safeResolveWithin(this.repositoryRoot, path));
      const within = relative(rootReal, target);
      if (!within || within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) {
        throw new Error("outside_repository");
      }
      const before = await fs.stat(target, { bigint: true });
      if (!before.isFile()) throw new Error("not_regular_file");
      const fingerprint = `${target}:${stamp(before)}`;
      const retained = this.records.get(path);
      if (retained?.fingerprint === fingerprint) return retained;
      if (before.size > BigInt(MAX_PROJECT_MANIFEST_BYTES)) throw new Error("size_limit");
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let bytes: Buffer;
      try {
        // The descriptor must still identify the checked regular file. Reading
        // at most size+1 also bounds allocation if a writer grows it after stat.
        if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw new Error("changed_during_read");
        bytes = Buffer.alloc(Number(before.size) + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        if (offset !== Number(before.size) || stamp(await handle.stat({ bigint: true })) !== stamp(before)) {
          throw new Error("changed_during_read");
        }
        bytes = bytes.subarray(0, offset);
      } finally { await handle.close(); }
      // Recheck the lexical path, including symlink replacement, before reuse.
      if (await fs.realpath(safeResolveWithin(this.repositoryRoot, path)) !== target ||
          stamp(await fs.stat(target, { bigint: true })) !== stamp(before)) throw new Error("changed_during_read");
      const hash = digest(bytes);
      let manifest: ProjectManifest;
      try {
        const value = spec.parse(bytes.toString("utf8"));
        const references = spec.references?.(value, path);
        if (references) {
          if (references.length > 32) throw new Error("Too many direct manifest references.");
          for (const reference of references) {
            if (!reference || reference.includes("\\") || reference.includes("\0") ||
                /^[A-Za-z]:/u.test(reference) || posix.isAbsolute(reference) ||
                posix.normalize(reference) !== reference || reference === ".." || reference.startsWith("../")) {
              throw new Error("Invalid manifest reference.");
            }
          }
        }
        manifest = { path, fileName: spec.fileName, value, ...(references?.length ? { references: [...new Set(references)] } : {}) };
      }
      catch { manifest = { path, fileName: spec.fileName, warning: "invalid_manifest" }; }
      return { fingerprint, digest: hash, manifest, valueEstimatedBytes: Buffer.byteLength(JSON.stringify(manifest), "utf8") * 4 };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A dangling symlink is a declared but unreadable boundary, not absence.
      if (code === "ENOENT" && !leafExists) return { fingerprint: "missing", digest: "missing" };
      const reason = ["outside_repository", "not_regular_file", "size_limit", "changed_during_read"].includes((error as Error).message)
        ? (error as Error).message : "unreadable_manifest";
      return { fingerprint: "", digest: reason, manifest: { path, fileName: spec.fileName, warning: reason } };
    }
  }

  private async refresh(): Promise<ProjectStructure> {
    if (this.candidates.length === 0) return this.current ??= { identity: digest(""), manifests: new Map(), warnings: [] };
    const rootReal = await fs.realpath(this.repositoryRoot);
    const records = await mapConcurrent(this.candidates, MANIFEST_READ_CONCURRENCY, (candidate) => this.read(candidate, rootReal));
    const tracked: Candidate[] = [];
    const nextRecords = new Map<string, RecordState>();
    this.candidates.forEach((candidate, index) => {
      const record = records[index]!;
      if (record.manifest || this.records.has(candidate.path) || candidate.path === candidate.spec.fileName) {
        tracked.push(candidate);
        nextRecords.set(candidate.path, record);
      }
    });
    // Discover direct dependencies from current declarations on every refresh.
    // Removed references are pruned; missing declared files remain observable.
    const dependencies = new Map<string, Candidate>();
    this.candidates.forEach((candidate, index) => {
      for (const path of records[index]!.manifest?.references ?? []) {
        const known = nextRecords.get(path);
        if (!known) dependencies.set(path, { path, spec: candidate.spec });
        else if (!known.manifest) nextRecords.set(path, {
          ...known, manifest: { path, fileName: candidate.spec.fileName, warning: "missing_manifest" },
        });
      }
    });
    const dependencyCandidates = [...dependencies.values()];
    const dependencyRecords = await mapConcurrent(dependencyCandidates, MANIFEST_READ_CONCURRENCY, (candidate) => this.read(candidate, rootReal));
    dependencyCandidates.forEach((candidate, index) => {
      const record = dependencyRecords[index]!;
      nextRecords.set(candidate.path, record.manifest ? record : {
        ...record, manifest: { path: candidate.path, fileName: candidate.spec.fileName, warning: "missing_manifest" },
      });
    });
    this.candidates = tracked;
    this.records = nextRecords;
    this.estimatedBytes = [...nextRecords].reduce((total, [path, record]) => {
      return total + 512 + path.length * 4 + record.fingerprint.length * 2 +
        (record.valueEstimatedBytes ?? 0);
    }, 0);
    const orderedRecords = [...nextRecords].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const hash = createHash("sha256");
    for (const [path, record] of orderedRecords) if (record.manifest) hash.update(`${path}\0${record.digest}\0`);
    const identity = hash.digest("hex");
    if (this.current?.identity === identity) return this.current;
    const manifests = new Map<string, ProjectManifest>();
    const warnings: Array<{ path: string; reason: string }> = [];
    for (const [, record] of orderedRecords) if (record.manifest) {
      let manifest = record.manifest;
      if (!manifest.warning && manifest.references?.some((path) => nextRecords.get(path)?.manifest?.references?.length)) {
        manifest = { ...manifest, warning: "manifest_reference_depth" };
      }
      manifests.set(manifest.path, manifest);
      if (manifest.warning) warnings.push({ path: manifest.path, reason: manifest.warning });
    }
    return this.current = { identity, manifests, warnings };
  }
}

export function nearestProjectManifest(structure: ProjectStructure, source: string, fileName: string): ProjectManifest | undefined {
  let directory = posix.dirname(source);
  while (true) {
    const manifest = structure.manifests.get(posix.join(directory, fileName));
    if (manifest || directory === ".") return manifest;
    directory = posix.dirname(directory);
  }
}
