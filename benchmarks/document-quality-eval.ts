import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSectionContext, formatSectionContext } from "../src/core/document-workflow.js";
import { clearRetrievalIndexes, getWikiPageRecords } from "../src/core/retrieval-index.js";
import { tokenizeSearchText } from "../src/core/text-analysis.js";

interface Scenario {
  name: string;
  sectionTitle: string;
  query: string;
  evidence: string[];
}

const filler = "Contesto generale del progetto e note operative non specifiche. ".repeat(35);

async function writePage(
  root: string,
  relPath: string,
  metadata: { title: string; type: string; tags: string[]; requestId?: string; sources?: string[] },
  body: string
): Promise<void> {
  const absolute = path.join(root, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, [
    "---",
    `title: "${metadata.title}"`,
    `type: ${metadata.type}`,
    `tags: [${metadata.tags.join(", ")}]`,
    "created: 2026-07-11",
    "updated: 2026-07-11",
    `sources: [${(metadata.sources ?? []).map((source) => `"${source}"`).join(", ")}]`,
    ...(metadata.requestId ? [`request_id: "${metadata.requestId}"`] : []),
    "---",
    "",
    body,
  ].join("\n"), "utf-8");
}

export async function createConsultingFixture(root: string): Promise<void> {
  await writePage(root, "client/Fatture_cliente.md", {
    title: "Processo fatture cliente", type: "client_source", tags: ["fatture", "approvazione"],
    sources: ["docs/client/intervista.md"],
  }, `# Processo attuale\n\n${filler}\n\n## Regola approvativa\n\nEVID-FUNC-01 Le fatture oltre 25.000 EUR richiedono due approvatori appartenenti a ruoli differenti.`);
  await writePage(root, "requirements/REQ_42.md", {
    title: "REQ-42 Approvazione fatture", type: "requirement", tags: ["fatture", "audit"], requestId: "REQ-42",
  }, `# Requisito\n\n${filler}\n\n## Criteri di accettazione\n\nEVID-FUNC-02 Ogni approvazione deve registrare utente, ruolo, timestamp e motivazione nel registro audit.`);
  await writePage(root, "decisions/DEC_42.md", {
    title: "Decisione segregazione ruoli", type: "decision", tags: ["ruoli", "sicurezza"], requestId: "REQ-42",
  }, `# Decisione\n\n${filler}\n\n## Esito\n\nEVID-FUNC-03 Il richiedente non può approvare la propria fattura, anche se possiede un ruolo approvatore.`);
  await writePage(root, "risks/RISK_42.md", {
    title: "Rischio indisponibilità approvatori", type: "risk", tags: ["fatture", "approvazione"], requestId: "REQ-42",
  }, `# Rischio\n\n${filler}\n\n## Mitigazione\n\nEVID-FUNC-04 La delega temporanea scade dopo 48 ore e deve essere autorizzata dal responsabile Finance.`);
  await writePage(root, "apis/Invoice_API.md", {
    title: "Invoice Approval API", type: "api", tags: ["api", "fatture"], requestId: "REQ-42",
  }, `# API\n\n${filler}\n\n## Endpoint PATCH\n\nEVID-TECH-01 PATCH /v1/invoices/{id}/approval richiede OAuth2 scope invoice.approve e header Idempotency-Key.`);
  await writePage(root, "data_models/Invoice.md", {
    title: "Invoice data model", type: "data_model", tags: ["invoice-schema", "data-model"], requestId: "REQ-42",
  }, `# Modello\n\n${filler}\n\n## Campi\n\nEVID-TECH-02 invoice.approval_status usa Draft, Pending, Approved, Rejected; approval_audit.payload_json conserva il JSON immutabile.`);
  await writePage(root, "implementations/Invoice_Service.md", {
    title: "InvoiceApprovalService", type: "implementation", tags: ["idempotenza", "oauth"], requestId: "REQ-42",
  }, `# Implementazione\n\n${filler}\n\n## Concorrenza\n\nEVID-TECH-03 InvoiceApprovalService usa optimistic locking su version_timestamp e restituisce HTTP 409 sui conflitti.`);
  await writePage(root, "tests/Invoice_Test.md", {
    title: "Test approvazione fatture", type: "test_result", tags: ["test", "fatture"], requestId: "REQ-42",
  }, `# Test\n\n${filler}\n\n## Casi limite\n\nEVID-TECH-04 Il replay dello stesso Idempotency-Key restituisce la risposta originale senza creare un secondo audit.`);
  for (let index = 0; index < 8; index++) {
    await writePage(root, `concepts/Noise_${index}.md`, {
      title: `Nota generale ${index}`, type: "concept", tags: ["fatture", "progetto"],
    }, `# Nota\n\n${filler}${filler}`);
  }
}

function evidenceRecall(output: string, evidence: readonly string[]): number {
  return evidence.filter((marker) => output.includes(marker)).length / evidence.length;
}

async function legacyPrefixContext(root: string, scenario: Scenario): Promise<string> {
  const terms = tokenizeSearchText(`${scenario.sectionTitle} ${scenario.query}`);
  const records = await getWikiPageRecords(root);
  return records.map((record) => ({
    record,
    score: terms.reduce((sum, term) => sum + (record.raw.toLowerCase().includes(term) ? 1 : 0), 0),
  }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.record.path.localeCompare(b.record.path))
    .slice(0, 8)
    .map((item) => item.record.body.slice(0, 1000))
    .join("\n\n");
}

export async function evaluateScenario(root: string, scenario: Scenario): Promise<{
  name: string;
  legacyRecall: number;
  v3Recall: number;
  legacyChars: number;
  v3Chars: number;
  pages: number;
}> {
  const legacy = await legacyPrefixContext(root, scenario);
  const result = await createSectionContext({
    wikiRoot: root,
    sectionTitle: scenario.sectionTitle,
    query: scenario.query,
    retrievalProfile: "coverage",
    maxPages: 8,
    maxCharsPerPage: 1200,
    maxTotalChars: 5000,
    maxOutputChars: 6000,
    useGraph: true,
  });
  const v3 = formatSectionContext(result, scenario.sectionTitle, 6000);
  return {
    name: scenario.name,
    legacyRecall: evidenceRecall(legacy, scenario.evidence),
    v3Recall: evidenceRecall(v3, scenario.evidence),
    legacyChars: legacy.length,
    v3Chars: v3.length,
    pages: result.pages.length,
  };
}

export const QUALITY_SCENARIOS: Scenario[] = [
  {
    name: "documentazione funzionale",
    sectionTitle: "Regole e criteri approvazione fatture",
    query: "soglia ruoli audit delega richiedente approvatore",
    evidence: ["EVID-FUNC-01", "EVID-FUNC-02", "EVID-FUNC-03", "EVID-FUNC-04"],
  },
  {
    name: "documentazione tecnica",
    sectionTitle: "API e implementazione approvazione fatture",
    query: "PATCH OAuth2 Idempotency-Key invoice.approval_status optimistic locking HTTP 409 replay audit",
    evidence: ["EVID-TECH-01", "EVID-TECH-02", "EVID-TECH-03", "EVID-TECH-04"],
  },
];

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-rail-quality-"));
  try {
    await createConsultingFixture(root);
    clearRetrievalIndexes();
    for (const scenario of QUALITY_SCENARIOS) {
      const result = await evaluateScenario(root, scenario);
      process.stdout.write(`${result.name}: legacy recall ${(result.legacyRecall * 100).toFixed(0)}%, v3 recall ${(result.v3Recall * 100).toFixed(0)}%, legacy ${result.legacyChars} chars, v3 ${result.v3Chars} chars, pages ${result.pages}\n`);
    }
  } finally {
    clearRetrievalIndexes();
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
