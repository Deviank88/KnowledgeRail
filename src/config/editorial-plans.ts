export const EDITORIAL_EVIDENCE_KINDS = [
  "requirement",
  "implementation",
  "decision",
  "source",
  "constraint",
  "invariant",
  "test",
  "risk",
  "current_state",
  "dependency",
  "contradiction",
] as const;

export type EditorialEvidenceKind = (typeof EDITORIAL_EVIDENCE_KINDS)[number];

export interface SectionEvidencePlan {
  require: EditorialEvidenceKind[];
  prefer: EditorialEvidenceKind[];
}

type EvidenceRule = {
  title: RegExp;
  plan: SectionEvidencePlan;
};

const COMMON_RULES: readonly EvidenceRule[] = [
  {
    title: /soluzione|to.?be/i,
    plan: {
      require: ["requirement", "implementation"],
      prefer: ["decision", "constraint", "source"],
    },
  },
  {
    title: /requisit|criteri|feature|funzionalit|success metric/i,
    plan: { require: ["requirement"], prefer: ["decision", "source", "test"] },
  },
  {
    title: /architett|component|infrastrutt|deployment|setup|repository/i,
    plan: {
      require: ["implementation"],
      prefer: ["decision", "requirement", "dependency", "constraint"],
    },
  },
  {
    title: /dat[ai]|entit|schema|persist|cache/i,
    plan: {
      require: ["implementation"],
      prefer: ["requirement", "decision", "constraint"],
    },
  },
  {
    title: /fluss|process|scenario|workflow|use case/i,
    plan: {
      require: ["requirement", "implementation"],
      prefer: ["decision", "source", "test"],
    },
  },
  {
    title: /api|integraz|interface|endpoint|authentication|autenticazione/i,
    plan: {
      require: ["implementation", "dependency"],
      prefer: ["requirement", "decision", "test", "constraint"],
    },
  },
  {
    title: /security|sicurezza|observability|test|verifica/i,
    plan: {
      require: ["requirement", "test"],
      prefer: ["implementation", "decision", "risk", "constraint"],
    },
  },
  {
    title: /decision|adr|trade.?off/i,
    plan: { require: ["decision"], prefer: ["requirement", "implementation", "risk"] },
  },
  {
    title: /risk|risch|mitig/i,
    plan: { require: ["risk"], prefer: ["requirement", "decision", "source"] },
  },
  {
    title: /contesto|motivazione|problem|scopo|obiettiv|summary|benvenuto/i,
    plan: { require: ["source"], prefer: ["current_state", "requirement", "decision"] },
  },
  {
    title: /timeline|roadmap|budget|resource|constraint|assumption|vincol/i,
    plan: { require: ["constraint"], prefer: ["source", "risk", "decision"] },
  },
];

const DOCUMENT_DEFAULTS: Readonly<Record<string, SectionEvidencePlan>> = {
  functional_spec: {
    require: ["requirement"],
    prefer: ["decision", "source", "implementation", "test", "risk"],
  },
  functional_analysis: {
    require: ["requirement", "source"],
    prefer: ["decision", "current_state", "implementation", "test", "risk"],
  },
  technical_analysis: {
    require: ["implementation", "requirement"],
    prefer: ["decision", "dependency", "constraint", "test", "risk"],
  },
  architecture_doc: {
    require: ["implementation", "decision"],
    prefer: ["requirement", "dependency", "constraint", "risk", "test"],
  },
  project_brief: {
    require: ["source"],
    prefer: ["requirement", "decision", "risk", "constraint"],
  },
  user_manual: {
    require: ["requirement", "implementation"],
    prefer: ["test", "source", "constraint", "risk"],
  },
  onboarding_guide: {
    require: ["implementation"],
    prefer: ["dependency", "decision", "test", "constraint"],
  },
  api_reference: {
    require: ["implementation", "dependency"],
    prefer: ["requirement", "decision", "test", "constraint"],
  },
  adr: {
    require: ["decision"],
    prefer: ["requirement", "constraint", "implementation", "risk"],
  },
  runbook: {
    require: ["implementation"],
    prefer: ["dependency", "risk", "test", "constraint"],
  },
  test_plan: {
    require: ["requirement", "test"],
    prefer: ["risk", "implementation", "constraint"],
  },
  incident_report: {
    require: ["current_state", "risk"],
    prefer: ["implementation", "test", "contradiction", "source"],
  },
  release_notes: {
    require: ["implementation", "test"],
    prefer: ["requirement", "risk", "source"],
  },
  custom: {
    require: [],
    prefer: ["source", "requirement", "decision", "implementation"],
  },
};

function uniqueKinds(values: readonly EditorialEvidenceKind[]): EditorialEvidenceKind[] {
  return [...new Set(values)];
}

export function normalizeSectionEvidencePlan(plan: SectionEvidencePlan): SectionEvidencePlan {
  const require = uniqueKinds(plan.require);
  const required = new Set(require);
  return {
    require,
    prefer: uniqueKinds(plan.prefer).filter((kind) => !required.has(kind)),
  };
}

export function sectionEvidencePlan(
  documentType: string | undefined,
  sectionTitle: string,
  override?: Partial<SectionEvidencePlan>
): SectionEvidencePlan {
  const fallback = DOCUMENT_DEFAULTS[documentType ?? "custom"] ?? DOCUMENT_DEFAULTS.custom;
  const matched = COMMON_RULES.find((rule) => rule.title.test(sectionTitle))?.plan ?? fallback;
  return normalizeSectionEvidencePlan({
    require: override?.require ?? matched.require,
    prefer: override?.prefer ?? matched.prefer,
  });
}
