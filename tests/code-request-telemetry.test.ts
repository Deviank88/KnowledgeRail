import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerCodeEvidenceTools } from "../src/tools/code-evidence-tools.js";
import { getWikiRoot, setWikiRoot } from "../src/core/paths.js";
import { clearWorkspaceStates } from "../src/core/workspace-state.js";
import { codeRequestLanguage, codeRequestSummary, codeRequestTelemetryFile, recordCodeRequest, recordCodeRequestFallback } from "../src/core/code-evidence/request-telemetry.js";

test("request denominators persist per workspace, count empty responses and deduplicate linked fallbacks", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-request-telemetry-")), wiki = join(root, "wiki");
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => recordCodeRequest(wiki, ["secret/customer.py"], i % 2 === 0)));
  assert.deepEqual(await recordCodeRequestFallback(wiki, ids[0], "no_match"), { linked: true, duplicate: false });
  assert.deepEqual(await recordCodeRequestFallback(wiki, ids[0], "ambiguous"), { linked: true, duplicate: true });
  await recordCodeRequestFallback(wiki, ids[1], "ambiguous");
  await recordCodeRequestFallback(wiki, ids[2], "unresolved_import");
  await recordCodeRequestFallback(wiki, undefined, "anything /private/query text");
  const summary = await codeRequestSummary(wiki);
  assert.deepEqual(summary.byLanguage.python, { served: 12, matched: 6, fallbacks: 3,
    reasons: { no_match: 1, ambiguous: 1, unresolved_import: 1, unsupported_extension: 0, other: 0 }, fallbackRate: 0.25 });
  assert.equal(summary.unlinkedFallbacks, 1);
  assert.deepEqual((await codeRequestSummary(join(root, "second/wiki"))).byLanguage, {});
  assert.equal((await recordCodeRequestFallback(join(root, "second/wiki"), ids[0], "no_match")).linked, false);
  const raw = await fs.readFile(codeRequestTelemetryFile(wiki), "utf8");
  for (const secret of ["secret", "customer", "/private", "query text"]) assert.equal(raw.includes(secret), false);
});

test("request correlation is bounded, stale IDs are unlinked, zero and mixed-language outcomes stay explicit", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-request-window-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const first = await recordCodeRequest(root, [], false);
  for (let i = 0; i < 512; i++) await recordCodeRequest(root, ["one.ts", "two.py"], true);
  assert.equal((await recordCodeRequestFallback(root, first, "no_match")).linked, false);
  const state = await codeRequestSummary(root);
  assert.equal(state.byLanguage.unknown?.served, 1);
  assert.equal(state.byLanguage.mixed?.served, 512);
  const raw = await fs.readFile(codeRequestTelemetryFile(root), "utf8");
  assert.equal(JSON.parse(raw).recent.length, 512);
  assert.ok(Buffer.byteLength(raw) < 256 * 1024);
  assert.equal(codeRequestLanguage(["directory"]), "unknown");
  assert.equal(codeRequestLanguage(["unit.ex"]), "unsupported");
  assert.equal(codeRequestLanguage(["unit.js-meta.xml"]), "typescript-javascript");
  await fs.writeFile(codeRequestTelemetryFile(root), '{"version":99}');
  await assert.rejects(recordCodeRequest(root, ["one.py"], true), /Unsupported version.*code-request-counts/);
  assert.equal(await fs.readFile(codeRequestTelemetryFile(root), "utf8"), '{"version":99}', "future formats are preserved rather than reset by an older runtime");
});

test("OS-buffered counters serialize independent processes and survive their normal exit", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-request-processes-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const module = new URL("../src/core/code-evidence/request-telemetry.ts", import.meta.url).href;
  const script = `import {recordCodeRequest} from ${JSON.stringify(module)}; for(let i=0;i<4;i++) await recordCodeRequest(${JSON.stringify(root)},["file.py"],true);`;
  await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script])));
  assert.equal((await codeRequestSummary(root)).byLanguage.python?.served, 12);
});

test("empty, truncated and inconsistent counters are archived and recovered without losing concurrent requests", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-request-recovery-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  for (const corrupt of ["", '{"version":1', '{"version":1,"startedAt":"2026-09-06T00:00:00.000Z","byLanguage":{},"recent":[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","language":"python","fallback":false}],"unlinkedFallbacks":0}']) {
    const before = await recordCodeRequest(root, ["one.py"], true);
    await fs.writeFile(codeRequestTelemetryFile(root), corrupt);
    await assert.rejects(codeRequestSummary(root), /Corrupt.*code-request-counts/);
    assert.equal(await fs.readFile(codeRequestTelemetryFile(root), "utf8"), corrupt, "status is read-only");
    const ids = await Promise.all(Array.from({ length: 6 }, () => recordCodeRequest(root, ["one.py"], true)));
    await recordCodeRequestFallback(root, ids[0], "no_match");
    assert.equal((await recordCodeRequestFallback(root, before, "no_match")).linked, false);
    const summary = await codeRequestSummary(root);
    assert.equal(summary.byLanguage.python?.served, 6);
    assert.equal(summary.byLanguage.python?.fallbackRate, 1 / 6);
    assert.ok(summary.recovery);
    assert.equal(await fs.readFile(join(root, summary.recovery.file), "utf8"), corrupt);
  }
  assert.equal((await fs.readdir(join(root, ".knowledge-rail"))).filter((name) => name.includes(".corrupt-")).length, 3);
  await fs.writeFile(codeRequestTelemetryFile(root), "");
  const module = new URL("../src/core/code-evidence/request-telemetry.ts", import.meta.url).href;
  const script = `import {recordCodeRequest} from ${JSON.stringify(module)}; for(let i=0;i<4;i++) await recordCodeRequest(${JSON.stringify(root)},["one.py"],true);`;
  await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script])));
  assert.equal((await codeRequestSummary(root)).byLanguage.python?.served, 12);
  assert.equal((await fs.readdir(join(root, ".knowledge-rail"))).filter((name) => name.includes(".corrupt-")).length, 4);
});

test("counter recovery never moves or modifies a foreign symlink or a non-regular file", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "kr-request-recovery-scope-")), wiki = join(root, "wiki");
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await recordCodeRequest(wiki, [], false);
  await fs.rm(codeRequestTelemetryFile(wiki));
  const foreign = join(root, "foreign.json"); await fs.writeFile(foreign, "broken");
  await fs.symlink(foreign, codeRequestTelemetryFile(wiki));
  await assert.rejects(recordCodeRequest(wiki, [], false), /outside/);
  assert.equal(await fs.readFile(foreign, "utf8"), "broken");
  await fs.unlink(codeRequestTelemetryFile(wiki)); await fs.mkdir(codeRequestTelemetryFile(wiki));
  await assert.rejects(recordCodeRequest(wiki, [], false), /Invalid/);
  assert.equal((await fs.readdir(join(wiki, ".knowledge-rail"))).some((name) => name.includes(".corrupt-")), false);
});

test("public code tools expose request IDs and status counts without changing hits or attributing failed calls", async (t) => {
  const previous = getWikiRoot(), root = await fs.mkdtemp(join(tmpdir(), "kr-code-requests-mcp-"));
  setWikiRoot(root);
  t.after(async () => { setWikiRoot(previous); clearWorkspaceStates(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(join(root, "unit.py"), "def place():\n return 1\n");
  let run!: (args: Record<string, unknown>) => Promise<any>;
  registerCodeEvidenceTools({ registerTool(_name: string, _config: unknown, handler: typeof run) { run = handler; } } as unknown as McpServer);
  await run({ action: "rebuild" });
  const hit = await run({ action: "symbol", symbol: "place" });
  assert.equal(typeof hit.structuredContent.requestId, "string");
  const empty = await run({ action: "search", query: "missing", path_prefixes: ["unit.py"] });
  await run({ action: "references", symbol_id: hit.structuredContent.hits[0].fragment.id });
  await run({ action: "symbol" });
  const fallback = await run({ action: "record_fallback", query: "missing", request_id: empty.structuredContent.requestId,
    fallback_reason: "no_match", fallback_result_count: 0 });
  assert.equal(fallback.structuredContent.requestTelemetry.linked, true);
  const status = (await run({ action: "status" })).structuredContent.status.requestTelemetry;
  assert.equal(status.byLanguage.python.served, 3);
  assert.equal(status.byLanguage.python.fallbackRate, 1 / 3);
});
