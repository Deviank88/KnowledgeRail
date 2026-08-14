export const MENU_AREAS = ["read", "ingest", "code", "document", "admin"] as const;
export type MenuArea = (typeof MENU_AREAS)[number];

export const WORKFLOW_OUTCOMES = [
  "success",
  "blocked",
  "more_items",
  "no_more_items",
  "coverage_sufficient",
  "coverage_insufficient",
  "gaps_declared",
  "findings",
  "no_findings",
] as const;
export type WorkflowOutcome = (typeof WORKFLOW_OUTCOMES)[number];

export type GuidedToolName =
  | "knowledge_context"
  | "knowledge_files"
  | "knowledge_normalize_source"
  | "knowledge_prepare_request_ingestion"
  | "knowledge_prepare_source_ingestion"
  | "knowledge_evidence_ir"
  | "knowledge_code_evidence"
  | "knowledge_plan_document"
  | "knowledge_section_context"
  | "wiki_write_page"
  | "wiki_edit_page"
  | "wiki_read_page"
  | "wiki_delete_page"
  | "wiki_move_page"
  | "wiki_append_log"
  | "knowledge_init"
  | "wiki_migrate"
  | "wiki_lint"
  | "knowledge_write_document"
  | "knowledge_review_document"
  | "knowledge_export_docx";

type SuggestedValue = string | number | boolean | readonly string[];

export interface WorkflowStep {
  id: string;
  instruction: string;
  tool?: GuidedToolName;
  action?: string;
  suggestedArguments?: Readonly<Record<string, SuggestedValue>>;
  nextStepId?: string;
  transitions?: Readonly<Partial<Record<WorkflowOutcome, string | null>>>;
}

export interface GuidedWorkflow {
  key: string;
  area: MenuArea;
  operation: string;
  description: string;
  completion: string;
  guardrails: readonly string[];
  steps: readonly WorkflowStep[];
}

export interface MenuOperation {
  id: string;
  description: string;
  workflowKey: string;
}

export interface WorkflowTransition {
  next?: WorkflowStep;
  allowedOutcomes: readonly WorkflowOutcome[];
  complete: boolean;
}

const READ_GUARDRAILS = [
  "Usa knowledge_context come accesso primario; wiki_search, wiki_graph_query e wiki_read_page sono primitive low-level.",
  "Su MCP 2.0 materializza soltanto i resource link necessari con resources/read; non convertire i path in page dump.",
  "Se il gap è budget_limited, raddoppia il budget precedente fino al massimo di 12000 token euristici.",
  "Copia coverageSufficient ed evidenceGaps dell'ultimo knowledge_context nel menu: non dichiarare coverage_sufficient se restano gap.",
  "Se coverage resta insufficiente dopo il budget massimo, usa gaps_declared e riporta GAP/unknown invece di inventare.",
] as const;

const INGEST_GUARDRAILS = [
  "max_chars limita una tranche, mai l'intera fonte.",
  "Non scrivere pagine direttamente dal segmento: registra prima Evidence IR.",
  "Non finalizzare finché coverage segnala segmenti unresolved.",
] as const;

const CODE_GUARDRAILS = [
  "Usa knowledge_code_evidence prima di grep o scansioni raw.",
  "Leggi soltanto i resource link code:// necessari.",
  "Registra ogni fallback realmente usato e la knowledge debt emersa.",
] as const;

const DOCUMENT_GUARDRAILS = [
  "Compila un context pack separato per ogni sezione.",
  "Non inventare evidence obbligatoria mancante: emetti GAP.",
  "Esegui review prima dell'eventuale export DOCX.",
] as const;

const ADMIN_GUARDRAILS = [
  "Usa plan/dry-run prima di mutation strutturali quando disponibile.",
  "Non usare operazioni amministrative per normali task di retrieval.",
  "Dopo mutation strutturali esegui wiki_lint.",
] as const;

function readWorkflow(operation: string): GuidedWorkflow {
  return {
    key: `read.${operation}`,
    area: "read",
    operation,
    description: `Compila contesto task-aware con intent=${operation}.`,
    completion: "coverageSufficient=true, oppure ogni informazione mancante è dichiarata come GAP/unknown.",
    guardrails: READ_GUARDRAILS,
    steps: [
      {
        id: "compile_context",
        tool: "knowledge_context",
        instruction: "Compila il contesto bounded e passage-aware in forma compatta.",
        suggestedArguments: {
          intent: operation,
          objective: "<obiettivo del task>",
          response_detail: "compact",
          heuristic_token_budget: 2000,
        },
      },
      {
        id: "read_selected_resources",
        instruction: "Leggi selettivamente i resource link restituiti con resources/read; sui client legacy usa wiki_read_resource. Poi riporta al menu coverageSufficient ed evidenceGaps esattamente come restituiti dall'ultimo knowledge_context.",
        transitions: {
          coverage_sufficient: null,
          coverage_insufficient: "widen_context",
          gaps_declared: null,
        },
      },
      {
        id: "widen_context",
        tool: "knowledge_context",
        instruction: "Ripeti in compact con retrieval_profile=coverage: usa 4000 al primo widening, poi raddoppia il budget precedente fino al massimo di 12000 se resta budget_limited.",
        suggestedArguments: {
          intent: operation,
          objective: "<stesso obiettivo>",
          retrieval_profile: "coverage",
          response_detail: "compact",
          heuristic_token_budget: 4000,
        },
        nextStepId: "read_selected_resources",
      },
    ],
  };
}

function sourceIngestionWorkflow(withNormalization: boolean): GuidedWorkflow {
  const steps: WorkflowStep[] = [];
  if (withNormalization) {
    steps.push({
      id: "normalize_source",
      tool: "knowledge_normalize_source",
      instruction: "Normalizza la fonte in docs/normalized senza alterare l'originale.",
      suggestedArguments: { category: "<client|transcripts|reports|changelogs>", path: "<path fonte>" },
    });
  }
  steps.push(
    {
      id: "plan_source",
      tool: "knowledge_prepare_source_ingestion",
      action: "plan",
      instruction: "Segmenta tutta la fonte e crea il coverage ledger.",
      suggestedArguments: { action: "plan", normalized_filename: "<file normalizzato>" },
    },
    {
      id: "next_segment",
      tool: "knowledge_prepare_source_ingestion",
      action: "next",
      instruction: "Materializza una tranche. Poi riferisci more_items se contiene un segmento, no_more_items se la coda è vuota.",
      suggestedArguments: { action: "next", normalized_filename: "<stesso file>", max_chars: 12000 },
      transitions: { more_items: "record_claims", no_more_items: "check_coverage" },
    },
    {
      id: "record_claims",
      tool: "knowledge_evidence_ir",
      action: "record",
      instruction: "Estrai e registra claim con provenance sourceUri + segmentId.",
      suggestedArguments: {
        action: "record",
        normalized_filename: "<stesso file>",
        segment_id: "<segment id restituito da next>",
        claims: ["<claim strutturati>"],
      },
    },
    {
      id: "link_claims",
      tool: "knowledge_evidence_ir",
      action: "link",
      instruction: "Risolvi entità, duplicati, contraddizioni e destinazioni.",
      suggestedArguments: { action: "link", claim_ids: ["<claim id registrati>"] },
    },
    {
      id: "plan_synthesis",
      tool: "knowledge_evidence_ir",
      action: "plan_synthesis",
      instruction: "Controlla la bozza senza modificare la wiki.",
      suggestedArguments: { action: "plan_synthesis", claim_ids: ["<claim id risolti>"] },
    },
    {
      id: "synthesize",
      tool: "knowledge_evidence_ir",
      action: "synthesize",
      instruction: "Applica la synthesis, aggiorna gli indici e riconcilia la coverage.",
      suggestedArguments: { action: "synthesize", claim_ids: ["<claim id risolti>"] },
      nextStepId: "next_segment",
    },
    {
      id: "check_coverage",
      tool: "knowledge_prepare_source_ingestion",
      action: "coverage",
      instruction: "Verifica coverage e riferisci coverage_sufficient oppure coverage_insufficient.",
      suggestedArguments: { action: "coverage", normalized_filename: "<stesso file>" },
      transitions: {
        coverage_sufficient: "finalize_source",
        coverage_insufficient: "next_segment",
      },
    },
    {
      id: "finalize_source",
      tool: "knowledge_prepare_source_ingestion",
      action: "finalize",
      instruction: "Finalizza soltanto dopo coverage completa.",
      suggestedArguments: { action: "finalize", normalized_filename: "<stesso file>" },
    }
  );
  return {
    key: withNormalization ? "ingest.source" : "ingest.normalized_source",
    area: "ingest",
    operation: withNormalization ? "source" : "normalized_source",
    description: withNormalization
      ? "Normalizza e integra completamente una fonte."
      : "Integra una fonte già presente in docs/normalized.",
    completion: "sourceCoveragePercent=100, coda unresolved vuota e finalize completato.",
    guardrails: INGEST_GUARDRAILS,
    steps,
  };
}

function codeLookupWorkflow(operation: "search" | "symbol"): GuidedWorkflow {
  return {
    key: `code.${operation}`,
    area: "code",
    operation,
    description: operation === "search" ? "Cerca comportamento o termini nel code index." : "Risolvi un simbolo.",
    completion: "evidence indicizzata sufficiente oppure fallback registrato con knowledge debt.",
    guardrails: CODE_GUARDRAILS,
    steps: [
      {
        id: "check_code_index",
        tool: "knowledge_code_evidence",
        action: "status",
        instruction: "Controlla lo stato: success se utilizzabile, blocked se richiede rebuild.",
        suggestedArguments: { action: "status" },
        transitions: { success: "find_code_evidence", blocked: "rebuild_code_index" },
      },
      {
        id: "rebuild_code_index",
        tool: "knowledge_code_evidence",
        action: "rebuild",
        instruction: "Ricostruisci l'indice derivato, poi prosegui con la lookup.",
        suggestedArguments: { action: "rebuild" },
        nextStepId: "find_code_evidence",
      },
      {
        id: "find_code_evidence",
        tool: "knowledge_code_evidence",
        action: operation,
        instruction: operation === "search" ? "Cerca la query nel code index." : "Risolvi il simbolo nel code index.",
        suggestedArguments: operation === "search"
          ? { action: "search", query: "<query codice>" }
          : { action: "symbol", symbol: "<nome simbolo>" },
      },
      {
        id: "read_code_resources",
        instruction: "Materializza soltanto i resource link code:// necessari; poi valuta la coverage.",
        transitions: {
          coverage_sufficient: null,
          coverage_insufficient: "record_code_fallback",
        },
      },
      {
        id: "record_code_fallback",
        tool: "knowledge_code_evidence",
        action: "record_fallback",
        instruction: "Dopo un fallback realmente eseguito, registra query, motivo, risultati ed evidence recuperata.",
        suggestedArguments: {
          action: "record_fallback",
          query: "<query fallback>",
          fallback_reason: "<perché l'indice era insufficiente>",
          fallback_result_count: 0,
        },
      },
    ],
  };
}

const workflows: GuidedWorkflow[] = [
  ...["understand", "implement", "modify", "debug", "review"].map(readWorkflow),
  sourceIngestionWorkflow(true),
  sourceIngestionWorkflow(false),
  {
    key: "ingest.development_report",
    area: "ingest",
    operation: "development_report",
    description: "Valida un development report e applica le bozze wiki.",
    completion: "tutte le bozze applicate, operazione registrata e wiki_lint verde.",
    guardrails: INGEST_GUARDRAILS,
    steps: [
      {
        id: "prepare_report",
        tool: "knowledge_prepare_request_ingestion",
        instruction: "Valida il report e prepara bozze senza scrivere.",
        suggestedArguments: { report_filename: "<file in docs/reports>" },
      },
      {
        id: "write_report_pages",
        tool: "wiki_write_page",
        instruction: "Applica ogni bozza validata; ripeti per tutte le pagine.",
        suggestedArguments: { path: "<path bozza>", content: "<contenuto bozza>" },
      },
      {
        id: "log_report_ingestion",
        tool: "wiki_append_log",
        instruction: "Registra request id, fonti e pagine create/aggiornate.",
        suggestedArguments: { entry: "<riepilogo ingestione>", level: "ACTION" },
      },
      { id: "lint_report_pages", tool: "wiki_lint", instruction: "Verifica le pagine applicate." },
    ],
  },
  codeLookupWorkflow("search"),
  codeLookupWorkflow("symbol"),
  {
    key: "code.references",
    area: "code",
    operation: "references",
    description: "Risolvi un simbolo e recupera i riferimenti strutturali entranti.",
    completion: "riferimenti pertinenti materializzati oppure insufficienza dichiarata.",
    guardrails: CODE_GUARDRAILS,
    steps: [
      {
        id: "resolve_reference_symbol",
        tool: "knowledge_code_evidence",
        action: "symbol",
        instruction: "Risolvi prima il simbolo e ottieni symbol_id.",
        suggestedArguments: { action: "symbol", symbol: "<nome simbolo>" },
      },
      {
        id: "find_references",
        tool: "knowledge_code_evidence",
        action: "references",
        instruction: "Recupera riferimenti strutturali per symbol_id.",
        suggestedArguments: { action: "references", symbol_id: "<symbol id>" },
      },
      { id: "read_reference_resources", instruction: "Materializza selettivamente i resource link code://." },
    ],
  },
  ...(["rebuild", "update", "remove"] as const).map((operation): GuidedWorkflow => ({
    key: `code.${operation}_index`,
    area: "code",
    operation: `${operation}_index`,
    description: `${operation} del code evidence index derivato.`,
    completion: "indice aggiornato e status coerente.",
    guardrails: CODE_GUARDRAILS,
    steps: [
      {
        id: `${operation}_code_index`,
        tool: "knowledge_code_evidence",
        action: operation,
        instruction: `${operation} dell'indice deterministico.`,
        suggestedArguments: operation === "rebuild" ? { action: operation } : { action: operation, path: "<path repository>" },
      },
      {
        id: "verify_code_index",
        tool: "knowledge_code_evidence",
        action: "status",
        instruction: "Verifica lo snapshot risultante.",
        suggestedArguments: { action: "status" },
      },
    ],
  })),
  {
    key: "document.create",
    area: "document",
    operation: "create",
    description: "Crea un deliverable section-by-section con evidence plan.",
    completion: "review senza finding bloccanti e GAP espliciti; export è un'operazione separata.",
    guardrails: DOCUMENT_GUARDRAILS,
    steps: [
      {
        id: "plan_document",
        tool: "knowledge_plan_document",
        instruction: "Ottieni contratto, template, sezioni ed evidence plan dal tool di pianificazione.",
        suggestedArguments: { document_type: "<tipo documento>" },
      },
      {
        id: "compile_section_context",
        tool: "knowledge_section_context",
        instruction: "Compila il context pack della sezione corrente.",
        suggestedArguments: { section_title: "<titolo>", document_type: "<tipo documento>" },
      },
      {
        id: "read_section_resources",
        instruction: "Materializza le evidence selezionate; more_items se restano sezioni, no_more_items altrimenti.",
        transitions: { more_items: "compile_section_context", no_more_items: "write_document" },
      },
      {
        id: "write_document",
        tool: "knowledge_write_document",
        instruction: "Salva il markdown standalone in docs/deliverables.",
        suggestedArguments: { filename: "<nome.md>", title: "<titolo>", document_type: "<tipo>", content: "<markdown>" },
      },
      {
        id: "review_document",
        tool: "knowledge_review_document",
        instruction: "Riferisci findings se occorrono correzioni, no_findings se il documento è pronto.",
        suggestedArguments: { filename: "<stesso file>", document_type: "<tipo>" },
        transitions: { findings: "compile_section_context", no_findings: null },
      },
    ],
  },
  {
    key: "document.review",
    area: "document",
    operation: "review",
    description: "Esegui la review strutturale di un deliverable esistente.",
    completion: "finding e piano di correzione restituiti.",
    guardrails: DOCUMENT_GUARDRAILS,
    steps: [{
      id: "review_existing_document",
      tool: "knowledge_review_document",
      instruction: "Controlla struttura, lingua, tono cliente, gap e sezioni deboli.",
      suggestedArguments: { filename: "<file deliverable>", document_type: "<tipo se noto>" },
    }],
  },
  {
    key: "document.export",
    area: "document",
    operation: "export",
    description: "Esporta in DOCX un markdown già revisionato.",
    completion: "DOCX prodotto con diagrammi Mermaid renderizzati.",
    guardrails: DOCUMENT_GUARDRAILS,
    steps: [{
      id: "export_reviewed_document",
      tool: "knowledge_export_docx",
      instruction: "Esporta soltanto dopo review soddisfacente.",
      suggestedArguments: {
        filename: "<nome senza estensione>",
        document_type: "<tipo documento>",
        client: "<cliente>",
        project: "<progetto>",
      },
    }],
  },
  {
    key: "admin.migrate",
    area: "admin",
    operation: "migrate",
    description: "Pianifica e applica una migrazione conservativa v1/v2/v3 -> v4.",
    completion: "migrazione applicata con backup e wiki_lint completato, oppure piano bloccato senza mutation.",
    guardrails: ADMIN_GUARDRAILS,
    steps: [
      {
        id: "plan_migration",
        tool: "wiki_migrate",
        action: "plan",
        instruction: "Produci un piano read-only; riferisci success solo se il piano è applicabile, blocked altrimenti.",
        suggestedArguments: { action: "plan", target_version: "4", dry_run: true, backup: true },
        transitions: { success: "apply_migration", blocked: null },
      },
      {
        id: "apply_migration",
        tool: "wiki_migrate",
        action: "apply",
        instruction: "Applica esattamente il piano verificato creando il backup.",
        suggestedArguments: { action: "apply", target_version: "4", dry_run: false, backup: true },
      },
      {
        id: "verify_admin_operation",
        tool: "wiki_lint",
        instruction: "Verifica integrità, frontmatter e link dopo la migrazione.",
      },
    ],
  },
  ...([
    ["initialize", "knowledge_init", undefined, { force: false }],
    ["create_page", "wiki_write_page", undefined, { path: "<path wiki>", content: "<markdown valido>" }],
    ["edit_page", "wiki_edit_page", undefined, { path: "<path wiki>", old_string: "<testo unico>", new_string: "<nuovo testo>" }],
    ["move_page", "wiki_move_page", undefined, { old_path: "<path attuale>", new_path: "<nuovo path>", dry_run: true }],
    ["delete_page", "wiki_delete_page", undefined, { path: "<path wiki>" }],
  ] as const).map(([operation, tool, action, suggestedArguments]): GuidedWorkflow => ({
    key: `admin.${operation}`,
    area: "admin",
    operation,
    description: `Operazione amministrativa ${operation}.`,
    completion: "operazione verificata con wiki_lint.",
    guardrails: ADMIN_GUARDRAILS,
    steps: [
      {
        id: `admin_${operation}`,
        tool,
        action,
        instruction: `Esegui ${operation} con gli argomenti più specifici possibili.`,
        suggestedArguments,
      },
      {
        id: "verify_admin_operation",
        tool: "wiki_lint" as const,
        instruction: "Verifica integrità, frontmatter e link dopo la mutation.",
      },
    ],
  })),
  {
    key: "admin.read_page",
    area: "admin",
    operation: "read_page",
    description: "Leggi direttamente una pagina quando il path è già noto.",
    completion: "pagina letta oppure assenza dichiarata.",
    guardrails: ADMIN_GUARDRAILS,
    steps: [{
      id: "admin_read_page",
      tool: "wiki_read_page",
      instruction: "Usa accesso diretto soltanto con un path wiki già noto.",
      suggestedArguments: { path: "<path wiki noto>" },
    }],
  },
  {
    key: "admin.lint",
    area: "admin",
    operation: "lint",
    description: "Esegui l'health check strutturale della wiki.",
    completion: "health check completato e finding restituiti.",
    guardrails: ADMIN_GUARDRAILS,
    steps: [{
      id: "admin_lint",
      tool: "wiki_lint",
      instruction: "Controlla frontmatter, pagine orfane, link mancanti o rotti e duplicati.",
      suggestedArguments: {},
    }],
  },
];

export const GUIDED_WORKFLOWS: Readonly<Record<string, GuidedWorkflow>> = Object.fromEntries(
  workflows.map((workflow) => [workflow.key, workflow])
);

export const MENU_OPERATIONS = Object.fromEntries(
  MENU_AREAS.map((area) => [
    area,
    workflows
      .filter((workflow) => workflow.area === area)
      .map((workflow) => ({
        id: workflow.operation,
        description: workflow.description,
        workflowKey: workflow.key,
      })),
  ])
) as unknown as Readonly<Record<MenuArea, readonly MenuOperation[]>>;

export function workflowFor(area: MenuArea, operation: string): GuidedWorkflow {
  const selected = MENU_OPERATIONS[area].find((candidate) => candidate.id === operation);
  if (!selected) {
    throw new Error(
      `Unknown operation "${operation}" for area ${area}. Expected one of: ` +
      MENU_OPERATIONS[area].map((candidate) => candidate.id).join(", ")
    );
  }
  const workflow = GUIDED_WORKFLOWS[selected.workflowKey];
  if (!workflow) throw new Error(`Missing workflow definition: ${selected.workflowKey}`);
  return workflow;
}

export function resolveWorkflowTransition(
  workflow: GuidedWorkflow,
  completedStepId: string | undefined,
  outcome: WorkflowOutcome | undefined
): WorkflowTransition {
  if (!completedStepId) {
    return { next: workflow.steps[0], allowedOutcomes: [], complete: workflow.steps.length === 0 };
  }

  const index = workflow.steps.findIndex((step) => step.id === completedStepId);
  if (index < 0) {
    throw new Error(
      `Unknown step "${completedStepId}" for workflow ${workflow.key}. Expected one of: ` +
      workflow.steps.map((step) => step.id).join(", ")
    );
  }
  const completed = workflow.steps[index]!;
  const allowedOutcomes = Object.keys(completed.transitions ?? {}) as WorkflowOutcome[];
  if (allowedOutcomes.length > 0) {
    if (!outcome) return { allowedOutcomes, complete: false };
    if (!allowedOutcomes.includes(outcome)) {
      throw new Error(
        `Outcome "${outcome}" is invalid after ${completed.id}. Expected: ${allowedOutcomes.join(", ")}.`
      );
    }
    const target = completed.transitions?.[outcome];
    if (target === null) return { allowedOutcomes, complete: true };
    const next = workflow.steps.find((step) => step.id === target);
    if (!next) throw new Error(`Workflow ${workflow.key} references missing step ${target}.`);
    return { next, allowedOutcomes, complete: false };
  }

  const targetId = completed.nextStepId;
  const next = targetId
    ? workflow.steps.find((step) => step.id === targetId)
    : workflow.steps[index + 1];
  if (targetId && !next) throw new Error(`Workflow ${workflow.key} references missing step ${targetId}.`);
  return { next, allowedOutcomes: [], complete: !next };
}

export interface WorkflowCoverageObservation {
  coverageSufficient?: boolean;
  evidenceGaps?: readonly string[];
}

export function validateWorkflowOutcomeObservation(
  workflow: GuidedWorkflow,
  completedStepId: string | undefined,
  outcome: WorkflowOutcome | undefined,
  observation: WorkflowCoverageObservation
): void {
  if (
    workflow.area !== "read" ||
    completedStepId !== "read_selected_resources" ||
    outcome === undefined
  ) return;

  const { coverageSufficient, evidenceGaps } = observation;
  if (coverageSufficient === undefined || evidenceGaps === undefined) {
    throw new Error(
      "Read coverage outcome requires coverage_sufficient and evidence_gaps copied from the latest knowledge_context response."
    );
  }
  if (outcome === "coverage_sufficient") {
    if (!coverageSufficient || evidenceGaps.length > 0) {
      throw new Error(
        "coverage_sufficient is invalid while knowledge_context reports insufficient coverage or evidence gaps; widen context or declare gaps."
      );
    }
    return;
  }
  if (outcome === "coverage_insufficient" || outcome === "gaps_declared") {
    if (coverageSufficient || evidenceGaps.length === 0) {
      throw new Error(
        `${outcome} requires coverage_sufficient=false and at least one evidence gap from knowledge_context.`
      );
    }
  }
}
