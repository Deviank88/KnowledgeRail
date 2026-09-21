import { dirname, resolve } from "node:path";
import { codeRequestSummary } from "../src/core/code-evidence/request-telemetry.js";
import { PersistentCodeEvidenceIndex } from "../src/core/code-evidence/index.js";

// Read-only aggregate: no query text, result body, request IDs or source paths.
const wikiRoot = resolve(process.argv[2] ?? "wiki");
const diagnostics = await new PersistentCodeEvidenceIndex({ wikiRoot, repositoryRoot: dirname(wikiRoot) }).importDiagnostics().catch(() => undefined);
console.log(JSON.stringify({ ...await codeRequestSummary(wikiRoot),
  importInventory: diagnostics ? { scope: diagnostics.unresolvedImportsScope, byLanguage: diagnostics.importResolutionCounts ?? {},
    reasonsByLanguage: diagnostics.importReasonsByLanguage ?? {} }
    : { status: "unavailable", reason: "No readable compatible code index; request telemetry remains available." },
}, null, 2));
