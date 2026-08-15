import assert from "node:assert/strict";
import { test } from "node:test";
import { exportDocxFromMarkdownWithStats } from "../src/docx/index.js";

const coverParams = {
  categoryLabel: "Documento Funzionale",
  title: "Documento Test",
  subtitle: "Test",
  version: "1.0",
  date: "2026-05-08",
  status: "Bozza",
};

test("exportDocxFromMarkdownWithStats renders Mermaid blocks as DOCX media", async () => {
  const result = await exportDocxFromMarkdownWithStats({
    markdownBody: [
      "# Documento Test",
      "",
      "## 1. Architettura",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[Email Inbound] --> B[AICaseAnalysis]",
      "```",
    ].join("\n"),
    coverParams,
    client: "Cliente",
    project: "Progetto",
  });

  assert.equal(result.stats.mermaidDiagramsRendered, 1);
  assert.equal(result.stats.legacyAsciiDiagrams, 0);
  assert.equal(result.buffer.toString("latin1").includes("word/media/"), true);
});

test("exportDocxFromMarkdownWithStats keeps legacy ASCII diagrams as code fallback", async () => {
  const result = await exportDocxFromMarkdownWithStats({
    markdownBody: [
      "# Documento Test",
      "",
      "## 1. Architettura",
      "",
      "```",
      "Email Inbound ─────→ AICaseAnalysis",
      "                         ├── AIService",
      "                         └── AICaseParser",
      "```",
    ].join("\n"),
    coverParams,
    client: "Cliente",
    project: "Progetto",
  });

  assert.equal(result.stats.mermaidDiagramsRendered, 0);
  assert.equal(result.stats.legacyAsciiDiagrams, 1);
  assert.equal(result.buffer.toString("latin1").includes("word/media/"), false);
});
