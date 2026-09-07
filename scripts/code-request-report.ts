import { resolve } from "node:path";
import { codeRequestSummary } from "../src/core/code-evidence/request-telemetry.js";

// Read-only aggregate: no query text, result body, request IDs or source paths.
console.log(JSON.stringify(await codeRequestSummary(resolve(process.argv[2] ?? "wiki")), null, 2));
