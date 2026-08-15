import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { renderPdfPages } from "../src/services/pdf-renderer.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Build a tiny, standards-compliant one-page PDF without another test dependency. */
function minimalPdf(): Buffer {
  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let byteLength = Buffer.byteLength(chunks[0], "ascii");

  const addObject = (number: number, body: string): void => {
    offsets[number] = byteLength;
    const object = `${number} 0 obj\n${body}\nendobj\n`;
    chunks.push(object);
    byteLength += Buffer.byteLength(object, "ascii");
  };

  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObject(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>"
  );
  addObject(4, "<< /Length 0 >>\nstream\n\nendstream");

  const xrefOffset = byteLength;
  const xrefEntries = [
    "0000000000 65535 f ",
    ...offsets.slice(1, 5).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
  ].join("\n");
  chunks.push(
    `xref\n0 5\n${xrefEntries}\n` +
    "trailer\n<< /Size 5 /Root 1 0 R >>\n" +
    `startxref\n${xrefOffset}\n%%EOF\n`
  );

  return Buffer.from(chunks.join(""), "ascii");
}

test("pinned PDF renderer produces an in-memory PNG on the supported runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-pdf-render-"));
  const pdfPath = path.join(root, "minimal.pdf");

  try {
    await fs.writeFile(pdfPath, minimalPdf());
    const pages = await renderPdfPages(pdfPath, { viewportScale: 1 });

    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.pageNumber, 1);
    assert.equal(pages[0]?.width, 72);
    assert.equal(pages[0]?.height, 72);
    assert.equal(Buffer.isBuffer(pages[0]?.content), true);
    assert.deepEqual(pages[0]?.content?.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
