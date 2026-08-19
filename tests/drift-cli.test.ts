import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import type { DriftCliOptions } from "../src/cli.js";
import type { DriftLedgerEntry, DriftSummary } from "../src/core/drift-detection.js";
import {
  formatDriftText,
  normalizeDriftCliPaths,
  runDriftCli,
  type DriftCliIo,
} from "../src/runtime/drift-cli.js";

const CHECKED_AT = "2026-08-19T12:00:00.000Z";
const BASE_OPTIONS: DriftCliOptions = {
  root: path.resolve("fixture"),
  paths: [],
  format: "text",
  check: false,
  writeLedger: false,
  timeoutMs: 3_000,
};

function entry(index: number, verdict: DriftLedgerEntry["verdict"]): DriftLedgerEntry {
  const reason = verdict === "drift_suspected" ? "content_changed" as const : undefined;
  return {
    claimId: `claim-${index.toString(16).padStart(32, "0")}`,
    pagePaths: [`implementations/Page${index}.md`],
    anchor: {
      path: `src/file-${index}.ts`,
      startLine: index + 1,
      endLine: index + 2,
      rangeHash: "a".repeat(64),
      parserVersion: "typescript-javascript-deterministic-v2",
      capturedAt: CHECKED_AT,
    },
    checkedAt: CHECKED_AT,
    verdict,
    ...(reason ? { reason } : {}),
  };
}

function result(entries: DriftLedgerEntry[]): { summary: DriftSummary; entries: DriftLedgerEntry[] } {
  const fresh = entries.filter((item) => item.verdict === "fresh").length;
  const driftSuspected = entries.filter((item) => item.verdict === "drift_suspected").length;
  const anchorUnresolvable = entries.filter((item) => item.verdict === "anchor_unresolvable").length;
  return {
    summary: {
      checkedAt: CHECKED_AT,
      scope: "all",
      paths: [],
      totalAnchors: entries.length,
      checkedAnchors: entries.length,
      fresh,
      driftSuspected,
      anchorUnresolvable,
      topDrifted: [],
      recommendedClaimIds: [],
    },
    entries,
  };
}

function capturedIo(): DriftCliIo & { stdoutText: string; stderrText: string } {
  const capture = {
    stdoutText: "",
    stderrText: "",
    stdout: { write(value: string) { capture.stdoutText += value; } },
    stderr: { write(value: string) { capture.stderrText += value; } },
  };
  return capture;
}

function dependenciesFor(driftResult: ReturnType<typeof result>) {
  return {
    resolve: async () => ({ root: BASE_OPTIONS.root!, source: "explicit" as const }),
    canonicalize: async (value: string) => value,
    detect: async () => driftResult,
  };
}

test("drift text stays silent when every anchor is fresh", async () => {
  const io = capturedIo();
  const driftResult = result([entry(1, "fresh"), entry(2, "fresh")]);
  assert.equal(await runDriftCli(BASE_OPTIONS, io, dependenciesFor(driftResult)), 0);
  assert.equal(io.stdoutText, "");
  assert.equal(io.stderrText, "");
  assert.equal(formatDriftText(driftResult), "");
});

test("drift text is bounded and check mode rejects every non-fresh verdict", async () => {
  const entries = [
    entry(0, "fresh"),
    ...Array.from({ length: 21 }, (_, index) => entry(index + 1, "drift_suspected")),
    entry(22, "anchor_unresolvable"),
  ];
  const driftResult = result(entries);
  const io = capturedIo();
  const exitCode = await runDriftCli({ ...BASE_OPTIONS, check: true }, io, dependenciesFor(driftResult));
  assert.equal(exitCode, 2);
  const lines = io.stdoutText.trimEnd().split("\n");
  assert.equal(lines[0], "drift: 1 fresh, 22 stale, 21 drift_suspected, 1 unresolvable");
  assert.equal(lines.length, 22);
  assert.equal(lines.at(-1), "… +2 more");
  assert.equal(lines.slice(1, -1).every((line) => line.length <= 500), true);
});

test("drift JSON returns the full core result and forwards scope and no-ledger", async () => {
  const io = capturedIo();
  const driftResult = result([entry(1, "drift_suspected")]);
  let received: Record<string, unknown> | undefined;
  const exitCode = await runDriftCli({
    ...BASE_OPTIONS,
    paths: ["src/file-1.ts"],
    format: "json",
  }, io, {
    resolve: async () => ({ root: BASE_OPTIONS.root!, source: "explicit" }),
    canonicalize: async (value) => value,
    detect: async (params) => {
      received = params as unknown as Record<string, unknown>;
      return driftResult;
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(io.stdoutText), driftResult);
  assert.deepEqual(received?.paths, ["src/file-1.ts"]);
  assert.equal(received?.writeLedger, false);
  assert.ok(received?.signal instanceof AbortSignal);
});

test("drift timeout is fail-open for hooks and fail-closed in check mode", async () => {
  for (const check of [false, true]) {
    const io = capturedIo();
    const exitCode = await runDriftCli({ ...BASE_OPTIONS, check, timeoutMs: 5 }, io, {
      resolve: async () => new Promise<never>(() => undefined),
    });
    assert.equal(exitCode, check ? 2 : 0);
    assert.equal(io.stdoutText, "");
    assert.equal(io.stderrText, "drift check timed out after 5ms\n");
  }
});

test("drift runtime failures use one stderr line without a stack", async () => {
  const io = capturedIo();
  const exitCode = await runDriftCli(BASE_OPTIONS, io, {
    resolve: async () => { throw new Error("Unreadable wiki\nprivate stack detail"); },
  });
  assert.equal(exitCode, 1);
  assert.equal(io.stdoutText, "");
  assert.equal(io.stderrText, "Unreadable wiki private stack detail\n");
  assert.equal(io.stderrText.split("\n").length, 2);
});

test("absolute hook paths are accepted only inside the project", async () => {
  const root = path.resolve("fixture project");
  assert.deepEqual(await normalizeDriftCliPaths(root, [
    "src/local.ts",
    path.join(root, "src", "absolute.ts"),
  ]), ["src/local.ts", "src/absolute.ts"]);
  await assert.rejects(
    normalizeDriftCliPaths(root, [path.resolve(root, "..", "outside.ts")]),
    /inside the project root/
  );
});
