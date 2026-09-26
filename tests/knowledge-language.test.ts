import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  canonicalLanguageTag,
  declareKnowledgeLanguage,
  lockKnowledgeLanguage,
  parseKnowledgeLanguage,
  readKnowledgeLanguage,
  sameLanguage,
  withKnowledgeLanguage,
} from "../src/core/knowledge-language.js";
import { estimateProseLanguage } from "../src/core/language-detection.js";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { ensureWikiStructure } from "../src/core/wiki-structure-service.js";
import { registerAgentTools } from "../src/tools/agent-tools.js";
import { registerWikiPrompts } from "../src/tools/prompts.js";
import { withWikiFileLock } from "../src/core/lock-service.js";

type Handler = (args: Record<string, unknown>, context: Record<string, never>) => Promise<{
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

function capture(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler);
      return {};
    },
  } as unknown as McpServer;
  registerAgentTools(server, "modern");
  return tools;
}

const ENGLISH = "The cache is invalidated when the page is written, and the index is rebuilt only for the pages that " +
  "changed. It does not reload the vectors of unchanged pages, which are reused from the snapshot.";
const ITALIAN = "La cache viene invalidata quando la pagina è scritta, e l'indice è ricostruito solo per le pagine che " +
  "sono cambiate. Non ricarica i vettori delle pagine invariate, che vengono riusati dallo snapshot della cache.";

function page(title: string, body: string): string {
  return `---\ntitle: "${title}"\ntype: concept\ntags: [cache]\ncreated: 2026-09-26\nupdated: 2026-09-26\nsources: []\n---\n\n# ${title}\n\n${body}\n`;
}

async function withWorkspace(run: (root: string, wiki: string) => Promise<void>): Promise<void> {
  const previous = getWikiRoot();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-language-"));
  try {
    setWikiRoot(root);
    await run(root, path.join(root, "wiki"));
  } finally {
    setWikiRoot(previous);
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("language tags are canonical BCP 47 tags compared by primary language", () => {
  assert.equal(canonicalLanguageTag("EN"), "en");
  assert.equal(canonicalLanguageTag(" pt-br "), "pt-BR");
  assert.equal(canonicalLanguageTag("zh-hant-tw"), "zh-Hant-TW");
  for (const invalid of ["", "english please", "und", "mul", "x-private", "e"]) {
    assert.throws(() => canonicalLanguageTag(invalid), /Invalid knowledge language/, invalid);
  }
  assert.equal(sameLanguage("en-GB", "en"), true);
  assert.equal(sameLanguage("it", "en"), false);
});

test("the knowledge language lives in SCHEMA.md frontmatter without disturbing other content", () => {
  const schema = "---\nowner: platform\n---\n\n# Wiki Schema\n\nBody.\n";
  const updated = withKnowledgeLanguage(schema, { tag: "it", lockedAt: "2026-09-26T00:00:00.000Z" });
  assert.deepEqual(parseKnowledgeLanguage(updated), { tag: "it", lockedAt: "2026-09-26T00:00:00.000Z" });
  assert.match(updated, /^owner: platform$/m);
  assert.match(updated, /# Wiki Schema\n\nBody\.\n$/);
  assert.equal(withKnowledgeLanguage("# Wiki Schema\n", { tag: null, lockedAt: null }), "# Wiki Schema\n");
  assert.deepEqual(parseKnowledgeLanguage("---\nknowledge_language: english\n---\n"), {
    tag: null, lockedAt: null, invalidValue: "english",
  });
});

test("prose estimates are confident only for clear function-word evidence", () => {
  assert.equal(estimateProseLanguage(page("Cache", ENGLISH)).language, "en");
  assert.equal(estimateProseLanguage(page("Cache", ITALIAN)).language, "it");
  assert.equal(estimateProseLanguage("# Cache\n\nShort note.").language, null);
  assert.equal(estimateProseLanguage(`# Cache\n\n\`\`\`\n${ENGLISH}\n\`\`\`\n`).language, null, "code blocks are not prose");
  assert.equal(estimateProseLanguage("# キャッシュ\n\nページが書き込まれるとキャッシュは無効になります。").language, null);
  const sharedWords = "Values arrive as strings, as numbers or as dates. Do sort, do filter, do export. No reload, no cache, no batch. " +
    "The table is sorted on the client and the export is written as CSV.";
  assert.equal(estimateProseLanguage(sharedWords).language, "en", "words shared with Portuguese do not blur English prose");
});

test("declaration is free until the first page, then locked across deletion and reinitialization", async () => {
  await withWorkspace(async (_root, wiki) => {
    await ensureWikiStructure();
    assert.equal((await declareKnowledgeLanguage(wiki, "en", { apply: false })).state, "would_declare");
    assert.equal((await readKnowledgeLanguage(wiki)).tag, null, "a preview writes nothing");
    assert.equal((await declareKnowledgeLanguage(wiki, "en", { apply: true })).state, "declared");
    assert.equal((await declareKnowledgeLanguage(wiki, "it", { apply: true })).state, "declared", "no knowledge yet");
    assert.deepEqual(await readKnowledgeLanguage(wiki), { tag: "it", lockedAt: null });

    await fs.mkdir(path.join(wiki, "concepts"), { recursive: true });
    await fs.writeFile(path.join(wiki, "concepts", "Cache.md"), page("Cache", ITALIAN));
    assert.equal(await lockKnowledgeLanguage(wiki, () => "2026-09-26T10:00:00.000Z"), true);
    assert.equal(await lockKnowledgeLanguage(wiki), false, "locking is idempotent");

    await fs.rm(path.join(wiki, "concepts", "Cache.md"));
    await ensureWikiStructure(true);
    assert.deepEqual(await readKnowledgeLanguage(wiki), { tag: "it", lockedAt: "2026-09-26T10:00:00.000Z" });
    const refused = await declareKnowledgeLanguage(wiki, "en", { apply: true });
    assert.equal(refused.state, "locked");
    assert.equal((await readKnowledgeLanguage(wiki)).tag, "it");
    assert.equal((await declareKnowledgeLanguage(wiki, "it-IT", { apply: true })).state, "locked",
      "a locked tag is not refined either");
    assert.equal((await declareKnowledgeLanguage(wiki, "it", { apply: true })).state, "unchanged");
  });
});

test("adopting a language over existing pages locks it and reports pages it does not convert", async () => {
  await withWorkspace(async (_root, wiki) => {
    await ensureWikiStructure();
    await fs.mkdir(path.join(wiki, "concepts"), { recursive: true });
    await fs.writeFile(path.join(wiki, "concepts", "English.md"), page("English", ENGLISH));
    await fs.writeFile(path.join(wiki, "concepts", "Italiano.md"), page("Italiano", ITALIAN));
    await fs.writeFile(path.join(wiki, "concepts", "Short.md"), page("Short", "Brief."));
    const adopted = await declareKnowledgeLanguage(wiki, "en", { apply: true, now: () => "2026-09-26T11:00:00.000Z" });
    assert.equal(adopted.state, "declared");
    assert.deepEqual(adopted.current, { tag: "en", lockedAt: "2026-09-26T11:00:00.000Z" });
    assert.deepEqual(adopted.survey.estimates, { en: 1, it: 1, unknown: 1 });
    assert.deepEqual(adopted.survey.mismatchedPages, [{ path: "concepts/Italiano.md", estimate: "it" }]);
  });
});

test("forced initialization waits for language declaration and the first page mutation", async () => {
  await withWorkspace(async (_root, wiki) => {
    await ensureWikiStructure();
    let initialization: Promise<void> | undefined;
    try {
      await withWikiFileLock(wiki, `${wiki}:wiki-mutation`, async () => {
        initialization = ensureWikiStructure(true);
        assert.equal(await Promise.race([initialization.then(() => "finished"), delay(100, "waiting")]), "waiting");
        await declareKnowledgeLanguage(wiki, "en", { apply: true });
        await fs.mkdir(path.join(wiki, "concepts"), { recursive: true });
        await fs.writeFile(path.join(wiki, "concepts", "Cache.md"), page("Cache", ENGLISH));
        await lockKnowledgeLanguage(wiki, () => "2026-09-26T12:00:00.000Z");
      });
    } finally {
      await initialization;
    }
    assert.deepEqual(await readKnowledgeLanguage(wiki), { tag: "en", lockedAt: "2026-09-26T12:00:00.000Z" });
    await fs.rm(path.join(wiki, "concepts", "Cache.md"));
    assert.equal((await declareKnowledgeLanguage(wiki, "it", { apply: true })).state, "locked");
  });
});

test("page writes and edits require a compatible language before changing bytes", async () => {
  await withWorkspace(async (_root, wiki) => {
    const tools = capture();
    await tools.get("knowledge_admin")!({ action: "init", options: { knowledge_language: "en" } }, {});
    const write = { action: "write", path: "concepts/Cache.md", content: page("Cache", ENGLISH) };
    for (const content_language of [undefined, "it", "invalid tag"]) {
      const result = await tools.get("knowledge_page")!({ ...write, content_language }, {});
      assert.equal(result.isError, true);
      await assert.rejects(fs.access(path.join(wiki, write.path)));
      assert.equal((await readKnowledgeLanguage(wiki)).lockedAt, null);
    }
    assert.notEqual((await tools.get("knowledge_page")!({ ...write, content_language: "en-GB" }, {})).isError, true);
    const before = await fs.readFile(path.join(wiki, write.path), "utf8");
    for (const content_language of [undefined, "it"]) {
      const result = await tools.get("knowledge_page")!({ action: "edit", path: write.path,
        old_string: "The cache", new_string: "La cache", content_language }, {});
      assert.equal(result.isError, true);
      assert.equal(await fs.readFile(path.join(wiki, write.path), "utf8"), before);
    }
    const edited = await tools.get("knowledge_page")!({ action: "edit", path: write.path,
      old_string: "The cache", new_string: "The runtime cache", content_language: "en" }, {});
    assert.notEqual(edited.isError, true);
    assert.match(await fs.readFile(path.join(wiki, write.path), "utf8"), /The runtime cache/);
  });
});

test("knowledge update prompts cannot override the workspace language", async () => {
  await withWorkspace(async (_root, wiki) => {
    type PromptHandler = (args: Record<string, string | undefined>) => Promise<{ messages: Array<{ content: { text: string } }> }>;
    const prompts = new Map<string, PromptHandler>();
    registerWikiPrompts({ registerPrompt(name: string, _config: unknown, handler: PromptHandler) {
      prompts.set(name, handler);
    } } as unknown as McpServer);
    const prepare = prompts.get("prepare_knowledge_update")!;
    await ensureWikiStructure();
    const legacy = await prepare({ finding: "La cache è invalidata", language: "it" });
    assert.match(legacy.messages[0]!.content.text, /Page language: it\./);
    await declareKnowledgeLanguage(wiki, "en", { apply: true });
    await assert.rejects(prepare({ finding: "La cache è invalidata", language: "it" }), /does not match/);
    for (const args of [{ finding: "La cache è invalidata" }, { finding: "La cache è invalidata", language: "en-US" }]) {
      const result = await prepare(args);
      assert.match(result.messages[0]!.content.text, /Page language: en\./);
      assert.match(result.messages[0]!.content.text, /content_language="en"/);
    }
  });
});

test("ingestion requires translated claims and preserves the original source", async () => {
  await withWorkspace(async (root, wiki) => {
    const tools = capture();
    await tools.get("knowledge_admin")!({ action: "init", options: { knowledge_language: "en" } }, {});
    const filename = "cache.md";
    const source = path.join(root, "docs", "normalized", filename);
    await fs.writeFile(source, ITALIAN);
    await tools.get("knowledge_ingest")!({ action: "start", normalized_filename: filename }, {});
    const next = await tools.get("knowledge_ingest")!({ action: "next", normalized_filename: filename }, {});
    const segment = next.structuredContent?.segment as { id: string };
    assert.ok(segment.id);
    const nextAction = next.structuredContent?.nextAction as { suggestedArguments: Record<string, unknown> };
    assert.equal(nextAction.suggestedArguments.content_language, "en");
    const args = { action: "apply_claims", normalized_filename: filename, segment_id: segment.id, claims: [{
      text: ENGLISH, kind: "fact", origin: "explicit", confidence: 1,
      target: { page_path: "concepts/Cache.md", page_title: "Cache invalidation", page_type: "concept" },
    }] };
    for (const content_language of [undefined, "it"]) {
      const rejected = await tools.get("knowledge_ingest")!({ ...args, content_language }, {});
      assert.equal(rejected.isError, true);
      await assert.rejects(fs.access(path.join(wiki, "concepts", "Cache.md")));
      assert.equal((await readKnowledgeLanguage(wiki)).lockedAt, null);
    }
    const applied = await tools.get("knowledge_ingest")!({ ...args, content_language: "en" }, {});
    assert.notEqual(applied.isError, true, JSON.stringify(applied));
    const saved = await fs.readFile(path.join(wiki, "concepts", "Cache.md"), "utf8");
    assert.ok(saved.includes(ENGLISH));
    assert.ok(!saved.includes(ITALIAN));
    assert.ok(saved.includes(`docs/normalized/${filename}`));
    assert.equal(await fs.readFile(source, "utf8"), ITALIAN);
    assert.ok((await readKnowledgeLanguage(wiki)).lockedAt);
  });
});

test("agent tools declare, report and enforce the knowledge language for retrieval", async () => {
  await withWorkspace(async (_root, wiki) => {
    const tools = capture();
    const initialized = await tools.get("knowledge_admin")!({ action: "init", options: { knowledge_language: "en" } }, {});
    assert.equal(initialized.isError, undefined);
    assert.equal(initialized.structuredContent?.knowledgeLanguage, "en");
    assert.equal(initialized.structuredContent?.locked, false);
    assert.deepEqual(initialized.structuredContent?.nextAction, {
      tool: "knowledge_context",
      requiredArguments: ["mode", "objective", "query", "query_language"],
      suggestedArguments: { mode: "task", query_language: "en" },
    });

    const italianPage = await tools.get("knowledge_page")!({
      action: "write", path: "concepts/Cache.md", content: page("Cache", ITALIAN), content_language: "en",
    }, {});
    const warning = italianPage.content?.map((item) => item.text ?? "").join("\n") ?? "";
    assert.match(warning, /Page prose appears to be "it", but this workspace's knowledge language is "en"/);
    assert.match(warning, /knowledge language is now locked/);
    await tools.get("knowledge_page")!({ action: "write", path: "concepts/Cache.md", content: page("Cache", ENGLISH), content_language: "en" }, {});

    const missing = await tools.get("knowledge_context")!({
      mode: "task", intent: "understand", objective: "Come viene invalidata la cache?",
    }, {});
    assert.equal(missing.isError, undefined);
    assert.equal(missing.structuredContent?.state, "query_language_required");
    assert.deepEqual(missing.structuredContent?.languageContract, { knowledgeLanguage: "en", queryLanguage: null, status: "undeclared" });
    assert.deepEqual(missing.structuredContent?.nextAction, {
      tool: "knowledge_context",
      requiredArguments: ["mode", "objective", "query", "query_language"],
      suggestedArguments: { mode: "task", intent: "understand", objective: "Come viene invalidata la cache?", query_language: "en" },
    });
    const mismatch = await tools.get("knowledge_context")!({
      mode: "search", query: "invalidazione cache", query_language: "it",
    }, {});
    assert.equal(mismatch.structuredContent?.state, "query_language_required");
    assert.match(mismatch.content?.map((item) => item.text ?? "").join("\n") ?? "", /No retrieval was performed/);

    const translated = await tools.get("knowledge_context")!({
      mode: "task", intent: "understand", objective: "Come viene invalidata la cache?",
      query: "How is the cache invalidated?", query_language: "en-US", response_detail: "compact",
    }, {});
    assert.notEqual(translated.structuredContent?.state, "query_language_required");
    assert.deepEqual(translated.structuredContent?.languageContract, { knowledgeLanguage: "en", queryLanguage: "en-US" });
    assert.match(JSON.stringify(translated.structuredContent), /concepts\/Cache\.md/);
    for (const name of ["Invalidation", "Snapshot", "Reload"]) {
      await tools.get("knowledge_page")!({
        action: "write", path: `concepts/${name}.md`, content: page(`Cache ${name}`, `${ENGLISH} `.repeat(12)), content_language: "en",
      }, {});
    }
    const widened = await tools.get("knowledge_context")!({
      mode: "task", intent: "understand", objective: "Come viene invalidata la cache?",
      query: "How is the cache invalidated?", query_language: "en", retrieval_profile: "balanced",
      max_evidence: 8, heuristic_token_budget: 256, response_detail: "compact",
    }, {});
    const followUp = widened.structuredContent?.nextAction as { tool?: string; suggestedArguments?: Record<string, unknown> } | null;
    assert.equal(followUp?.tool, "knowledge_context", "a budget-limited context proposes widening");
    assert.equal(followUp?.suggestedArguments?.query_language, "en", "widening keeps the declared query language");
    assert.equal(followUp?.suggestedArguments?.objective, "Come viene invalidata la cache?");
    const listed = await tools.get("knowledge_context")!({ mode: "list" }, {});
    assert.notEqual(listed.structuredContent?.state, "query_language_required", "listing pages sends no query");

    const section = await tools.get("knowledge_document_context")!({
      action: "section", document_type: "custom", section_title: "Invalidazione della cache",
    }, {});
    assert.equal(section.structuredContent?.state, "query_language_required");

    const status = await tools.get("knowledge_admin")!({ action: "status" }, {});
    assert.deepEqual(status.structuredContent?.knowledgeLanguage, {
      knowledgeLanguage: "en", locked: true, lockedAt: (await readKnowledgeLanguage(wiki)).lockedAt,
    });
    const refused = await tools.get("knowledge_admin")!({
      action: "language", setup_mode: "apply", options: { knowledge_language: "it" },
    }, {});
    assert.equal(refused.structuredContent?.state, "blocked");
    assert.equal(refused.structuredContent?.declaration, "locked");
    assert.deepEqual((refused.structuredContent?.pageLanguageSurvey as { mismatchedPages?: unknown[] }).mismatchedPages, [],
      "a refused change reports pages against the language that stays in force");
    assert.equal((await readKnowledgeLanguage(wiki)).tag, "en");
  });
});

test("a language preview reports the language in force and proposes the apply step", async () => {
  await withWorkspace(async (_root, wiki) => {
    const tools = capture();
    await tools.get("knowledge_admin")!({ action: "init" }, {});
    const preview = await tools.get("knowledge_admin")!({
      action: "language", setup_mode: "preview", options: { knowledge_language: "it" },
    }, {});
    assert.equal(preview.structuredContent?.declaration, "would_declare");
    assert.equal(preview.structuredContent?.knowledgeLanguage, null);
    assert.deepEqual(preview.structuredContent?.proposed, { knowledgeLanguage: "it", locked: false });
    assert.deepEqual(preview.structuredContent?.nextAction, {
      tool: "knowledge_admin",
      action: "language",
      requiredArguments: ["action", "options", "setup_mode"],
      suggestedArguments: { action: "language", setup_mode: "apply", options: { knowledge_language: "it" } },
    });
    assert.equal((await readKnowledgeLanguage(wiki)).tag, null);
  });
});

test("workspaces without a declared language keep retrieval unchanged", async () => {
  await withWorkspace(async () => {
    const tools = capture();
    await tools.get("knowledge_admin")!({ action: "init" }, {});
    const context = await tools.get("knowledge_context")!({
      mode: "task", intent: "understand", objective: "Explain the cache", query: "cache",
    }, {});
    assert.notEqual(context.structuredContent?.state, "query_language_required");
    assert.deepEqual(context.structuredContent?.languageContract, { knowledgeLanguage: null, queryLanguage: null });
    const survey = await tools.get("knowledge_admin")!({ action: "language" }, {});
    assert.equal(survey.structuredContent?.state, "knowledge_language_reported");
    assert.equal(survey.structuredContent?.knowledgeLanguage, null);
    assert.match(survey.content?.map((item) => item.text ?? "").join("\n") ?? "", /not declared/);
  });
});
