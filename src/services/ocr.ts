import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { renderPdfPages } from "./pdf-renderer.js";

export const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp",
  ".tiff", ".tif", ".webp", ".avif",
]);

export const PDF_EXTENSIONS = new Set([".pdf"]);

export const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".csv", ".json", ".xml",
  ".html", ".htm", ".rst", ".yaml", ".yml",
  ".log", ".tsv",
]);

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(nodePath.extname(filePath).toLowerCase());
}

export function isPdfFile(filePath: string): boolean {
  return PDF_EXTENSIONS.has(nodePath.extname(filePath).toLowerCase());
}

export function isTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(nodePath.extname(filePath).toLowerCase());
}

export interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  error?: string;
}

export interface NativeOcrResponse {
  markdown_result?: string;
  md_results?: string;
  error?: string;
}

export interface OcrRequestOptions {
  timeoutMs?: number;
  retries?: number;
}

export interface PdfOcrOptions extends OcrRequestOptions {
  continueOnPageError?: boolean;
  renderPdf?: (pdfPath: string) => Promise<Array<{ content?: Buffer }>>;
}

async function withRetries<T>(
  fn: () => Promise<T>,
  opts: OcrRequestOptions = {}
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 0);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

export async function callGlmOcrBase64(
  base64Image: string,
  prompt: string,
  ollamaHost: string,
  model: string,
  opts: OcrRequestOptions = {}
): Promise<string> {
  const body = JSON.stringify({
    model,
    prompt,
    images: [base64Image],
    stream: false,
  });

  return withRetries(async () => {
    const response = await fetch(`${ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(`Ollama returned HTTP ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;
    if (data.error) throw new Error(`GLM-OCR error: ${data.error}`);
    return data.response.trim();
  }, opts);
}

export async function callGlmOcr(
  imagePath: string,
  prompt: string,
  ollamaHost: string,
  model: string,
  opts: OcrRequestOptions = {}
): Promise<string> {
  const buf = await fs.readFile(imagePath);
  return callGlmOcrBase64(buf.toString("base64"), prompt, ollamaHost, model, opts);
}

export async function processPdfOllama(
  pdfPath: string,
  prompt: string,
  ollamaHost: string,
  model: string,
  opts: PdfOcrOptions = {}
): Promise<string> {
  const renderPdf = opts.renderPdf ?? ((path: string) => renderPdfPages(path));
  const pages = await renderPdf(pdfPath);
  const results: string[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const [i, page] of pages.entries()) {
    const pageNo = i + 1;
    if (!page.content) {
      failed++;
      results.push(`## Page ${pageNo}\n\n*(page rendering failed)*`);
      continue;
    }
    try {
      const b64 = page.content.toString("base64");
      const text = await callGlmOcrBase64(b64, prompt, ollamaHost, model, opts);
      succeeded++;
      results.push(`## Page ${pageNo}\n\n${text}`);
    } catch (err: unknown) {
      failed++;
      if (!opts.continueOnPageError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      results.push(`## Page ${pageNo}\n\n*(OCR failed: ${message})*`);
    }
  }

  return [
    `<!-- OCR summary: ${succeeded}/${pages.length} pages succeeded, ${failed} failed -->`,
    results.join("\n\n---\n\n"),
  ].join("\n\n");
}

export async function processNative(
  absFilePath: string,
  nativeHost: string,
  opts: OcrRequestOptions = {}
): Promise<string> {
  const fileUri = pathToFileURL(absFilePath).href;

  return withRetries(async () => {
    const response = await fetch(`${nativeHost}/glmocr/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: [fileUri] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(`GLM-OCR native server returned HTTP ${response.status}: ${text}`);
    }

    const data = (await response.json()) as NativeOcrResponse;
    if (data.error) throw new Error(`GLM-OCR error: ${data.error}`);
    return (data.markdown_result ?? data.md_results ?? "").trim();
  }, opts);
}
