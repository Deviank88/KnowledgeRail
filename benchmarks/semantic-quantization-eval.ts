import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { loadHybridFixture, materializeHybridFixture } from "./hybrid-retrieval-quality-eval.js";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import { configuredEmbeddingProvider } from "../src/core/semantic/provider.js";
import { StaticEmbeddingProvider, setupStaticModel } from "../src/core/semantic/static-provider.js";
import { STATIC_MODELS, type StaticModelName } from "../src/core/semantic/static-models.js";
import { cosine, storeVector } from "../src/core/semantic/vector.js";
import type { EmbeddingProvider } from "../src/core/semantic/types.js";
import { PersistentSemanticIndex } from "../src/core/semantic/index.js";
import { retrieveWikiHybrid } from "../src/core/hybrid-retrieval.js";

// Independent of the deterministic golden provider: freeze real model output,
// then compare f32/i8 on the existing semantic evaluation queries (16 at present).
const assets = process.argv.find((a) => a.startsWith("--assets="))?.slice(9);
if (!assets) throw new Error("Pass --assets=<directory containing explicitly installed static models>.");
const fixture = JSON.parse(await fs.readFile("benchmarks/fixtures/semantic-retrieval-golden.json", "utf8")) as {
  baseFixture: string;
  semanticPages: Array<{ path: string; title: string; type: string; body: string }>;
  semanticOnlyQueries: Array<{ id: string; query: string; expectedPaths: string[] }>;
};
const base = await loadHybridFixture(path.resolve("benchmarks/fixtures", fixture.baseFixture));
const queries = [...base.queries.map((q) => ({ id: q.id, query: q.query, expectedPaths: [...new Set(q.relevant.map((r) => r.path))] })), ...fixture.semanticOnlyQueries];
const providers: EmbeddingProvider[] = [];
for (const name of Object.keys(STATIC_MODELS) as StaticModelName[]) {
  const setup = await setupStaticModel(path.resolve(assets), name, false);
  providers.push(new StaticEmbeddingProvider(setup.directory, name, STATIC_MODELS[name], 600 * 1024 * 1024));
}
if (process.argv.includes("--live")) {
  const live = configuredEmbeddingProvider();
  if (!live) throw new Error("--live requires a configured reference provider.");
  providers.push(live);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "kr-quantization-"));
const wikiRoot = path.join(root, "wiki");
try {
  await materializeHybridFixture(wikiRoot, base);
  for (const page of fixture.semanticPages) {
    const file = path.join(wikiRoot, page.path); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: ${page.title}\ntype: ${page.type}\n---\n\n${page.body}`);
  }
  const records = await getWikiPageRecords(wikiRoot, true, { persist: false });
  const passages = records.flatMap((r) => r.passages.map((p, index) => ({ path: r.path, first: index === 0, text: `${p.heading}\n${p.text}` })));
  for (const provider of providers) {
    const vectors: Array<readonly number[]> = [];
    for (let i = 0; i < passages.length; i += 64) vectors.push(...await provider.embedDocuments(passages.slice(i, i + 64).map((p) => p.text)));
    const qVectors = provider.embedQueries ? await provider.embedQueries(queries.map((q) => q.query))
      : await Promise.all(queries.map((q) => provider.embedQuery(q.query)));
    const f32 = vectors.map((v) => storeVector(v, provider.descriptor.dimensions, "f32").vector);
    const i8 = vectors.map((v) => storeVector(v, provider.descriptor.dimensions, "i8").vector);
    let maxCosineError = 0;
    const outcomes = queries.map((query, index) => {
      const q32 = storeVector(qVectors[index]!, provider.descriptor.dimensions, "f32").vector;
      const q8 = storeVector(qVectors[index]!, provider.descriptor.dimensions, "i8").vector;
      const scores = f32.map((v) => cosine(q32, v));
      const scores8 = i8.map((v) => cosine(q8, v));
      const ranked = scores.map((score, i) => ({ score, index: i })).sort((a, b) => b.score - a.score || a.index - b.index);
      const ranked8 = scores8.map((score, i) => ({ score, index: i })).sort((a, b) => b.score - a.score || a.index - b.index);
      const crossings: Array<{ path: string; threshold: number; before: number; after: number }> = [];
      scores.forEach((score, i) => {
        maxCosineError = Math.max(maxCosineError, Math.abs(score - scores8[i]!));
        for (const threshold of [0.72, 0.80]) if ((score >= threshold) !== (scores8[i]! >= threshold))
          crossings.push({ path: passages[i]!.path, threshold, before: score, after: scores8[i]! });
      });
      const pageRank = [...new Set(ranked.map((r) => passages[r.index]!.path))];
      const firstPassageRank = ranked.filter((r) => passages[r.index]!.first).map((r) => passages[r.index]!.path);
      const recall = (paths: string[]) => query.expectedPaths.filter((p) => paths.includes(p)).length / query.expectedPaths.length;
      return { id: query.id, firstResultChanged: ranked[0]!.index !== ranked8[0]!.index, crossings,
        expectedPageRecallAt5: recall(pageRank.slice(0, 5)), firstPassageOnlyRecallAt5: recall(firstPassageRank.slice(0, 5)) };
    });
    const average = (field: "expectedPageRecallAt5" | "firstPassageOnlyRecallAt5") => outcomes.reduce((n, q) => n + q[field], 0) / outcomes.length;
    // Exercise ANN, fusion, selection and coverage too. Identical real model
    // outputs are deliberately reused between dtypes to isolate quantization;
    // these are quality measurements, never provider latency measurements.
    const documentCache = new Map(passages.map((p, i) => [p.text.normalize("NFC").trim(), vectors[i]!]));
    const queryCache = new Map(queries.map((q, i) => [q.query, qVectors[i]!]));
    const frozen: EmbeddingProvider = {
      descriptor: provider.descriptor,
      async embedDocuments(texts) {
        return texts.map((text) => { const v = documentCache.get(text.normalize("NFC").trim()); if (!v) throw new Error("Missing frozen document vector."); return v; });
      },
      async embedQuery(text) {
        if (!queryCache.has(text)) queryCache.set(text, await provider.embedQuery(text));
        return queryCache.get(text)!;
      },
      async embedQueries(texts) {
        const missing = [...new Set(texts.filter((text) => !queryCache.has(text)))];
        if (missing.length) {
          const values = provider.embedQueries ? await provider.embedQueries(missing) : await Promise.all(missing.map((text) => provider.embedQuery(text)));
          missing.forEach((text, i) => queryCache.set(text, values[i]!));
        }
        return texts.map((text) => queryCache.get(text)!);
      },
    };
    const hybrid: Record<string, Array<{ id: string; paths: string[]; recall: number; precision: number; coverage: unknown }>> = {};
    const truncation = [];
    const modes = ["f32", "i8", ...(process.argv.includes("--truncation") ? ["limit-128", "limit-512", "limit-2048"] : [])];
    for (const mode of modes) {
      const dtype = mode === "i8" ? "i8" : "f32";
      if (mode.startsWith("limit-")) {
        const limit = Number(mode.slice(6));
        const capped = await provider.embedDocuments(passages.map((p) => p.text.slice(0, limit)));
        passages.forEach((p, i) => documentCache.set(p.text.normalize("NFC").trim(), capped[i]!));
        truncation.push({ mode, changedPassages: passages.filter((p) => p.text.length > limit).length });
      }
      const index = new PersistentSemanticIndex(path.join(root, "indexes", provider.descriptor.model, mode), frozen, undefined, { dtype });
      for (const record of records) {
        const file = path.join(root, "indexes", provider.descriptor.model, mode, record.path);
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, record.raw);
      }
      await index.synchronize(records);
      hybrid[mode] = [];
      for (const query of queries) {
        const result = await retrieveWikiHybrid({ wikiRoot, query: query.query, maxResults: base.k,
          profile: "balanced", progressiveWidening: false, semanticIndex: index, persistDerivedIndexes: false, ...base.boundedBudget });
        const paths = result.hits.map((hit) => hit.path);
        assert.ok(paths.every((p) => records.some((r) => r.path === p)), "Index copies must never contaminate the evaluated wiki corpus.");
        const found = query.expectedPaths.filter((p) => paths.includes(p)).length;
        hybrid[mode]!.push({ id: query.id, paths, recall: query.expectedPaths.length ? found / query.expectedPaths.length : 1,
          precision: paths.length ? found / paths.length : 0, coverage: result.coverage });
      }
      index.dispose();
    }
    for (const sample of truncation) if (!sample.changedPassages) assert.deepEqual(hybrid[sample.mode], hybrid.f32, "No truncation must reproduce the reference pipeline.");
    const hybridComparison = queries.map((query, i) => ({ id: query.id,
      pathsChanged: JSON.stringify(hybrid.f32![i]!.paths) !== JSON.stringify(hybrid.i8![i]!.paths),
      coverageChanged: JSON.stringify(hybrid.f32![i]!.coverage) !== JSON.stringify(hybrid.i8![i]!.coverage),
      recallDelta: hybrid.i8![i]!.recall - hybrid.f32![i]!.recall,
      precisionDelta: hybrid.i8![i]!.precision - hybrid.f32![i]!.precision }));
    console.log(JSON.stringify({ provider: provider.descriptor, passages: passages.length, queries: queries.length,
      corpusDigest: createHash("sha256").update(JSON.stringify({ passages, queries })).digest("hex"),
      firstResultChanges: outcomes.filter((q) => q.firstResultChanged).length,
      coverageThresholdCrossings: outcomes.reduce((n, q) => n + q.crossings.length, 0), maxCosineError,
      expectedPageRecallAt5: average("expectedPageRecallAt5"), firstPassageOnlyRecallAt5: average("firstPassageOnlyRecallAt5"), outcomes,
      hybridComparison, hybrid, truncation: truncation.map((sample) => ({ ...sample,
        pathChanges: hybrid[sample.mode]!.filter((result, i) => JSON.stringify(result.paths) !== JSON.stringify(hybrid.f32![i]!.paths)).length,
        coverageChanges: hybrid[sample.mode]!.filter((result, i) => JSON.stringify(result.coverage) !== JSON.stringify(hybrid.f32![i]!.coverage)).length,
        meanRecall: hybrid[sample.mode]!.reduce((n, r) => n + r.recall, 0) / queries.length,
        referenceRecall: hybrid.f32!.reduce((n, r) => n + r.recall, 0) / queries.length,
      })),
      limitation: "Existing authored golden corpus. Raw cosine plus production ANN/fusion/coverage comparison. Real model outputs frozen between dtypes to isolate quantization; not a latency benchmark." }));
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
