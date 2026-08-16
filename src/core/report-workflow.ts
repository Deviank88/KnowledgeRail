import JSZip from "jszip";
import {
  FILE_CATEGORIES,
  type FileCategory,
  WIKI_PAGE_DIRECTORY_BY_TYPE,
} from "../config/workspace-layout.js";
import { stripFrontmatter } from "./utils.js";

export { FILE_CATEGORIES, type FileCategory } from "../config/workspace-layout.js";

export const DEV_REPORT_SECTIONS = [
  "Request context",
  "Functional changes",
  "Data model",
  "Automations",
  "Integrations/API",
  "UI/UX",
  "Permissions/Security",
  "Tests",
  "Changelog",
  "Documentation impact",
  "Gaps/Ambiguities",
] as const;

const REPORT_SECTION_ALIASES: Readonly<Record<string, (typeof DEV_REPORT_SECTIONS)[number]>> = {
  "Contesto richiesta": "Request context",
  "Modifiche funzionali": "Functional changes",
  "Data model": "Data model",
  Automazioni: "Automations",
  "Integrazioni/API": "Integrations/API",
  "UI/UX": "UI/UX",
  "Permessi/Sicurezza": "Permissions/Security",
  Test: "Tests",
  Changelog: "Changelog",
  "Impatto documentale": "Documentation impact",
  "Gap/Ambiguità": "Gaps/Ambiguities",
};

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
    const canonicalTitle = REPORT_SECTION_ALIASES[current.title] ?? current.title;
    sections[canonicalTitle] = body.slice(current.end, next ? next.index : body.length).trim();
  }
  return sections;
}

function hasMeaningfulContent(content: string): boolean {
  const normalized = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/N\/A|n\.d\.|da compilare|to be completed|tbd|todo/gi, "")
    .trim();
  return normalized.length >= 12;
}

function declaresNoImpact(content: string): boolean {
  return /\b(nessun[aoe]?|non applicabile|n\/a|non sono stat[ei]|nessuna modifica|nessun impatto|none|not applicable|no changes?|no impact)\b/i.test(content);
}

function metadataValue(markdown: string, label: string, legacyLabel?: string): string | undefined {
  const alternatives = [label, legacyLabel].filter(Boolean).join("|");
  const re = new RegExp(`^>\\s*\\*\\*(?:${alternatives}):\\*\\*\\s*(.+)$`, "mi");
  return markdown.match(re)?.[1]?.trim();
}

export function buildDevReportPlan(options: DevReportPlanOptions): string {
  const date = today();
  const suggestedFile = `docs/reports/${slug(options.requestId)}_${date}.md`;
  const related = options.relatedFiles && options.relatedFiles.length > 0
    ? options.relatedFiles.map((file) => `- ${file}`).join("\n")
    : "- No related files declared.";

  const template = [
    `# Development Report - ${options.requestId}`,
    "",
    `> **Client:** ${options.client}`,
    `> **Project:** ${options.project}`,
    `> **Request ID:** ${options.requestId}`,
    `> **Date:** ${date}`,
    `> **Status:** Validated for wiki ingestion`,
    "",
    "## Request context",
    `Objective: ${options.objective}`,
    "",
    "Related files or sources:",
    related,
    "",
    "## Functional changes",
    "Describe changes for users, processes, operating rules, and expected behavior. If there are no functional changes, state `No functional changes` explicitly.",
    "",
    "## Data model",
    "List objects, fields, relationships, constraints, mappings, migrations, or data changes. If unaffected, state `No data-model changes`.",
    "",
    "## Automations",
    "List triggers, jobs, workflows, schedules, conditions, side effects, and rollback. If unaffected, state `No automation changes`.",
    "",
    "## Integrations/API",
    "Describe endpoints, payloads, involved systems, authentication, errors, and frequency. If unaffected, state `No integration or API changes`.",
    "",
    "## UI/UX",
    "Describe screens, user actions, validation, messages, empty states, or errors. If unaffected, state `No UI/UX changes`.",
    "",
    "## Permissions/Security",
    "Describe roles, policies, data visibility, permissions, auditing, and security impact. If unaffected, state `No permission or security changes`.",
    "",
    "## Tests",
    "State the environment, tested cases, outcome, evidence, and known regressions. A validated report must include executed tests or an explicitly approved justification.",
    "",
    "## Changelog",
    "List updated changelogs or produced release notes. If not applicable, state `No changelog required` and explain why.",
    "",
    "## Documentation impact",
    "Identify deliverables to update: user manual, functional document, technical document, onboarding, or API reference. If none, state `No documentation impact` and explain why.",
    "",
    "## Gaps/Ambiguities",
    "List doubts, assumptions, and points to confirm, or state `No known gaps`.",
  ].join("\n");

  return [
    "# Development-report plan",
    "",
    `Suggested file: \`${suggestedFile}\``,
    "",
    "## Operating instructions",
    "- Write the development report in `docs/reports/` using the exact template below.",
    "- Update any changelogs in `docs/changelogs/`.",
    "- Then call `knowledge_ingest action=report` on the produced file to validate it and generate wiki drafts.",
    "- If validation reports a BLOCKER, complete the report and call the same tool again.",
    "- Apply generated drafts with `knowledge_page action=write`.",
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
        message: `Required section missing: ${section}.`,
      });
      continue;
    }
    if (!hasMeaningfulContent(sections[section])) {
      findings.push({
        severity: "BLOCKER",
        code: "SECTION_EMPTY",
        section,
        message: `Section '${section}' does not contain enough operational content.`,
      });
    }
  }

  const testContent = sections["Tests"] ?? "";
  if (!/(test|verificat|validat|collaud|uat|regression|esito|pass|fail|ok)/i.test(testContent)) {
    findings.push({
      severity: "BLOCKER",
      code: "TEST_EVIDENCE_MISSING",
      section: "Tests",
      message: "The Tests section must state executed cases, environment, and outcome, or provide an approved justification.",
    });
  }

  for (const section of ["Data model", "Automations", "Integrations/API", "UI/UX", "Permissions/Security"] as const) {
    const content = sections[section] ?? "";
    if (content && !declaresNoImpact(content) && content.length < 40) {
      findings.push({
        severity: "WARNING",
        code: "SECTION_WEAK",
        section,
        message: `Section '${section}' declares impact but appears too brief.`,
      });
    }
  }

  const valid = findings.every((finding) => finding.severity !== "BLOCKER");
  if (valid) {
    findings.push({
      severity: "INFO",
      code: "REPORT_VALID",
      message: "The report is valid for preparing wiki ingestion.",
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
  return sections[name]?.trim() || "Not stated in the validated report.";
}

export function prepareRequestIngestionDrafts(
  markdown: string,
  reportSourcePath: string
): { valid: boolean; validation: ReportValidationResult; drafts: RequestIngestionDraft[] } {
  const validation = validateDevReport(markdown);
  if (!validation.valid) return { valid: false, validation, drafts: [] };

  const client = metadataValue(markdown, "Client", "Cliente") ?? "";
  const project = metadataValue(markdown, "Project", "Progetto") ?? "";
  const requestId = metadataValue(markdown, "Request ID") ?? slug(metadataValue(markdown, "Date", "Data") ?? "request");
  const sources = [reportSourcePath.startsWith("docs/") ? reportSourcePath : `docs/${reportSourcePath}`];
  const common = { client, project, requestId, sources };
  const sections = validation.sections;

  const drafts: RequestIngestionDraft[] = [];
  const requestTitle = `Request ${requestId}`;
  drafts.push({
    path: draftPath("request", requestId, "request"),
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
        "## Context",
        sectionOrNone(sections, "Request context"),
        "",
        "## Functional changes",
        sectionOrNone(sections, "Functional changes"),
        "",
        "## Gaps and ambiguities",
        sectionOrNone(sections, "Gaps/Ambiguities"),
      ].join("\n"),
  });

  const sectionToType: Array<[string, string, string, string[]]> = [
    ["Functional changes", "requirement", "Requirements", ["requirement", "functional"]],
    ["Data model", "data_model", "Data model", ["data-model"]],
    ["Automations", "automation", "Automations", ["automation"]],
    ["Integrations/API", "integration", "API integrations", ["integration", "api"]],
    ["Tests", "test_result", "Test results", ["test", "validation"]],
    ["Changelog", "release", "Changelog and release", ["release", "changelog"]],
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

  const implementationTitle = `Implementation - ${requestId}`;
  drafts.push({
    path: draftPath("implementation", requestId, "implementation"),
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
        "## Implementation summary",
        sectionOrNone(sections, "Functional changes"),
        "",
        "## Data model",
        sectionOrNone(sections, "Data model"),
        "",
        "## Automations",
        sectionOrNone(sections, "Automations"),
        "",
        "## Integrations/API",
        sectionOrNone(sections, "Integrations/API"),
        "",
        "## UI/UX",
        sectionOrNone(sections, "UI/UX"),
        "",
        "## Permissions/Security",
        sectionOrNone(sections, "Permissions/Security"),
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
          ? ["> Source segment: `" + params.sourceSegmentId + "`", ""]
          : []),
        "## Summary",
        params.content.trim(),
        "",
        "## Status",
        type === "candidate_request"
          ? "Candidate request: requires confirmation through a validated report before becoming a project request."
          : "Tracked context source: does not override validated reports and tests.",
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
  const lines: string[] = ["# Normalized Excel", ""];

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
  const lines: string[] = ["# Normalized PowerPoint", ""];

  for (const slidePath of slides) {
    const slideNo = slidePath.match(/slide(\d+)/)?.[1] ?? "?";
    const raw = await zip.file(slidePath)?.async("text");
    if (!raw) continue;
    const texts = [...raw.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => xmlText(match[1]))
      .filter(Boolean);
    lines.push(`## Slide ${slideNo}`, "");
    if (texts.length === 0) {
      lines.push("_No text extracted._", "");
    } else {
      lines.push(...texts.map((text) => `- ${text}`), "");
    }
  }

  return lines.join("\n").trim() + "\n";
}

export function formatReportValidation(result: ReportValidationResult, filename: string): string {
  const lines = [
    `# Development-report validation: ${filename}`,
    "",
    `> Status: ${result.valid ? "VALID" : "BLOCKED"}`,
    "",
  ];
  for (const finding of result.findings) {
    lines.push(`- **${finding.severity} ${finding.code}:** ${finding.message}${finding.section ? ` (${finding.section})` : ""}`);
  }
  if (!result.valid) {
    lines.push("");
    lines.push("## Completion checklist");
    lines.push("- Complete every required section in the MCP template.");
    lines.push("- State `No changes` explicitly in unaffected areas.");
    lines.push("- Add environment, cases, and outcome to the Tests section.");
    lines.push("- Call `knowledge_ingest action=report` again after completing the report.");
  }
  return lines.join("\n");
}
