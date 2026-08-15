import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clearRetrievalIndexes, searchRetrievalIndex } from "../src/core/retrieval-index.js";
import {
  mean,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  type GradedRelevant,
} from "./retrieval-metrics.js";

interface GoldenPage {
  path: string;
  title: string;
  type: string;
  tags: string[];
  body: string;
}

interface GoldenRelevant extends GradedRelevant {
  heading?: string;
}

interface GoldenQuery {
  id: string;
  query: string;
  relevant: GoldenRelevant[];
}

interface GoldenFixture {
  pages: GoldenPage[];
  queries: GoldenQuery[];
}

interface QueryMetrics {
  id: string;
  recallAt5: number;
  precisionAt5: number;
  reciprocalRank: number;
  ndcgAt5: number;
  passageHeadingMatch: number;
  topPaths: string[];
}

interface ProfileMetrics {
  profile: Profile;
  recallAt5: number;
  precisionAt5: number;
  mrr: number;
  ndcgAt5: number;
  passageHeadingMatch: number;
  queries: QueryMetrics[];
}

interface EvaluationReport {
  generatedAt: string;
  fixture: string;
  pageCount: number;
  queryCount: number;
  profiles: ProfileMetrics[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, "fixtures", "retrieval-golden.json");
const PROFILES = ["precision", "balanced", "coverage"] as const;

type Profile = (typeof PROFILES)[number];

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

async function loadFixture(): Promise<GoldenFixture> {
  return JSON.parse(await fs.readFile(FIXTURE_PATH, "utf-8")) as GoldenFixture;
}

async function materializeFixture(root: string, fixture: GoldenFixture): Promise<void> {
  for (const page of fixture.pages) {
    const absolute = path.join(root, page.path);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(
      absolute,
      [
        "---",
        `title: ${JSON.stringify(page.title)}`,
        `type: ${page.type}`,
        `tags: [${page.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
        "created: 2026-08-12",
        "updated: 2026-08-12",
        "sources: []",
        "---",
        "",
        page.body,
      ].join("\n"),
      "utf-8"
    );
  }
}

function requestedProfiles(): Profile[] {
  const raw = argValue("profiles");
  if (!raw) return [...PROFILES];
  const values = raw.split(",").filter((value): value is Profile => PROFILES.includes(value as Profile));
  return values.length > 0 ? values : [...PROFILES];
}

async function evaluateProfile(root: string, fixture: GoldenFixture, profile: Profile): Promise<ProfileMetrics> {
  const queryMetrics: QueryMetrics[] = [];

  process.stdout.write(`\n## profile=${profile}\n`);
  for (const query of fixture.queries) {
    const hits = await searchRetrievalIndex({
      wikiRoot: root,
      query: query.query,
      maxResults: 10,
      profile,
    });
    const recall = recallAtK(hits, query.relevant, 5);
    const precision = precisionAtK(hits, query.relevant, 5);
    const reciprocal = reciprocalRank(hits, query.relevant);
    const ndcg = ndcgAtK(hits, query.relevant, 5);
    const headingExpectations = query.relevant.filter((item) => item.heading);
    const passageHeadingMatch = headingExpectations.length === 0
      ? 1
      : mean(headingExpectations.map((expected) => {
          const hit = hits.find((candidate) => candidate.path === expected.path);
          if (!hit || !expected.heading) return 0;
          return normalize(hit.heading).includes(normalize(expected.heading)) ? 1 : 0;
        }));
    const topPaths = hits.slice(0, 3).map((hit) => hit.path);

    queryMetrics.push({
      id: query.id,
      recallAt5: recall,
      precisionAt5: precision,
      reciprocalRank: reciprocal,
      ndcgAt5: ndcg,
      passageHeadingMatch,
      topPaths,
    });

    process.stdout.write(
      `${query.id.padEnd(20)} ` +
      `R@5=${recall.toFixed(3)} P@5=${precision.toFixed(3)} ` +
      `MRR=${reciprocal.toFixed(3)} NDCG@5=${ndcg.toFixed(3)} ` +
      `passage=${passageHeadingMatch.toFixed(3)} top=${topPaths.join(", ")}\n`
    );
  }

  const summary: ProfileMetrics = {
    profile,
    recallAt5: mean(queryMetrics.map((metric) => metric.recallAt5)),
    precisionAt5: mean(queryMetrics.map((metric) => metric.precisionAt5)),
    mrr: mean(queryMetrics.map((metric) => metric.reciprocalRank)),
    ndcgAt5: mean(queryMetrics.map((metric) => metric.ndcgAt5)),
    passageHeadingMatch: mean(queryMetrics.map((metric) => metric.passageHeadingMatch)),
    queries: queryMetrics,
  };

  process.stdout.write(
    `SUMMARY profile=${profile} ` +
    `Recall@5=${summary.recallAt5.toFixed(4)} ` +
    `Precision@5=${summary.precisionAt5.toFixed(4)} ` +
    `MRR=${summary.mrr.toFixed(4)} ` +
    `NDCG@5=${summary.ndcgAt5.toFixed(4)} ` +
    `PassageHeadingMatch=${summary.passageHeadingMatch.toFixed(4)}\n`
  );
  return summary;
}

async function main(): Promise<void> {
  const fixture = await loadFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-golden-"));
  const outputPath = argValue("json");

  try {
    await materializeFixture(root, fixture);
    clearRetrievalIndexes();
    process.stdout.write(`Golden retrieval dataset: ${fixture.pages.length} pages, ${fixture.queries.length} queries\n`);

    const profiles: ProfileMetrics[] = [];
    for (const profile of requestedProfiles()) {
      profiles.push(await evaluateProfile(root, fixture, profile));
    }

    if (outputPath) {
      const resolved = path.resolve(outputPath);
      const report: EvaluationReport = {
        generatedAt: new Date().toISOString(),
        fixture: path.relative(process.cwd(), FIXTURE_PATH).replace(/\\/g, "/"),
        pageCount: fixture.pages.length,
        queryCount: fixture.queries.length,
        profiles,
      };
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
      process.stdout.write(`\nJSON written to ${resolved}\n`);
    }
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
