import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DOCUMENT_TEMPLATES } from "../config/templates.js";
import {
  documentContract,
  DOCUMENT_TYPES,
  type DocumentType,
} from "../config/document-contracts.js";
import { EDITORIAL_EVIDENCE_KINDS } from "../config/editorial-plans.js";
import {
  createSectionContext,
  buildDocumentPlan,
  formatReviewResult,
  formatSectionContext,
  reviewDocumentStructure,
} from "../core/document-workflow.js";
import { atomicWriteBuffer, atomicWriteText } from "../core/fs-service.js";
import { docsCategoryFilePathReal, wikiDir } from "../core/paths.js";
import { ensureDir, readFileSafe, stripFrontmatter } from "../core/utils.js";
import { exportDocxFromMarkdownWithStats } from "../docx/index.js";
import { errorResult, textResult } from "./helpers.js";
import { toolName, type ProtocolEra } from "../mcp/tool-names.js";

async function deliverablePath(filename: string): Promise<{ abs: string; name: string }> {
  const abs = await docsCategoryFilePathReal("deliverables", nodePath.basename(filename));
  return { abs, name: nodePath.basename(abs) };
}

function templateFor(documentType: DocumentType, projectName?: string): string | undefined {
  const today = new Date().toISOString().slice(0, 10);
  return DOCUMENT_TEMPLATES[documentType]
    ?.replace(/\{\{PROJECT_NAME\}\}/g, projectName ?? "{{PROJECT_NAME}}")
    .replace(/\{\{DATE\}\}/g, today);
}

function reviewOptionsFor(
  documentType: DocumentType,
  overrides: { language?: string; clientFacing?: boolean; includeWikiUpdatePlan?: boolean }
) {
  const contract = documentContract(documentType);
  return {
    documentType,
    language: overrides.language ?? contract.defaultLanguage,
    clientFacing: overrides.clientFacing ?? contract.defaultClientFacing,
    includeWikiUpdatePlan: overrides.includeWikiUpdatePlan ?? true,
  };
}

export function registerDocumentTools(server: McpServer, era: ProtocolEra = "modern"): void {
  server.registerTool(toolName("documentPlan", era), {
    title: "Plan an evidence-backed document",
    description: "Plan a typed document: contract, template, sections and evidence.",
    inputSchema: z.object({
      document_type: z.enum(DOCUMENT_TYPES),
      project_name: z.string().optional(),
      objective: z.string().optional(),
      audience: z.string().optional(),
      language: z.string().optional().describe("Output language; defaults to the user's current request language."),
      max_sections: z.number().int().positive().optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ document_type, project_name, objective, audience, language, max_sections }) => {
    const contract = documentContract(document_type);
    const plan = await buildDocumentPlan(wikiDir(), {
      documentType: document_type,
      projectName: project_name,
      objective,
      audience,
      language,
      maxSections: max_sections,
    });
    return {
      content: [{ type: "text" as const, text: plan }],
      structuredContent: {
        documentType: document_type,
        contract,
        requiredSections: templateFor(document_type, project_name)
          ?.match(/^##\s+.+$/gm)
          ?.map((heading) => heading.replace(/^##\s+/, "")) ?? [],
      },
    };
  });

  server.registerTool(toolName("sectionContext", era), { description: "Internal bounded section-context operation with explicit gaps.", inputSchema: z.object({
              section_title: z.string(),
              query: z.string().optional(),
              document_type: z.enum(DOCUMENT_TYPES),
              language: z.string().optional(),
              required_evidence: z.array(z.enum(EDITORIAL_EVIDENCE_KINDS)).optional(),
              preferred_evidence: z.array(z.enum(EDITORIAL_EVIDENCE_KINDS)).optional(),
              page_paths: z.array(z.string()).optional(),
              page_types: z.array(z.string()).optional(),
              max_pages: z.number().int().positive().optional().default(8),
              max_chars_per_page: z.number().int().positive().optional().default(6000),
              max_total_chars: z.number().int().positive().optional().default(30000),
              max_output_chars: z.number().int().positive().optional(),
              heuristic_token_budget: z.number().int().min(256).max(12000).optional(),
              retrieval_profile: z.enum(["precision", "balanced", "coverage"]).optional().default("coverage"),
            }) }, async ({ section_title, query, document_type, language, required_evidence, preferred_evidence, page_paths, page_types, max_pages, max_chars_per_page, max_total_chars, max_output_chars, heuristic_token_budget, retrieval_profile }) => {
              const result = await createSectionContext({
                wikiRoot: wikiDir(),
                sectionTitle: section_title,
                query,
                documentType: document_type,
                writerLanguage: language,
                evidencePlan: required_evidence || preferred_evidence
                  ? { require: required_evidence, prefer: preferred_evidence }
                  : undefined,
                pagePaths: page_paths,
                pageTypes: page_types,
                maxPages: max_pages,
                maxCharsPerPage: max_chars_per_page,
                maxTotalChars: max_total_chars,
                maxOutputChars: max_output_chars,
                heuristicTokenBudget: heuristic_token_budget,
                retrievalProfile: retrieval_profile,
                useGraph: true,
              });
              return textResult(formatSectionContext(result, section_title, max_output_chars));
            });

  server.registerTool(toolName("writeDocument", era), { description: "Save a draft and return contract blockers; blockers prevent export, not draft storage.", inputSchema: z.object({
              filename: z.string(),
              title: z.string(),
              document_type: z.enum(DOCUMENT_TYPES),
              content: z.string(),
              project_name: z.string().optional(),
              language: z.string().optional(),
              client_facing: z.boolean().optional(),
              overwrite: z.boolean().optional().default(false),
            }) }, async ({ filename, title, document_type, content, project_name, language, client_facing, overwrite }) => {
              const { abs, name } = await deliverablePath(filename);
              await ensureDir(nodePath.dirname(abs));

              if (!overwrite && (await readFileSafe(abs)) !== null) {
                return errorResult(
                  `Document already exists: docs/deliverables/${name}\nSet overwrite=true to replace it.`
                );
              }

              const reviewOptions = reviewOptionsFor(document_type, {
                language,
                clientFacing: client_facing,
                includeWikiUpdatePlan: false,
              });
              const review = reviewDocumentStructure(
                stripFrontmatter(content),
                templateFor(document_type, project_name),
                reviewOptions
              );
              await atomicWriteText(abs, content);
              const sizeKB = (Buffer.byteLength(content, "utf-8") / 1024).toFixed(1);
              return {
                content: [{ type: "text" as const, text: [
                  `Document saved: docs/deliverables/${name}`,
                  `Title: ${title} [${document_type}]`,
                  `Size: ${sizeKB} KB`,
                  `Contract state: ${review.readyForExport ? "review-ready" : `draft with ${review.blockerCount} blocker(s)`}`,
                  "Next step: knowledge_document action=review.",
                  `Path: docs/deliverables/${name}`,
                ].join("\n") }],
                structuredContent: {
                  path: `docs/deliverables/${name}`,
                  documentType: document_type,
                  readyForExport: review.readyForExport,
                  blockerCount: review.blockerCount,
                  findings: review.findings,
                },
              };
            });

  server.registerTool(toolName("exportDocx", era), { description: "Export reviewed Markdown to DOCX; rejects current content with contract blockers.", inputSchema: z.object({
              filename: z.string(),
              document_type: z.enum(DOCUMENT_TYPES),
              client: z.string(),
              project: z.string(),
              language: z.string().optional(),
              client_facing: z.boolean().optional(),
              category_label: z.string().optional(),
              subtitle: z.string().optional().default(""),
              version: z.string().optional().default("1.0"),
              date: z.string().optional().describe("Default: today (ISO)"),
              status: z.string().optional().default("Reviewed"),
              overwrite: z.boolean().optional().default(false),
            }) }, async ({ filename, document_type, client, project, language, client_facing, category_label, subtitle, version, date, status, overwrite }) => {
              const baseName = nodePath.basename(filename.replace(/\.(md|docx)$/i, ""));
              const mdPath = await docsCategoryFilePathReal("deliverables", `${baseName}.md`);
              const docxPath = await docsCategoryFilePathReal("deliverables", `${baseName}.docx`);

              const markdown = await readFileSafe(mdPath);
              if (markdown === null) {
                return errorResult(
                  `Source document not found: docs/deliverables/${baseName}.md\nCreate it first with knowledge_document action=write.`
                );
              }
              const reviewOptions = reviewOptionsFor(document_type, {
                language,
                clientFacing: client_facing,
                includeWikiUpdatePlan: false,
              });
              const review = reviewDocumentStructure(
                stripFrontmatter(markdown),
                templateFor(document_type, project),
                reviewOptions
              );
              if (!review.readyForExport) {
                const blockerCodes = review.findings
                  .filter((finding) => finding.severity === "BLOCKER")
                  .map((finding) => finding.code);
                return errorResult(
                  `Export blocked by the ${document_type} contract: ${blockerCodes.join(", ")}. ` +
                  "Fix the document and run knowledge_document action=review again."
                );
              }
              if (!overwrite) {
                try {
                  await fs.access(docxPath);
                  return errorResult(
                    `DOCX file already exists: docs/deliverables/${baseName}.docx\nSet overwrite=true to replace it.`
                  );
                } catch {
                  // The file does not exist; continue.
                }
              }

              const body = stripFrontmatter(markdown);
              const docTitle = body.match(/^# (.+)$/m)?.[1]?.trim() ?? baseName;
              const today = new Date().toISOString().slice(0, 10);
              const { buffer, stats } = await exportDocxFromMarkdownWithStats({
                markdownBody: body,
                coverParams: {
                  categoryLabel: category_label ?? documentContract(document_type).categoryLabel,
                  title: docTitle,
                  subtitle: subtitle ?? "",
                  version: version ?? "1.0",
                  date: date ?? today,
                  status: status ?? "Draft",
                },
                client,
                project,
              });

              await ensureDir(nodePath.dirname(docxPath));
              await atomicWriteBuffer(docxPath, buffer);
              return textResult(
                [
                  `DOCX exported: docs/deliverables/${baseName}.docx`,
                  `Source: docs/deliverables/${baseName}.md`,
                  `Contract: ${document_type} (${review.contractChecksPassed}/${review.contractCheckCount} checks)`,
                  `Client: ${client} | Project: ${project}`,
                  `Version: ${version ?? "1.0"} | Date: ${date ?? today} | Status: ${status ?? "Draft"}`,
                  `Mermaid diagrams rendered: ${stats.mermaidDiagramsRendered}`,
                  `Legacy ASCII diagrams detected: ${stats.legacyAsciiDiagrams}`,
                  `Size: ${(buffer.byteLength / 1024).toFixed(1)} KB`,
                ].join("\n")
              );
            });

  server.registerTool(toolName("reviewDocument", era), { description: "Review a deliverable against its structure, content, language, audience and diagram contract.", inputSchema: z.object({
              filename: z.string(),
              document_type: z.enum(DOCUMENT_TYPES),
              project_name: z.string().optional(),
              language: z.string().optional(),
              client_facing: z.boolean().optional(),
              include_wiki_update_plan: z.boolean().optional().default(true),
            }) }, async ({ filename, document_type, project_name, language, client_facing, include_wiki_update_plan }) => {
              const { abs, name } = await deliverablePath(filename);
              const content = await readFileSafe(abs);
              if (content === null) {
                return errorResult(`Document not found: docs/deliverables/${name}`);
              }

              const reviewOptions = reviewOptionsFor(document_type, {
                language,
                clientFacing: client_facing,
                includeWikiUpdatePlan: include_wiki_update_plan,
              });
              const review = reviewDocumentStructure(
                stripFrontmatter(content),
                templateFor(document_type, project_name),
                reviewOptions
              );
              return {
                content: [{ type: "text" as const, text: formatReviewResult(review, name, reviewOptions) }],
                structuredContent: {
                  documentType: document_type,
                  readyForExport: review.readyForExport,
                  blockerCount: review.blockerCount,
                  contractCheckCount: review.contractCheckCount,
                  contractChecksPassed: review.contractChecksPassed,
                  findings: review.findings,
                  missingSections: review.missingSections,
                  weakSections: review.weakSections,
                },
              };
            });

}
