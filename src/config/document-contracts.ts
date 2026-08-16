export const DOCUMENT_TYPES = [
  "functional_spec",
  "architecture_doc",
  "project_brief",
  "onboarding_guide",
  "api_reference",
  "adr",
  "runbook",
  "test_plan",
  "incident_report",
  "release_notes",
  "custom",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Human-readable output follows the current user's language unless the caller
 * supplies a more specific override. Internal contracts remain in English.
 */
export const USER_REQUEST_LANGUAGE = "the user's request language";

export interface DocumentContentRule {
  code: string;
  description: string;
  patterns: readonly string[];
  minimumMatches?: number;
}

export interface DocumentContract {
  type: DocumentType;
  label: string;
  purpose: string;
  defaultLanguage: string;
  defaultClientFacing: boolean;
  categoryLabel: string;
  minimumSectionChars: number;
  contentRules: readonly DocumentContentRule[];
}

const noExtraRules: readonly DocumentContentRule[] = [];

export const DOCUMENT_CONTRACTS: Readonly<Record<DocumentType, DocumentContract>> = {
  functional_spec: {
    type: "functional_spec",
    label: "Functional specification",
    purpose: "Make scope, behavior, requirements and acceptance criteria unambiguous and verifiable.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: true,
    categoryLabel: "FUNCTIONAL SPECIFICATION",
    minimumSectionChars: 40,
    contentRules: [{
      code: "CONTRATTO_CRITERI_ACCETTAZIONE",
      description: "The functional specification must include verifiable acceptance criteria.",
      patterns: ["criteri? di accettazione", "acceptance criteria", "dato.+quando.+allora", "given.+when.+then"],
    }],
  },
  architecture_doc: {
    type: "architecture_doc",
    label: "Architecture document",
    purpose: "Explain boundaries, components, data, deployment, security, observability and decisions.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: false,
    categoryLabel: "ARCHITECTURE DOCUMENT",
    minimumSectionChars: 40,
    contentRules: [{
      code: "CONTRACT_ARCHITECTURE_DECISION",
      description: "The architecture document must make at least one decision or trade-off explicit.",
      patterns: ["\\badr[- ]?\\d*", "architecture decision", "decisione architetturale", "trade[- ]?off"],
    }],
  },
  project_brief: {
    type: "project_brief",
    label: "Project brief",
    purpose: "Give stakeholders a concise view of the problem, solution, users, success and constraints.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: true,
    categoryLabel: "PROJECT BRIEF",
    minimumSectionChars: 24,
    contentRules: [{
      code: "CONTRACT_SUCCESS_METRIC",
      description: "The brief must contain at least one measurable success metric.",
      patterns: ["success metrics?", "metriche? di successo", "\\b(kpi|okr)\\b", "\\d+%"],
    }],
  },
  onboarding_guide: {
    type: "onboarding_guide",
    label: "Onboarding guide",
    purpose: "Let a new contributor set up, run, test and troubleshoot the project independently.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: false,
    categoryLabel: "ONBOARDING GUIDE",
    minimumSectionChars: 32,
    contentRules: [{
      code: "CONTRATTO_COMANDI_ONBOARDING",
      description: "The onboarding guide must include executable setup, run, or test commands.",
      patterns: ["```(?:bash|shell|sh)", "`(?:npm|pnpm|yarn|docker|git|make) [^`]+`"],
    }],
  },
  api_reference: {
    type: "api_reference",
    label: "API reference",
    purpose: "Provide implementable authentication, endpoint, payload, response and error contracts.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: false,
    categoryLabel: "API REFERENCE",
    minimumSectionChars: 32,
    contentRules: [
      {
        code: "CONTRACT_API_ENDPOINT",
        description: "The API reference must contain at least one concrete HTTP method and path.",
        patterns: ["\\b(?:GET|POST|PUT|PATCH|DELETE)\\s+/[A-Za-z0-9_{}:./-]*"],
      },
      {
        code: "CONTRACT_API_EXAMPLE",
        description: "The API reference must contain a request or response example.",
        patterns: ["```json", "request example", "response example", "esempio (?:request|response)"],
      },
    ],
  },
  adr: {
    type: "adr",
    label: "Architecture decision record",
    purpose: "Preserve the context, chosen decision, alternatives and consequences of one decision.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: false,
    categoryLabel: "ARCHITECTURE DECISION RECORD",
    minimumSectionChars: 32,
    contentRules: [{
      code: "CONTRACT_ADR_STATUS",
      description: "An ADR must declare its decision status.",
      patterns: ["status.+(?:proposed|accepted|deprecated|superseded|rejected)", "stato.+(?:proposto|accettato|deprecato|superato|rifiutato)"],
    }],
  },
  runbook: {
    type: "runbook",
    label: "Operational runbook",
    purpose: "Guide operators through detection, diagnosis, mitigation, rollback and escalation.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: false,
    categoryLabel: "OPERATIONAL RUNBOOK",
    minimumSectionChars: 32,
    contentRules: [{
      code: "CONTRACT_RUNBOOK_COMMAND",
      description: "A runbook must contain at least one executable diagnostic or recovery command.",
      patterns: ["```(?:bash|shell|sh|powershell)", "`(?:kubectl|docker|systemctl|npm|pnpm|curl|Invoke-WebRequest) [^`]+`"],
    }],
  },
  test_plan: {
    type: "test_plan",
    label: "Test plan",
    purpose: "Define scope, environments, test cases, expected results, evidence and exit criteria.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: false,
    categoryLabel: "TEST PLAN",
    minimumSectionChars: 32,
    contentRules: [{
      code: "CONTRACT_TEST_EXPECTED_RESULT",
      description: "A test plan must define expected results or acceptance criteria.",
      patterns: ["expected results?", "risultat[oi] attes[oi]", "acceptance criteria", "criteri? di accettazione"],
    }],
  },
  incident_report: {
    type: "incident_report",
    label: "Incident report",
    purpose: "Record impact, timeline, root cause, response, corrective actions and owners.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: false,
    categoryLabel: "INCIDENT REPORT",
    minimumSectionChars: 32,
    contentRules: [{
      code: "CONTRACT_INCIDENT_ACTION_OWNER",
      description: "An incident report must assign at least one corrective action to an owner.",
      patterns: ["owner", "responsabile", "action item", "azione correttiva"],
      minimumMatches: 2,
    }],
  },
  release_notes: {
    type: "release_notes",
    label: "Release notes",
    purpose: "Explain user-visible changes, fixes, compatibility, upgrade steps and known issues.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: true,
    categoryLabel: "RELEASE NOTES",
    minimumSectionChars: 24,
    contentRules: [{
      code: "CONTRACT_RELEASE_VERSION",
      description: "Release notes must identify a concrete version.",
      patterns: ["\\bv?\\d+\\.\\d+(?:\\.\\d+)?(?:[-+][A-Za-z0-9.-]+)?\\b"],
    }],
  },
  custom: {
    type: "custom",
    label: "Custom document",
    purpose: "Produce a structured evidence-backed document with an explicit audience and objective.",
    defaultLanguage: USER_REQUEST_LANGUAGE,
    defaultClientFacing: false,
    categoryLabel: "DOCUMENT",
    minimumSectionChars: 12,
    contentRules: noExtraRules,
  },
};

export function documentContract(documentType: DocumentType): DocumentContract {
  return DOCUMENT_CONTRACTS[documentType];
}
