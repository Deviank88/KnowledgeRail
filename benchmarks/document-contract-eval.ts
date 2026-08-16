import { pathToFileURL } from "node:url";
import {
  DOCUMENT_CONTRACTS,
  DOCUMENT_TYPES,
  type DocumentType,
} from "../src/config/document-contracts.js";
import { DOCUMENT_PERSONAS, DOCUMENT_TEMPLATES } from "../src/config/templates.js";
import {
  parseTemplateSections,
  reviewDocumentStructure,
} from "../src/core/document-workflow.js";

const CONTRACT_SIGNALS: Readonly<Record<DocumentType, string>> = {
  functional_spec: "Criteri di accettazione: dato un utente valido, quando conferma, allora l'operazione è registrata.",
  functional_analysis: "Expected outcome and acceptance criteria: the verified business process completes without unsupported manual steps.",
  technical_analysis: "Verification strategy: automated tests and validation confirm the proposed interfaces and migration behavior.",
  architecture_doc: "ADR-001 records the architecture decision and its trade-off after evidence review.",
  project_brief: "Success metric: at least 95% of target users complete the workflow without assistance.",
  user_manual: "How to complete the task:\n1. Open the verified workspace.\n2. Confirm the expected outcome.",
  onboarding_guide: "```bash\nnpm run verify\n```",
  api_reference: "POST /v1/items\n\n```json\n{ \"id\": \"item-1\" }\n```",
  adr: "Status: Accepted after technical and operational review.",
  runbook: "```bash\ncurl --fail https://service.example/health\n```",
  test_plan: "Expected result: the persisted outcome matches the acceptance criteria.",
  incident_report: "The action item has an owner and a due date; the owner verifies closure.",
  release_notes: "Release v4.1.0 was verified against the compatibility matrix.",
  custom: "The document has an explicit purpose, audience and verifiable outcome.",
};

function validDocument(documentType: DocumentType, omitLastSection = false): string {
  const template = DOCUMENT_TEMPLATES[documentType];
  const sections = template
    ? parseTemplateSections(template)
    : [{ level: 2, title: "Purpose and Outcome", heading: "## Purpose and Outcome" }];
  const selected = omitLastSection ? sections.slice(0, -1) : sections;
  return [
    `# ${DOCUMENT_CONTRACTS[documentType].label}: Evaluation fixture`,
    "",
    ...selected.flatMap((section, index) => [
      `## ${section.title}`,
      "",
      index === 0
        ? `${CONTRACT_SIGNALS[documentType]} This section records concrete, evidence-backed information and a verifiable outcome for the intended audience.`
        : "This section records concrete, evidence-backed information, its operational implications, and a verifiable outcome for the intended audience.",
      "",
    ]),
  ].join("\n");
}

export interface DocumentContractEvaluation {
  documentTypes: DocumentType[];
  assetSecurityRejected: boolean;
  metrics: {
    ContractRegistryCoverage: number;
    TemplateCoverage: number;
    PersonaCoverage: number;
    ValidDocumentAcceptanceRate: number;
    InvalidDocumentRejectionRate: number;
    DeliveryReadinessAccuracy: number;
  };
  results: Array<{
    documentType: DocumentType;
    validReadyForDelivery: boolean;
    invalidRejected: boolean;
    contractChecksPassed: number;
    contractCheckCount: number;
  }>;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

export async function evaluateDocumentContracts(): Promise<DocumentContractEvaluation> {
  const results = await Promise.all(DOCUMENT_TYPES.map(async (documentType) => {
    const contract = DOCUMENT_CONTRACTS[documentType];
    const template = DOCUMENT_TEMPLATES[documentType];
    const options = {
      documentType,
      language: contract.defaultLanguage,
      clientFacing: contract.defaultClientFacing,
      includeWikiUpdatePlan: false,
    };
    const valid = await reviewDocumentStructure(validDocument(documentType), template, options);
    const invalidMarkdown = documentType === "custom"
      ? "# Invalid custom document\n\nThis document has no section contract."
      : validDocument(documentType, true);
    const invalid = await reviewDocumentStructure(invalidMarkdown, template, options);
    return {
      documentType,
      validReadyForDelivery: valid.readyForDelivery,
      invalidRejected: !invalid.readyForDelivery,
      contractChecksPassed: valid.contractChecksPassed,
      contractCheckCount: valid.contractCheckCount,
    };
  }));
  const hostileSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const hostileAssetReview = await reviewDocumentStructure(
    "# Asset security fixture\n\n## Diagram\n\nThis section references a caller-owned asset for security validation.\n\n![Flow](../assets/hostile.svg)",
    undefined,
    {
      documentType: "custom",
      assetResolver: async () => ({
        status: "resolved",
        byteLength: hostileSvg.byteLength,
        bytes: hostileSvg,
      }),
    }
  );
  const assetSecurityRejected = !hostileAssetReview.readyForDelivery &&
    hostileAssetReview.findings.some((finding) => finding.code === "SVG_ACTIVE_CONTENT");
  const typedDocuments = DOCUMENT_TYPES.filter((type) => type !== "custom");
  const metrics = {
    ContractRegistryCoverage: ratio(
      DOCUMENT_TYPES.filter((type) => DOCUMENT_CONTRACTS[type]?.type === type).length,
      DOCUMENT_TYPES.length
    ),
    TemplateCoverage: ratio(
      typedDocuments.filter((type) => Boolean(DOCUMENT_TEMPLATES[type])).length,
      typedDocuments.length
    ),
    PersonaCoverage: ratio(
      typedDocuments.filter((type) => Boolean(DOCUMENT_PERSONAS[type])).length,
      typedDocuments.length
    ),
    ValidDocumentAcceptanceRate: ratio(
      results.filter((result) => result.validReadyForDelivery).length,
      results.length
    ),
    InvalidDocumentRejectionRate: ratio(
      results.filter((result) => result.invalidRejected).length,
      results.length
    ),
    DeliveryReadinessAccuracy: ratio(
      results.filter((result) => result.validReadyForDelivery && result.invalidRejected).length +
        (assetSecurityRejected ? 1 : 0),
      results.length + 1
    ),
  };
  process.stdout.write(
    `DOCUMENT_CONTRACTS types=${DOCUMENT_TYPES.length} registry=${metrics.ContractRegistryCoverage.toFixed(4)} ` +
    `templates=${metrics.TemplateCoverage.toFixed(4)} personas=${metrics.PersonaCoverage.toFixed(4)} ` +
    `valid=${metrics.ValidDocumentAcceptanceRate.toFixed(4)} invalid=${metrics.InvalidDocumentRejectionRate.toFixed(4)}\n`
  );
  return { documentTypes: [...DOCUMENT_TYPES], assetSecurityRejected, metrics, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(await evaluateDocumentContracts(), null, 2)}\n`);
}
