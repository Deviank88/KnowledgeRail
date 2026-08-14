import JSZip from "jszip";
import {
  FILE_CATEGORIES,
  type FileCategory,
  WIKI_PAGE_DIRECTORY_BY_TYPE,
} from "../config/workspace-layout.js";
import { stripFrontmatter } from "./utils.js";

export { FILE_CATEGORIES, type FileCategory } from "../config/workspace-layout.js";

export const DEV_REPORT_SECTIONS = [
  "Contesto richiesta",
  "Modifiche funzionali",
  "Data model",
  "Automazioni",
  "Integrazioni/API",
  "UI/UX",
  "Permessi/Sicurezza",
  "Test",
  "Changelog",
  "Impatto documentale",
  "Gap/Ambiguità",
] as const;

export interface DevReportPlanOptions {
  client: string;
  project: string;
  requestId: string;
  objective: string;
  relatedFiles?: string[];
}

export interface ReportFinding {
  severity: "BLOCKER" | "WARNING" | "INFO";
  code: string;
  message: string;
  section?: string;
}

export interface ReportValidationResult {
  valid: boolean;
  findings: ReportFinding[];
  sections: Record<string, string>;
}

export interface RequestIngestionDraft {
  path: string;
  content: string;
}

const PAGE_TYPE_DIRS: Readonly<Record<string, string>> = WIKI_PAGE_DIRECTORY_BY_TYPE;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function slug(input: string): string {
  const value = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return value || "item";
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function extractReportSections(markdown: string): Record<string, string> {
  const body = stripFrontmatter(markdown);
  const headings: Array<{ title: string; index: number; end: number }> = [];
  const re = /^##\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    headings.push({
      title: match[1].trim(),
      index: match.index,
      end: re.lastIndex,
    });
  }

  const sections: Record<string, string> = {};
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]!;
    const next = headings[i + 1];
    sections[current.title] = body.slice(current.end, next ? next.index : body.length).trim();
  }
  return sections;
}

function hasMeaningfulContent(content: string): boolean {
  const normalized = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/N\/A|n\.d\.|da compilare|tbd|todo/gi, "")
    .trim();
  return normalized.length >= 12;
}

function declaresNoImpact(content: string): boolean {
  return /\b(nessun[aoe]?|non applicabile|n\/a|non sono stat[ei]|nessuna modifica|nessun impatto)\b/i.test(content);
}

function metadataValue(markdown: string, label: string): string | undefined {
  const re = new RegExp(`^>\\s*\\*\\*${label}:\\*\\*\\s*(.+)$`, "mi");
  return markdown.match(re)?.[1]?.trim();
}

export function buildDevReportPlan(options: DevReportPlanOptions): string {
  const date = today();
  const suggestedFile = `docs/reports/${slug(options.requestId)}_${date}.md`;
  const related = options.relatedFiles && options.relatedFiles.length > 0
    ? options.relatedFiles.map((file) => `- ${file}`).join("\n")
    : "- Nessun file collegato dichiarato.";

  const template = [
    `# Development Report - ${options.requestId}`,
    "",
    `> **Cliente:** ${options.client}`,
    `> **Progetto:** ${options.project}`,
    `> **Request ID:** ${options.requestId}`,
    `> **Data:** ${date}`,
    `> **Stato:** Validato per ingestione wiki`,
    "",
    "## Contesto richiesta",
    `Obiettivo: ${options.objective}`,
    "",
    "File o fonti collegate:",
    related,
    "",
    "## Modifiche funzionali",
    "Descrivere cosa cambia per utenti, processi, regole operative e comportamento atteso. Se non ci sono modifiche funzionali, scrivere esplicitamente `Nessuna modifica funzionale`.",
    "",
    "## Data model",
    "Elencare oggetti, campi, relazioni, vincoli, mapping, migrazioni o modifiche ai dati. Se non impattato, scrivere `Nessuna modifica al data model`.",
    "",
    "## Automazioni",
    "Elencare trigger, job, workflow, schedulazioni, condizioni, side effect e rollback. Se non impattate, scrivere `Nessuna modifica alle automazioni`.",
    "",
    "## Integrazioni/API",
    "Descrivere endpoint, payload, sistemi coinvolti, autenticazione, errori e frequenza. Se non impattate, scrivere `Nessuna modifica a integrazioni o API`.",
    "",
    "## UI/UX",
    "Descrivere schermate, azioni utente, validazioni, messaggi, stati vuoti o errori. Se non impattata, scrivere `Nessuna modifica UI/UX`.",
    "",
    "## Permessi/Sicurezza",
    "Descrivere ruoli, policy, visibilità dati, permessi, audit e impatti sicurezza. Se non impattati, scrivere `Nessuna modifica a permessi o sicurezza`.",
    "",
    "## Test",
    "Indicare ambiente, casi testati, esito, evidenze e regressioni note. Un report validato deve contenere test eseguiti o una motivazione esplicita approvata.",
    "",
    "## Changelog",
    "Elencare changelog aggiornati o note di rilascio prodotte. Se non applicabile, scrivere `Nessun changelog richiesto` e motivare.",
    "",
    "## Impatto documentale",
    "Indicare quali deliverable vanno aggiornati: manuale utente, documento funzionale, documento tecnico, onboarding, API reference. Se nessuno, scrivere `Nessun impatto documentale` e motivare.",
    "",
    "## Gap/Ambiguità",
    "Elencare dubbi, assunzioni, punti da confermare o scrivere `Nessun gap noto`.",
  ].join("\n");

  return [
    "# Piano development report",
    "",
    `File suggerito: \`${suggestedFile}\``,
    "",
    "## Istruzioni operative",
    "- Scrivi il development report in `docs/reports/` usando esattamente il template sotto.",
    "- Aggiorna eventuali changelog in `docs/changelogs/`.",
    "- Poi chiama `knowledge_ingest action=report` sul file prodotto: valida il report e genera le bozze wiki.",
    "- Se la validazione segnala BLOCKER, integra il report e richiama lo stesso tool.",
    "- Applica le bozze generate con `knowledge_page action=write`.",
    "",
    "```markdown",
    template,
    "```",
  ].join("\n");
}

export function validateDevReport(markdown: string): ReportValidationResult {
  const sections = extractReportSections(markdown);
  const findings: ReportFinding[] = [];

  for (const section of DEV_REPORT_SECTIONS) {
    if (!(section in sections)) {
      findings.push({
        severity: "BLOCKER",
        code: "SECTION_MISSING",
        section,
        message: `Sezione obbligatoria mancante: ${section}.`,
      });
      continue;
    }
    if (!hasMeaningfulContent(sections[section])) {
      findings.push({
        severity: "BLOCKER",
        code: "SECTION_EMPTY",
        section,
        message: `La sezione '${section}' non contiene contenuto operativo sufficiente.`,
      });
    }
  }

  const testContent = sections["Test"] ?? "";
  if (!/(test|verificat|validat|collaud|uat|regression|esito|pass|fail|ok)/i.test(testContent)) {
    findings.push({
      severity: "BLOCKER",
      code: "TEST_EVIDENCE_MISSING",
      section: "Test",
      message: "La sezione Test deve indicare casi eseguiti, ambiente ed esito oppure una motivazione approvata.",
    });
  }

  for (const section of ["Data model", "Automazioni", "Integrazioni/API", "UI/UX", "Permessi/Sicurezza"] as const) {
    const content = sections[section] ?? "";
    if (content && !declaresNoImpact(content) && content.length < 40) {
      findings.push({
        severity: "WARNING",
        code: "SECTION_WEAK",
        section,
        message: `La sezione '${section}' dichiara impatti ma sembra troppo sintetica.`,
      });
    }
  }

  const valid = findings.every((finding) => finding.severity !== "BLOCKER");
  if (valid) {
    findings.push({
      severity: "INFO",
      code: "REPORT_VALID",
      message: "Report valido per preparare l'ingestione wiki.",
    });
  }

  return { valid, findings, sections };
}

function frontmatter(params: {
  title: string;
  type: string;
  tags: string[];
  sources: string[];
  client?: string;
  project?: string;
  requestId?: string;
  status?: string;
  authority?: string;
}): string {
  const date = today();
  const extra = [
    params.client ? `client: "${escapeYaml(params.client)}"` : "",
    params.project ? `project: "${escapeYaml(params.project)}"` : "",
    params.requestId ? `request_id: "${escapeYaml(params.requestId)}"` : "",
    params.status ? `status: ${params.status}` : "",
    params.authority ? `authority: ${params.authority}` : "",
  ].filter(Boolean);

  return [
    "---",
    `title: "${escapeYaml(params.title)}"`,
    `type: ${params.type}`,
    `tags: [${params.tags.map((tag) => tag.toLowerCase()).join(", ")}]`,
    `created: ${date}`,
    `updated: ${date}`,
    `sources: [${params.sources.map((source) => `"${escapeYaml(source)}"`).join(", ")}]`,
    ...extra,
    "---",
    "",
  ].join("\n");
}

function draftPath(type: string, requestId: string, title: string): string {
  const dir = PAGE_TYPE_DIRS[type] ?? "analysis";
  return `${dir}/${slug(requestId)}_${slug(title)}.md`;
}

function sectionOrNone(sections: Record<string, string>, name: string): string {
  return sections[name]?.trim() || "Non indicato nel report validato.";
}

export function prepareRequestIngestionDrafts(
  markdown: string,
  reportSourcePath: string
): { valid: boolean; validation: ReportValidationResult; drafts: RequestIngestionDraft[] } {
  const validation = validateDevReport(markdown);
  if (!validation.valid) return { valid: false, validation, drafts: [] };

  const client = metadataValue(markdown, "Cliente") ?? "";
  const project = metadataValue(markdown, "Progetto") ?? "";
  const requestId = metadataValue(markdown, "Request ID") ?? slug(metadataValue(markdown, "Data") ?? "request");
  const sources = [reportSourcePath.startsWith("docs/") ? reportSourcePath : `docs/${reportSourcePath}`];
  const common = { client, project, requestId, sources };
  const sections = validation.sections;

  const drafts: RequestIngestionDraft[] = [];
  const requestTitle = `Richiesta ${requestId}`;
  drafts.push({
    path: draftPath("request", requestId, "richiesta"),
    content:
      frontmatter({
        title: requestTitle,
        type: "request",
        tags: ["request", "validated"],
        status: "validated",
        authority: "validated_report",
        ...common,
      }) +
      [
        `# ${requestTitle}`,
        "",
        "## Contesto",
        sectionOrNone(sections, "Contesto richiesta"),
        "",
        "## Modifiche funzionali",
        sectionOrNone(sections, "Modifiche funzionali"),
        "",
        "## Gap e ambiguità",
        sectionOrNone(sections, "Gap/Ambiguità"),
      ].join("\n"),
  });

  const sectionToType: Array<[string, string, string, string[]]> = [
    ["Modifiche funzionali", "requirement", "Requisiti", ["requirement", "functional"]],
    ["Data model", "data_model", "Data model", ["data-model"]],
    ["Automazioni", "automation", "Automazioni", ["automation"]],
    ["Integrazioni/API", "integration", "Integrazioni API", ["integration", "api"]],
    ["Test", "test_result", "Esiti test", ["test", "validation"]],
    ["Changelog", "release", "Changelog e rilascio", ["release", "changelog"]],
  ];

  for (const [sectionName, type, titleSuffix, tags] of sectionToType) {
    const content = sectionOrNone(sections, sectionName);
    if (declaresNoImpact(content) && !["test_result", "release"].includes(type)) continue;
    const title = `${titleSuffix} - ${requestId}`;
    drafts.push({
      path: draftPath(type, requestId, titleSuffix),
      content:
        frontmatter({
          title,
          type,
          tags,
          status: type === "test_result" ? "tested" : "validated",
          authority: "validated_report",
          ...common,
        }) +
        [`# ${title}`, "", content].join("\n"),
    });
  }

  const implementationTitle = `Implementazione - ${requestId}`;
  drafts.push({
    path: draftPath("implementation", requestId, "implementazione"),
    content:
      frontmatter({
        title: implementationTitle,
        type: "implementation",
        tags: ["implementation", "validated"],
        status: "implemented",
        authority: "validated_report",
        ...common,
      }) +
      [
        `# ${implementationTitle}`,
        "",
        "## Sintesi implementativa",
        sectionOrNone(sections, "Modifiche funzionali"),
        "",
        "## Data model",
        sectionOrNone(sections, "Data model"),
        "",
        "## Automazioni",
        sectionOrNone(sections, "Automazioni"),
        "",
        "## Integrazioni/API",
        sectionOrNone(sections, "Integrazioni/API"),
        "",
        "## UI/UX",
        sectionOrNone(sections, "UI/UX"),
        "",
        "## Permessi/Sicurezza",
        sectionOrNone(sections, "Permessi/Sicurezza"),
      ].join("\n"),
  });

  return { valid: true, validation, drafts };
}

export function prepareSourceIngestionDraft(params: {
  sourceKind: "client_source" | "meeting_note" | "candidate_request" | "summary";
  title: string;
  sourcePath: string;
  content: string;
  sourceSegmentId?: string;
  client?: string;
  project?: string;
}): RequestIngestionDraft {
  const type = params.sourceKind;
  const segmentSuffix = params.sourceSegmentId
    ? `_${slug(params.sourceSegmentId)}`
    : "";
  const path = `${PAGE_TYPE_DIRS[type] ?? "summaries"}/${slug(params.title)}${segmentSuffix}.md`;
  const title = params.title.trim();
  const sources = [params.sourcePath.startsWith("docs/") ? params.sourcePath : `docs/${params.sourcePath}`];
  const status = type === "candidate_request" ? "candidate" : "context";
  const authority = type === "client_source" ? "client_input" : "context";

  return {
    path,
    content:
      frontmatter({
        title,
        type,
        tags: [type.replace("_", "-")],
        sources,
        client: params.client,
        project: params.project,
        status,
        authority,
      }) +
      [
        `# ${title}`,
        "",
        ...(params.sourceSegmentId
          ? ["> Segmento fonte: `" + params.sourceSegmentId + "`", ""]
          : []),
        "## Sintesi",
        params.content.trim(),
        "",
        "## Stato",
        type === "candidate_request"
          ? "Richiesta candidata: richiede conferma tramite report validato prima di diventare richiesta progettuale."
          : "Fonte di contesto tracciata: non prevale su report e test validati.",
      ].join("\n"),
  };
}

function xmlText(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function extractXlsxMarkdown(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const sharedRaw = await zip.file("xl/sharedStrings.xml")?.async("text");
  const shared = sharedRaw
    ? [...sharedRaw.matchAll(/<si[\s\S]*?<\/si>/g)].map((match) => xmlText(match[0]))
    : [];
  const sheets = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();
  const lines: string[] = ["# Excel normalizzato", ""];

  for (const [index, sheetPath] of sheets.entries()) {
    const raw = await zip.file(sheetPath)?.async("text");
    if (!raw) continue;
    lines.push(`## Sheet ${index + 1}`, "");
    const rows = [...raw.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 500);
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<c[^>]*(?:t="([^"]+)")?[^>]*>([\s\S]*?)<\/c>/g)].map((cell) => {
        const type = cell[1];
        const value = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? cell[2].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
        if (type === "s") return shared[Number(value)] ?? value;
        return xmlText(value);
      });
      if (cells.some(Boolean)) lines.push(`- ${cells.join(" | ")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

export async function extractPptxMarkdown(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] ?? 0) - Number(b.match(/slide(\d+)/)?.[1] ?? 0));
  const lines: string[] = ["# PowerPoint normalizzato", ""];

  for (const slidePath of slides) {
    const slideNo = slidePath.match(/slide(\d+)/)?.[1] ?? "?";
    const raw = await zip.file(slidePath)?.async("text");
    if (!raw) continue;
    const texts = [...raw.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => xmlText(match[1]))
      .filter(Boolean);
    lines.push(`## Slide ${slideNo}`, "");
    if (texts.length === 0) {
      lines.push("_Nessun testo estratto._", "");
    } else {
      lines.push(...texts.map((text) => `- ${text}`), "");
    }
  }

  return lines.join("\n").trim() + "\n";
}

export function formatReportValidation(result: ReportValidationResult, filename: string): string {
  const lines = [
    `# Validazione development report: ${filename}`,
    "",
    `> Stato: ${result.valid ? "VALIDO" : "BLOCCATO"}`,
    "",
  ];
  for (const finding of result.findings) {
    lines.push(`- **${finding.severity} ${finding.code}:** ${finding.message}${finding.section ? ` (${finding.section})` : ""}`);
  }
  if (!result.valid) {
    lines.push("");
    lines.push("## Checklist integrazione");
    lines.push("- Compilare tutte le sezioni obbligatorie del template MCP.");
    lines.push("- Dichiarare esplicitamente `Nessuna modifica` nelle aree non impattate.");
    lines.push("- Aggiungere ambiente, casi ed esito nella sezione Test.");
    lines.push("- Richiamare di nuovo `knowledge_ingest action=report` dopo le integrazioni.");
  }
  return lines.join("\n");
}
