import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createMermaidRenderConfig,
  MermaidCliRenderer,
  resolveMermaidCliInstallation,
} from "../src/docx/mermaid-renderer.js";

test("Mermaid CLI resolution is independent from the served workspace cwd", async () => {
  const originalCwd = process.cwd();
  const foreignWorkspace = await mkdtemp(path.join(tmpdir(), "knowledge-rail-foreign-workspace-"));

  try {
    process.chdir(foreignWorkspace);
    const installation = resolveMermaidCliInstallation();
    assert.equal(path.isAbsolute(installation.cliPath), true);
    assert.equal(existsSync(installation.cliPath), true);
    assert.match(installation.version, /^\d+\.\d+\.\d+/);
  } finally {
    process.chdir(originalCwd);
    await rm(foreignWorkspace, { recursive: true, force: true });
  }
});

test("Mermaid render configuration is secure, bounded and document-oriented", () => {
  const config = createMermaidRenderConfig();
  assert.equal(config.securityLevel, "strict");
  assert.equal(config.maxTextSize, 50_000);
  assert.equal(config.maxEdges, 500);
  assert.equal(config.look, "neo");
  assert.deepEqual(config.secure, [
    "secure",
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "maxEdges",
    "suppressErrorRendering",
    "theme",
    "look",
  ]);
  assert.deepEqual(config.flowchart, {
    defaultRenderer: "elk",
    curve: "rounded",
    diagramPadding: 24,
    padding: 20,
    nodeSpacing: 60,
    rankSpacing: 75,
    wrappingWidth: 220,
    inheritDir: true,
  });
  assert.deepEqual(config.sequence, {
    diagramMarginX: 40,
    diagramMarginY: 24,
    actorMargin: 60,
    width: 160,
    height: 56,
    boxMargin: 12,
    boxTextMargin: 8,
    noteMargin: 14,
    messageMargin: 42,
    messageAlign: "center",
    mirrorActors: false,
    showSequenceNumbers: true,
    wrap: true,
    wrapPadding: 10,
    useMaxWidth: true,
  });
});

test("Mermaid renderer rejects empty and oversized diagrams before spawning Chromium", async () => {
  const renderer = new MermaidCliRenderer({ maxSourceChars: 20 });
  await assert.rejects(() => renderer.renderPng("   \n"), /vuoto/);
  await assert.rejects(() => renderer.renderPng(`flowchart LR\n  ${"A".repeat(40)}`), /limite di 20 caratteri/);
});
