import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeRequestSummary, codeRequestTelemetryFile, recordCodeRequest, recordCodeRequestFallback } from "../src/core/code-evidence/request-telemetry.js";

const root = await fs.mkdtemp(join(tmpdir(), "kr-request-cost-"));
const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { p50Ms: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)] }; };
try {
  const served: number[] = [], fallback: number[] = [], status: number[] = [];
  for (let i = 0; i < 50; i++) {
    let start = performance.now(); const id = await recordCodeRequest(root, ["unit.ts"], i % 2 === 0); served.push(performance.now() - start);
    start = performance.now(); await recordCodeRequestFallback(root, id, "no_match"); fallback.push(performance.now() - start);
    start = performance.now(); await codeRequestSummary(root); status.push(performance.now() - start);
  }
  console.log(JSON.stringify({ node: process.version, iterations: 50, scope: "atomic OS-buffered public-request counters; added to code query latency, excluded from internal context/query runtimes",
    served: stats(served), fallback: stats(fallback), status: stats(status), bytes: (await fs.stat(codeRequestTelemetryFile(root))).size,
    maxBytes: 256 * 1024, correlationWindow: 512 }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
