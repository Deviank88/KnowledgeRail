import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { docsCategoryFilePath } from "./paths.js";
import { atomicWriteText } from "./fs-service.js";
import { ensureDir, readFileSafe } from "./utils.js";
import {
  extractPptxMarkdown,
  extractXlsxMarkdown,
  FILE_CATEGORIES,
  type FileCategory,
} from "./report-workflow.js";
import {
  callGlmOcr,
  isImageFile,
  isPdfFile,
  isTextFile,
  processNative,
  processPdfOllama,
} from "../services/ocr.js";

export interface NormalizedOutput {
  rel: string;
  abs: string;
}

export interface NormalizeSourceOptions {
  category: FileCategory;
  relPath: string;
  overwrite?: boolean;
  prompt?: string;
  apiMode?: "ollama" | "native";
  ollamaHost?: string;
  nativeHost?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  continueOnPageError?: boolean;
}

export function normalizedOutputPath(category: string, relPath: string): NormalizedOutput {
  const parsed = nodePath.parse(relPath.replace(/\\/g, "/"));
  const base = `${category}_${parsed.name || "source"}.md`;
  return {
    rel: base,
    abs: docsCategoryFilePath("normalized", base),
  };
}

export function csvToMarkdown(content: string, delimiter: "," | "\t"): string {
  const rows = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 1000)
    .map((line) => line.split(delimiter).map((cell) => cell.trim()));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
  const [header = [], ...body] = normalized;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

const DEFAULT_OCR_PROMPT =
  "Extract all text and content from this document. Convert it to well-structured markdown, preserving tables, lists, code blocks, and hierarchy. Output only markdown.";

function envInt(name: string): number | undefined {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function normalizeSourceFile(
  params: NormalizeSourceOptions
): Promise<{ rel: string; abs: string; sourceLabel: string; chars: number }> {
  // OCR infrastructure config comes from KNOWLEDGE_RAIL_* env vars, not from the LLM
  const {
    category,
    relPath,
    overwrite = false,
    prompt = process.env.KNOWLEDGE_RAIL_OCR_PROMPT ?? DEFAULT_OCR_PROMPT,
    apiMode = process.env.KNOWLEDGE_RAIL_OCR_MODE === "native" ? "native" : "ollama",
    ollamaHost = process.env.KNOWLEDGE_RAIL_OLLAMA_HOST ?? "http://localhost:11434",
    nativeHost = process.env.KNOWLEDGE_RAIL_NATIVE_HOST ?? "http://localhost:5002",
    model = process.env.KNOWLEDGE_RAIL_OCR_MODEL ?? "glm-ocr:latest",
    timeoutMs = envInt("KNOWLEDGE_RAIL_OCR_TIMEOUT_MS"),
    retries = envInt("KNOWLEDGE_RAIL_OCR_RETRIES") ?? 0,
    continueOnPageError = true,
  } = params;

  if (category === "normalized" || category === "deliverables" || category === "assets") {
    throw new Error(`Categoria non normalizzabile: ${category}.`);
  }
  if (!(FILE_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`Categoria non supportata: ${category}.`);
  }

  const absPath = docsCategoryFilePath(category, relPath);
  await fs.access(absPath);

  const out = normalizedOutputPath(category, relPath);
  if (!overwrite && (await readFileSafe(out.abs)) !== null) {
    return {
      ...out,
      sourceLabel: `docs/${category}/${relPath.replace(/\\/g, "/")}`,
      chars: (await readFileSafe(out.abs))?.length ?? 0,
    };
  }

  const ext = nodePath.extname(absPath).toLowerCase();
  const sourceLabel = `docs/${category}/${relPath.replace(/\\/g, "/")}`;
  let normalized = "";

  if (isTextFile(absPath)) {
    const raw = await fs.readFile(absPath, "utf-8");
    if (ext === ".csv") normalized = csvToMarkdown(raw, ",");
    else if (ext === ".tsv") normalized = csvToMarkdown(raw, "\t");
    else normalized = raw;
  } else if (ext === ".xlsx") {
    normalized = await extractXlsxMarkdown(await fs.readFile(absPath));
  } else if (ext === ".pptx") {
    normalized = await extractPptxMarkdown(await fs.readFile(absPath));
  } else if (apiMode === "native" && (isImageFile(absPath) || isPdfFile(absPath))) {
    normalized = await processNative(absPath, nativeHost.replace(/\/$/, ""), {
      timeoutMs,
      retries,
    });
  } else if (isImageFile(absPath)) {
    normalized = await callGlmOcr(absPath, prompt, ollamaHost.replace(/\/$/, ""), model, {
      timeoutMs,
      retries,
    });
  } else if (isPdfFile(absPath)) {
    normalized = await processPdfOllama(absPath, prompt, ollamaHost.replace(/\/$/, ""), model, {
      timeoutMs,
      retries,
      continueOnPageError,
    });
  } else {
    throw new Error(`Formato non supportato: ${ext}.`);
  }

  const wrapped = [
    "---",
    `source: "${sourceLabel}"`,
    `normalized_at: ${new Date().toISOString()}`,
    `category: ${category}`,
    "---",
    "",
    `# Fonte normalizzata: ${nodePath.basename(relPath)}`,
    "",
    normalized.trim() || "_Nessun contenuto estratto._",
    "",
  ].join("\n");

  await ensureDir(nodePath.dirname(out.abs));
  await atomicWriteText(out.abs, wrapped);
  return { ...out, sourceLabel, chars: wrapped.length };
}

