import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Experimental runtimes stay in disposable copies. Production has no tuning
// switches and every variant runs the same per-family positive/negative oracle.
const argument = (name: string, fallback = "") => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const root = await fs.mkdtemp(join(tmpdir(), "kr-preparation-experiments-"));
const repository = resolve(".");
const variants = argument("variants", "concurrency-4,concurrency-32,directory-prefilter,compact-json").split(",");
const reports = [];
try {
  for (const variant of variants) {
    assert.ok(["concurrency-4", "concurrency-32", "directory-prefilter", "compact-json"].includes(variant));
    const runtime = join(root, variant);
    await fs.mkdir(runtime);
    await fs.cp(join(repository, "src"), join(runtime, "src"), { recursive: true });
    await fs.copyFile(join(repository, "package.json"), join(runtime, "package.json"));
    await fs.symlink(join(repository, "node_modules"), join(runtime, "node_modules"), "dir");
    const structureFile = join(runtime, "src/core/code-evidence/project-structure.ts");
    let structure = await fs.readFile(structureFile, "utf8");
    if (variant.startsWith("concurrency-")) {
      assert.ok(structure.includes("const MANIFEST_READ_CONCURRENCY = 16;"));
      structure = structure.replace("const MANIFEST_READ_CONCURRENCY = 16;", `const MANIFEST_READ_CONCURRENCY = ${variant.slice(12)};`);
    }
    if (variant === "directory-prefilter") {
      // Directory listing is bounded and confined. Errors, symlinks outside the
      // root and oversized directories fall back to the existing safe reader.
      const original = "const records = await mapConcurrent(this.candidates, MANIFEST_READ_CONCURRENCY, (candidate) => this.read(candidate, rootReal));";
      assert.ok(structure.includes(original));
      structure = structure.replace(original, `const directoryNames = new Map<string, Set<string>>();
    if (!this.current) {
      const directories = [...new Set(this.candidates.map((candidate) => posix.dirname(candidate.path)))];
      await mapConcurrent(directories, MANIFEST_READ_CONCURRENCY, async (directory) => {
        try {
          const absolute = directory === "." ? rootReal : await fs.realpath(safeResolveWithin(this.repositoryRoot, directory));
          const within = relative(rootReal, absolute);
          if (within === ".." || within.startsWith("../") || within.startsWith("..\\\\") || isAbsolute(within)) return;
          const names = new Set<string>();
          for await (const entry of await fs.opendir(absolute)) {
            if (names.size >= 16_384) return;
            names.add(entry.name);
          }
          directoryNames.set(directory, names);
        } catch { /* Preserve the original per-file warning behavior. */ }
      });
    }
    const records = await mapConcurrent(this.candidates, MANIFEST_READ_CONCURRENCY, (candidate) => {
      const names = directoryNames.get(posix.dirname(candidate.path));
      return names && !names.has(posix.basename(candidate.path))
        ? Promise.resolve({ fingerprint: "missing", digest: "missing" } as RecordState)
        : this.read(candidate, rootReal);
    });`);
    }
    await fs.writeFile(structureFile, structure);
    if (variant === "compact-json") {
      const file = join(runtime, "src/core/code-evidence/index.ts");
      let source = await fs.readFile(file, "utf8");
      assert.ok(source.includes("after.size * 4 + snapshot.fragments.length * 512"));
      assert.ok(source.includes("${JSON.stringify(snapshot, null, 2)}"));
      source = source.replace("${JSON.stringify(snapshot, null, 2)}", "${JSON.stringify(snapshot)}")
        .replace("after.size * 4 + snapshot.fragments.length * 512", "(Buffer.byteLength(JSON.stringify(snapshot, null, 2), 'utf8') + 1) * 4 + snapshot.fragments.length * 512");
      await fs.writeFile(file, source);
    }
    for (const layout of ["dense", "sparse"]) {
      const output = join(root, `${variant}-${layout}.json`);
      await promisify(execFile)(process.execPath, ["--expose-gc", "--import", "tsx", "benchmarks/code-efficiency-bench.ts",
        `--runtime-root=${runtime}`, `--baseline=${repository}`, `--layout=${layout}`,
        `--scales=${argument("scales", "1000,10000")}`, `--iterations=${argument("iterations", "20")}`,
        "--modes=applicationCold,warm,concurrent,publicCold,publicWarm,postUpdate", `--json=${output}`],
      { cwd: repository, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000 });
      const report = JSON.parse(await fs.readFile(output, "utf8"));
      reports.push({ variant, layout, report });
      console.error(`Completed ${variant}/${layout}`);
    }
  }
  const report = { version: 1, scope: "offline experimental runtimes; no production defaults changed", reports };
  if (argument("json")) await fs.writeFile(argument("json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, reports: reports.map(({ variant, layout, report }) => ({ variant, layout,
    sourceDigests: report.runtimes, results: report.results.map(({ measurements, ...rest }: { measurements: Record<string, { samples: unknown }>; [key: string]: unknown }) => ({
      ...rest, measurements: Object.fromEntries(Object.entries(measurements).map(([key, { samples: _samples, ...values }]) => [key, values])),
    })),
  })) }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
