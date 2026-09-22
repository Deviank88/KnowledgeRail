import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { StaticEmbeddingProvider, setupStaticModel } from "../src/core/semantic/static-provider.js";
import { STATIC_MODELS, type StaticModelName } from "../src/core/semantic/static-models.js";
import { configuredEmbeddingProvider } from "../src/core/semantic/provider.js";
import { getWikiPageRecords } from "../src/core/retrieval-index.js";
import { parseWikiPageRecord } from "../src/core/page-record.js";
import { cosine, storeVector } from "../src/core/semantic/vector.js";
import type { EmbeddingProvider } from "../src/core/semantic/types.js";

// Downloads are explicit and stay inside the caller-provided evaluation directory.
const rootArg = process.argv.find((a) => a.startsWith("--assets="))?.slice(9);
if (!rootArg) throw new Error("Pass --assets=<evaluation-directory>; add --download to fetch pinned models explicitly.");
const root = path.resolve(rootArg);
await fs.mkdir(root, { recursive: true });
const corpus = await getWikiPageRecords(path.resolve("wiki"), false, { persist: false });
for (const file of ["README.md", "SELF_HOSTING.md", "CHANGELOG.md", "docs/guides/code-evidence-retrieval.md"]) {
  const raw = await fs.readFile(file, "utf8"); corpus.push(parseWikiPageRecord(file, raw, { mtimeMs: 0, size: Buffer.byteLength(raw) }));
}
const passages = corpus.sort((a, b) => a.path.localeCompare(b.path)).flatMap((r) => r.passages.map((p) => `${p.heading}\n${p.text}`)).slice(0, 400);
const fixture = JSON.parse(await fs.readFile("benchmarks/fixtures/functional-routing-golden.json", "utf8")) as { domains: Array<{ id: string; title: string; claim: string; queries: Array<{ text: string; split: string }> }> };
const domains = fixture.domains;
const texts = [...passages, ...domains.map((d) => `${d.title}\n${d.claim}`)];
const extraQueries: Record<string, string[]> = {
  credit: ["Quanto si può rimborsare con una nota di credito?", "What is the commercial reversal cap?", "Aggiornare il limite massimo dei rimborsi"],
  booking: ["Quando la revoca della prenotazione libera il posto?", "Can a reserved seat be released after departure?", "Change the rule for cancelling reserved seats"],
  archive: ["Per quanti giorni restano disponibili le pratiche archiviate?", "When should closed case records be purged?", "Aggiornare la durata di conservazione dell'archivio pratiche"],
  salesforce: ["Oltre quale importo un affidamento richiede autorizzazione?", "When does lending require approval?", "Aggiornare il limite per l'approvazione del credito concesso"],
};
const probes = domains.flatMap((d, index) => [...d.queries, ...extraQueries[d.id]!.map((text) => ({ text, split: "evaluation-extension" }))].map((q) => ({ ...q, expected: passages.length + index })));
const providers: EmbeddingProvider[] = [];
for (const name of Object.keys(STATIC_MODELS) as StaticModelName[]) {
  const setup = await setupStaticModel(root, name, process.argv.includes("--download"));
  providers.push(new StaticEmbeddingProvider(setup.directory, name, STATIC_MODELS[name], 600 * 1024 * 1024));
}
if (process.argv.includes("--live")) {
  const provider = configuredEmbeddingProvider();
  if (!provider) throw new Error("--live requires the reference provider configuration.");
  providers.push(provider);
}
for (const provider of providers) {
  const cold = performance.now(); await provider.embedQuery("warmup"); const coldMs = performance.now() - cold;
  const start = performance.now(); const vectors: Array<readonly number[]> = [];
  for (let i = 0; i < texts.length; i += 64) vectors.push(...await provider.embedDocuments(texts.slice(i, i + 64)));
  const buildMs = performance.now() - start;
  const queries = await provider.embedQueries!(probes.map((q) => q.text));
  let quantizationThresholdChanges = 0, quantizationTopChanges = 0;
  const outcomes = queries.map((q, i) => {
    const rank = vectors.map((v, index) => ({ index, score: cosine(q, v) })).sort((a, b) => b.score - a.score || a.index - b.index);
    const q8 = storeVector(q, provider.descriptor.dimensions, "i8").vector;
    const rank8 = vectors.map((v, index) => ({ index, score: cosine(q8, storeVector(v, provider.descriptor.dimensions, "i8").vector) })).sort((a, b) => b.score - a.score || a.index - b.index);
    if (rank[0]?.index !== rank8[0]?.index) quantizationTopChanges++;
    const scores8 = new Map(rank8.map((hit) => [hit.index, hit.score]));
    for (const hit of rank) for (const threshold of [0.72, 0.80]) if ((hit.score >= threshold) !== (scores8.get(hit.index)! >= threshold)) quantizationThresholdChanges++;
    return { split: probes[i]!.split, query: probes[i]!.text, expectedRank: rank.findIndex((r) => r.index === probes[i]!.expected) + 1, top: rank[0]!.index };
  });
  const repeated = await provider.embedQueries!(probes.map((q) => q.text));
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  console.log(JSON.stringify({ provider: provider.descriptor, corpusDigest: digest(texts), queriesDigest: digest(probes), passages: texts.length, authoredQueries: probes.length, coldMs, buildMs, passagesPerSecond: texts.length * 1000 / buildMs,
    deterministicQueries: digest(queries) === digest(repeated), quantizationThresholdChanges, quantizationTopChanges, outcomes,
    limitation: "Controlled bilingual domain stories with authored aliases plus real documentation distractors; not real user traffic. Static provider remains optional; this does not certify threshold calibration." }));
}
