import type { PngPageOutput } from "pdf-to-png-converter";

export interface PdfRenderOptions {
  viewportScale?: number;
}

/**
 * Render PDF pages to in-memory PNG buffers.
 *
 * The converter stays behind a dynamic import so the MCP/retrieval hot path does
 * not initialize PDF.js/canvas unless OCR actually needs PDF rendering. Page
 * rendering is intentionally sequential: the OCR pipeline consumes pages in
 * order and retaining multiple high-resolution canvases concurrently only
 * increases peak memory without improving downstream OCR throughput.
 */
export async function renderPdfPages(
  pdfPath: string,
  options: PdfRenderOptions = {}
): Promise<PngPageOutput[]> {
  const { pdfToPng } = await import("pdf-to-png-converter");
  return pdfToPng(pdfPath, {
    viewportScale: options.viewportScale ?? 2.0,
    returnPageContent: true,
    processPagesInParallel: false,
  });
}
