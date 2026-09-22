import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { posix, relative, isAbsolute, resolve } from "node:path";
import { mapConcurrent } from "../concurrent-map.js";
import { safeResolveWithin } from "../paths.js";
import { discoverManifestPatterns } from "./manifest-discovery.js";
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
function candidatesFor(paths: Iterable<string>, registry: KnowledgeAdapterRegistry, companions: boolean): Candidate[] {
  const candidates = new Map<string, ProjectManifestSpec>();
  const registrations = registry.registrations.filter(({ adapter }) => adapter.projectManifests?.length);
  const specsByAdapter = new Map(registrations.map(({ adapter }) =>
    [adapter, adapter.projectManifests!.filter((spec) => Boolean(spec.companion) === companions)]));
  const specsByName = new Map<string, ProjectManifestSpec>();
  const conflicting = new Set<string>();
  for (const specs of specsByAdapter.values()) for (const spec of specs) {
    if (specsByName.has(spec.fileName) && specsByName.get(spec.fileName) !== spec) conflicting.add(spec.fileName);
    specsByName.set(spec.fileName, spec);
  }
  const visited = new Map<ProjectManifestSpec, Set<string>>();
  for (const path of paths) {
    const normalizedPath = path.toLowerCase();
    const adapter = registrations.find(({ adapter, extensionClaims }) =>
      extensionClaims.some((claim) => normalizedPath.endsWith(claim)) && adapter.supports({ path })
    )?.adapter;
    const specs = adapter && specsByAdapter.get(adapter);
    if (!specs?.length) continue;
    if (companions) {
      for (const spec of specs) if (spec.companion!.extensions.some((extension) => normalizedPath.endsWith(extension))) {
        if (!/^[A-Za-z0-9._-]+$/u.test(spec.companion!.suffix)) throw new Error("Invalid companion suffix.");
        candidates.set(path + spec.companion!.suffix, spec);
      }
      continue;
    }
    for (const spec of specs) {
      if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\*\.[A-Za-z0-9_-]+)$/u.test(spec.fileName)) throw new Error("Invalid adapter manifest filename.");
      const seen = visited.get(spec) ?? new Set<string>();
      visited.set(spec, seen);
      let directory = posix.dirname(path);
      while (true) {
        // Distinct custom parsers for the same filename preserve the original
        // last-source-wins behavior. Shared specs visit each ancestor once.
        if (!conflicting.has(spec.fileName) && seen.has(directory)) break;
        seen.add(directory);
        candidates.set(posix.join(directory, spec.fileName), spec);
        if (directory === ".") break;
        const parent = posix.dirname(directory);
        if (directory === parent || directory === ".." || directory.startsWith("../") || posix.isAbsolute(directory)) {
          throw new Error("Manifest inventory must contain repository-relative paths.");
        }
        directory = parent;
      }
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
  private patterns: Candidate[];
  private readonly manifestSpecs: readonly ProjectManifestSpec[];
  /** Conservative admission estimate; not a V8 heap measurement. */
  estimatedBytes = 0;

  constructor(repositoryRoot: string, paths: Iterable<string>, registry: KnowledgeAdapterRegistry, companions = false) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.manifestSpecs = registry.registrations.flatMap(({ adapter }) => adapter.projectManifests ?? []).filter((spec) => !spec.companion);
    this.candidates = candidatesFor(paths, registry, companions);
    this.patterns = this.candidates.filter(({ spec }) => spec.fileName.startsWith("*"));
    this.candidates = this.candidates.filter(({ spec }) => !spec.fileName.startsWith("*"));
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
        const value = spec.parse(bytes.toString("utf8"), { repositoryRoot: this.repositoryRoot, manifestPath: path });
        const notices = spec.notices?.(value);
        if (notices && (notices.length > 12 || notices.some((reason) => typeof reason !== "string" || reason.length > 256))) throw new Error("Invalid manifest notices.");
        const patterns = spec.referencePatterns?.(value, path);
        const references = [...(spec.references?.(value, path) ?? []),
          ...(patterns?.length ? await discoverManifestPatterns(this.repositoryRoot, patterns) : [])];
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
        manifest = { path, fileName: spec.fileName, value, ...(notices?.length ? { notices: [...new Set(notices)] } : {}),
          ...(references?.length ? { references: [...new Set(references)] } : {}) };
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
    if (this.candidates.length === 0 && this.patterns.length === 0) return this.current ??= { identity: digest(""), manifests: new Map(), warnings: [] };
    const rootReal = await fs.realpath(this.repositoryRoot);
    const discovered = await mapConcurrent(this.patterns, MANIFEST_READ_CONCURRENCY, async (candidate) => {
      const directory = posix.dirname(candidate.path), found: Candidate[] = [];
      try {
        const absolute = directory === "." ? rootReal : await fs.realpath(safeResolveWithin(this.repositoryRoot, directory));
        const within = relative(rootReal, absolute);
        if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) throw new Error("outside_repository");
        const handle = await fs.opendir(absolute);
        let entries = 0;
        for await (const entry of handle) {
          if (++entries > 16_384 || found.length >= 32) throw new Error("manifest_discovery_limit");
          if (entry.name.endsWith(candidate.spec.fileName.slice(1))) found.push({ path: posix.join(directory, entry.name), spec: candidate.spec });
        }
        return { candidate, found };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidate, found };
        return { candidate, found: [], warning: (error as Error).message === "manifest_discovery_limit" ? "manifest_discovery_limit" : "unreadable_manifest" };
      }
    });
    const discoveredCandidates = new Map(this.candidates.map((candidate) => [candidate.path, candidate]));
    for (const { found } of discovered) for (const candidate of found) discoveredCandidates.set(candidate.path, candidate);
    this.candidates = [...discoveredCandidates.values()].sort((a, b) => a.path.localeCompare(b.path));
    // New nested boundaries are discovered on source update, as for literal names.
    this.patterns = discovered.filter(({ candidate, found, warning }) => posix.dirname(candidate.path) === "." || found.length || warning).map(({ candidate }) => candidate);
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
        if (!known) dependencies.set(path, { path, spec: this.manifestSpecs.find((spec) => (spec.fileName === posix.basename(path) || spec.fileName.startsWith("*") && posix.basename(path).endsWith(spec.fileName.slice(1)))) ?? candidate.spec });
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
    // Most adapters deliberately keep one reference level. Workspace/build
    // declarations opt into a bounded graph; source option inheritance still
    // has its own stricter language contract.
    const visited = new Set<string>();
    let frontier = [...this.candidates, ...dependencyCandidates].filter(({ spec }) => (spec.referenceDepth ?? 1) > 1);
    let followed = dependencyCandidates.length;
    for (let depth = 1; frontier.length && depth < 8; depth++) {
      const next = new Map<string, Candidate>();
      for (const candidate of frontier) {
        if (visited.has(candidate.path)) continue;
        visited.add(candidate.path);
        const record = nextRecords.get(candidate.path);
        if (depth >= (candidate.spec.referenceDepth ?? 1)) {
          if (record?.manifest?.references?.some((path) => !nextRecords.has(path))) nextRecords.set(candidate.path, {
            ...record, manifest: { ...record.manifest, warning: "manifest_reference_depth" },
          });
          continue;
        }
        for (const path of record?.manifest?.references ?? []) {
          if (visited.has(path)) continue;
          const spec = this.manifestSpecs.find((entry) => (entry.fileName === posix.basename(path) || entry.fileName.startsWith("*") && posix.basename(path).endsWith(entry.fileName.slice(1)))) ?? candidate.spec;
          next.set(path, { path, spec });
        }
      }
      const missing = [...next.values()].filter(({ path }) => !nextRecords.has(path));
      if ((followed += missing.length) > 256) {
        for (const candidate of frontier) {
          const record = nextRecords.get(candidate.path);
          if (record?.manifest) nextRecords.set(candidate.path, { ...record, manifest: { ...record.manifest, warning: "manifest_discovery_limit" } });
        }
        break;
      }
      const loaded = await mapConcurrent(missing, MANIFEST_READ_CONCURRENCY, (candidate) => this.read(candidate, rootReal));
      missing.forEach((candidate, index) => {
        const record = loaded[index]!;
        nextRecords.set(candidate.path, record.manifest ? record : { ...record,
          manifest: { path: candidate.path, fileName: candidate.spec.fileName, warning: "missing_manifest" } });
      });
      frontier = [...next.values()];
    }
    this.candidates = tracked;
    this.records = nextRecords;
    for (const { candidate, warning } of discovered) if (warning) nextRecords.set(candidate.path, {
      fingerprint: "", digest: warning,
      manifest: { path: candidate.path, fileName: candidate.spec.fileName, warning },
    });
    this.estimatedBytes = [...nextRecords].reduce((total, [path, record]) => {
      return total + 512 + path.length * 4 + record.fingerprint.length * 2 +
        (record.valueEstimatedBytes ?? 0);
    }, this.patterns.reduce((bytes, candidate) => bytes + 128 + candidate.path.length * 4, 0));
    const orderedRecords = [...nextRecords].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const hash = createHash("sha256");
    for (const [path, record] of orderedRecords) if (record.manifest) hash.update(`${path}\0${record.digest}\0`);
    const identity = hash.digest("hex");
    if (this.current?.identity === identity) return this.current;
    const manifests = new Map<string, ProjectManifest>();
    const warnings: Array<{ path: string; reason: string }> = [];
    const referenceManifests = new Map([...nextRecords].flatMap(([path, record]) => record.manifest ? [[path, record.manifest] as const] : []));
    for (const [, record] of orderedRecords) if (record.manifest) {
      let manifest = record.manifest;
      const spec = this.manifestSpecs.find((entry) => entry.fileName === manifest.fileName);
      if (!manifest.warning && (spec?.referenceDepth ?? 1) === 1 && manifest.references?.some((path) => nextRecords.get(path)?.manifest?.references?.length)) {
        manifest = { ...manifest, warning: "manifest_reference_depth" };
      }
      manifests.set(manifest.path, manifest);
      if (manifest.warning) warnings.push({ path: manifest.path, reason: manifest.warning });
      for (const reason of manifest.notices ?? []) warnings.push({ path: manifest.path, reason });
      if (!manifest.warning) for (const reason of spec?.referenceNotices?.(manifest.value, manifest.path, referenceManifests) ?? []) {
        warnings.push({ path: manifest.path, reason });
      }
    }
    return this.current = { identity, manifests, warnings };
  }
}

export function nearestProjectManifest(structure: ProjectStructure, source: string, fileName: string): ProjectManifest | undefined {
  let directory = posix.dirname(source);
  while (true) {
    const matches = fileName.startsWith("*") ? [...structure.manifests.values()].filter((manifest) =>
      manifest.fileName === fileName && posix.dirname(manifest.path) === directory) : [];
    const manifest = fileName.startsWith("*")
      ? matches.length > 1 ? { path: posix.join(directory, fileName), fileName, warning: "ambiguous_manifest" } : matches[0]
      : structure.manifests.get(posix.join(directory, fileName));
    if (manifest || directory === ".") return manifest;
    directory = posix.dirname(directory);
  }
}
