import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DOCUMENT_PERSONAS, DOCUMENT_TEMPLATES } from "../config/templates.js";
import {
  documentContract,
  isDocumentType,
} from "../config/document-contracts.js";
import { EDITORIAL_EVIDENCE_KINDS } from "../config/editorial-plans.js";
import {
  createSectionContext,
  buildDocumentPlan,
  DIAGRAM_MODES,
  formatReviewResult,
  formatSectionContext,
  isDiagramRelevantSection,
  parseTemplateSections,
  reviewDocumentStructure,
  type DiagramMode,
  type DocumentReviewResult,
  type ReviewFinding,
} from "../core/document-workflow.js";
import { atomicWriteText } from "../core/fs-service.js";
import {
  docsCategoryDirReal,
  docsCategoryFilePathReal,
  resolveRealWithin,
  wikiDir,
} from "../core/paths.js";
import { ensureDir, readFileSafe, stripFrontmatter } from "../core/utils.js";
import { errorResult } from "./helpers.js";
import { toolName, type ProtocolEra } from "../mcp/tool-names.js";

const DocumentTypeSchema = z.string().trim().min(1).max(128).regex(/^[^\r\n]+$/)
  .describe("Any document profile name. Built-in names are presets; arbitrary non-empty values are valid.");
const RequiredSectionsSchema = z.array(
  z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/)
).max(30).optional()
  .describe("Optional caller-defined H2 outline. When supplied it overrides the preset template.");
const DiagramModeSchema = z.enum(DIAGRAM_MODES).optional()
  .describe("Optional diagram preference: none (default), Mermaid source in Markdown, or a caller-owned relative SVG/PNG asset.");
const DocumentFilenameSchema = z.string().trim().min(4).max(255).regex(/^[^\r\n]+\.md$/i)
  .describe("Markdown filename ending in .md; deliverables are stored directly below docs/deliverables.");

async function deliverablePath(filename: string): Promise<{ abs: string; name: string }> {
  const name = nodePath.basename(filename.trim());
  if (!/^.+\.md$/i.test(name)) {
    throw new Error("Document filename must end in .md.");
  }
  const abs = await docsCategoryFilePathReal("deliverables", name);
  return { abs, name: nodePath.basename(abs) };
}

function explicitTemplate(
  documentType: string,
  projectName: string | undefined,
  requiredSections: readonly string[]
): string {
  const title = documentContract(documentType).label;
  return [
    "# " + title + ": " + (projectName ?? "{{PROJECT_NAME}}"),
    "",
    ...requiredSections.flatMap((section) => ["## " + section, "[Write evidence-backed content for this section.]", ""]),
  ].join("\n").trimEnd();
}

function templateFor(
  documentType: string,
  projectName?: string,
  requiredSections?: readonly string[]
): string | undefined {
  const today = new Date().toISOString().slice(0, 10);
  const raw = requiredSections && requiredSections.length > 0
    ? explicitTemplate(documentType, projectName, requiredSections)
    : DOCUMENT_TEMPLATES[documentType];
  return raw
    ?.replace(/\{\{PROJECT_NAME\}\}/g, projectName ?? "{{PROJECT_NAME}}")
    .replace(/\{\{DATE\}\}/g, today);
}

function reviewOptionsFor(
  documentType: string,
  overrides: {
    language?: string;
    clientFacing?: boolean;
    includeWikiUpdatePlan?: boolean;
    diagramMode?: DiagramMode;
  }
) {
  const contract = documentContract(documentType);
  return {
    documentType,
    language: overrides.language ?? contract.defaultLanguage,
    clientFacing: overrides.clientFacing ?? contract.defaultClientFacing,
    includeWikiUpdatePlan: overrides.includeWikiUpdatePlan ?? true,
    diagramMode: overrides.diagramMode,
  };
}

function markdownImageTargets(markdown: string): string[] {
  const targets: string[] = [];
  const imageRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = imageRe.exec(markdown)) !== null) {
    const raw = match[1].trim();
    const target = raw.startsWith("<")
      ? raw.slice(1, raw.indexOf(">"))
      : raw.split(/\s+(?=["'])/)[0];
    if (target) targets.push(target);
  }
  return [...new Set(targets)];
}

function assetFinding(code: string, message: string, evidence: string): ReviewFinding {
  return { severity: "BLOCKER", code, message, evidence };
}

async function validateReferencedAssets(markdown: string): Promise<ReviewFinding[]> {
  const findings: ReviewFinding[] = [];
  const assetsRoot = await docsCategoryDirReal("assets");
  for (const rawTarget of markdownImageTargets(markdown)) {
    if (/^(?:https?:|data:|file:|knowledge-rail:|#)/i.test(rawTarget)) {
      findings.push(assetFinding(
        "ASSET_NON_PORTABLE",
        "Image references must use workspace-confined relative paths.",
        rawTarget
      ));
      continue;
    }
    if (rawTarget.includes("\\")) {
      findings.push(assetFinding("ASSET_PATH_INVALID", "Image paths must use portable forward slashes.", rawTarget));
      continue;
    }

    let target: string;
    try {
      target = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
    } catch {
      findings.push(assetFinding("ASSET_PATH_INVALID", "The image path contains invalid URL encoding.", rawTarget));
      continue;
    }

    const extension = nodePath.extname(target).toLowerCase();
    if (![".svg", ".png"].includes(extension)) {
      findings.push(assetFinding(
        "ASSET_TYPE_UNSUPPORTED",
        "External diagram assets must be SVG or PNG.",
        rawTarget
      ));
      continue;
    }

    if (!target.startsWith("../assets/")) {
      findings.push(assetFinding(
        "ASSET_PATH_INVALID",
        "Deliverable images must use a relative ../assets/name.svg or ../assets/name.png path.",
        rawTarget
      ));
      continue;
    }

    let abs: string;
    try {
      abs = await resolveRealWithin(assetsRoot, target.slice("../assets/".length));
    } catch (error: unknown) {
      findings.push(assetFinding(
        "ASSET_PATH_ESCAPE",
        "The image path resolves outside docs/assets.",
        error instanceof Error ? error.message : rawTarget
      ));
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(abs);
    } catch {
      findings.push(assetFinding("ASSET_MISSING", "A referenced local image does not exist.", rawTarget));
      continue;
    }
    if (bytes.byteLength > 5 * 1024 * 1024) {
      findings.push(assetFinding("ASSET_TOO_LARGE", "A referenced image exceeds the 5 MB review limit.", rawTarget));
      continue;
    }

    if (extension === ".png") {
      const signature = bytes.subarray(0, 8).toString("hex");
      if (signature !== "89504e470d0a1a0a") {
        findings.push(assetFinding("ASSET_SIGNATURE_INVALID", "The referenced PNG has an invalid signature.", rawTarget));
      }
      continue;
    }

    const svg = bytes.toString("utf8");
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(svg)) {
      findings.push(assetFinding("ASSET_SIGNATURE_INVALID", "The referenced SVG does not start with an SVG element.", rawTarget));
      continue;
    }
    const activeSvg = /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<(?:iframe|object|embed)\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|javascript:|\/\/)|@import|url\s*\(/i;
    if (activeSvg.test(svg)) {
      findings.push(assetFinding(
        "SVG_ACTIVE_CONTENT",
        "The referenced SVG contains active or externally loaded content.",
        rawTarget
      ));
    }
  }
  return findings;
}

function mergeReviewFindings(
  review: DocumentReviewResult,
  additional: readonly ReviewFinding[]
): DocumentReviewResult {
  if (additional.length === 0) return review;
  const findings = review.findings
    .filter((finding) => finding.code !== "NESSUN_BLOCCANTE")
    .concat(additional);
  const blockerCount = findings.filter((finding) => finding.severity === "BLOCKER").length;
  return {
    ...review,
    readyForDelivery: blockerCount === 0,
    blockerCount,
    findings,
  };
}

function contentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function registerDocumentTools(server: McpServer, era: ProtocolEra = "modern"): void {
  server.registerTool(toolName("documentPlan", era), {
    title: "Plan an evidence-backed Markdown document",
    description: "Plan any document profile using a built-in preset or caller-defined H2 outline.",
    inputSchema: z.object({
      document_type: DocumentTypeSchema,
      project_name: z.string().optional(),
      objective: z.string().optional(),
      audience: z.string().optional(),
      language: z.string().optional().describe("Output language; defaults to the user's current request language."),
      max_sections: z.number().int().positive().optional(),
      required_sections: RequiredSectionsSchema,
      diagram_mode: DiagramModeSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({
    document_type,
    project_name,
    objective,
    audience,
    language,
    max_sections,
    required_sections,
    diagram_mode,
  }) => {
    const contract = documentContract(document_type);
    const template = templateFor(document_type, project_name, required_sections);
    const sections = template ? parseTemplateSections(template, max_sections) : [];
    const opportunities = sections
      .filter((section) => isDiagramRelevantSection(section.title))
      .map((section) => section.title);
    const plan = await buildDocumentPlan(wikiDir(), {
      documentType: document_type,
      projectName: project_name,
      objective,
      audience,
      language,
      maxSections: max_sections,
      template,
    });
    const diagramChoice = {
      required: false,
      default: "none" as const,
      options: [...DIAGRAM_MODES],
      optionDetails: [
        { mode: "none", requiresExistingAsset: false, requiresFilesystemAccess: false },
        { mode: "mermaid", requiresExistingAsset: false, requiresFilesystemAccess: false },
        {
          mode: "external_asset",
          requiresExistingAsset: true,
          requiresFilesystemAccess: true,
          supportedMediaTypes: ["image/svg+xml", "image/png"],
        },
      ],
      opportunities,
      selected: diagram_mode ?? null,
      effective: diagram_mode ?? "none",
    };
    return {
      content: [{
        type: "text" as const,
        text: plan + "\n\n## Diagram choice\n\n" +
          (opportunities.length > 0
            ? "A diagram may help in: " + opportunities.join(", ") + ". Ask the user only if useful; the default is none."
            : "No section currently creates a strong diagram opportunity; the default is none.") +
          "\nSelected mode: " + (diagram_mode ?? "none") + "." +
          "\nexternal_asset requires an existing local SVG/PNG and filesystem access; chat-only clients should offer none or mermaid.",
      }],
      structuredContent: {
        documentType: document_type,
        documentProfile: {
          requestedType: document_type,
          builtInPreset: isDocumentType(document_type),
          label: contract.label,
          callerDefinedStructure: Boolean(required_sections?.length),
        },
        contract,
        editorPersona: DOCUMENT_PERSONAS[document_type] ?? DOCUMENT_PERSONAS.custom,
        requiredSections: sections.map((section) => section.title),
        diagramChoice,
      },
    };
  });

  server.registerTool(toolName("sectionContext", era), {
    description: "Internal bounded section-context operation with explicit gaps and optional diagram evidence.",
    inputSchema: z.object({
      section_title: z.string(),
      query: z.string().optional(),
      document_type: DocumentTypeSchema,
      language: z.string().optional(),
      diagram_mode: DiagramModeSchema,
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
    }),
  }, async ({
    section_title,
    query,
    document_type,
    language,
    diagram_mode,
    required_evidence,
    preferred_evidence,
    page_paths,
    page_types,
    max_pages,
    max_chars_per_page,
    max_total_chars,
    max_output_chars,
    heuristic_token_budget,
    retrieval_profile,
  }) => {
    const result = await createSectionContext({
      wikiRoot: wikiDir(),
      sectionTitle: section_title,
      query,
      documentType: document_type,
      writerLanguage: language,
      diagramMode: diagram_mode,
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
    return {
      content: [{ type: "text" as const, text: formatSectionContext(result, section_title, max_output_chars) }],
      structuredContent: {
        documentType: result.documentType,
        diagramRelevant: result.diagramRelevant,
        diagramMode: result.diagramMode,
        diagramEvidencePack: result.diagramEvidencePack,
        coverage: result.coverage,
        compiler: result.compiler,
        omittedPaths: result.omittedPaths ?? [],
      },
    };
  });

  server.registerTool(toolName("writeDocument", era), {
    description: "Save a Markdown draft and return contract findings; drafts remain writable while blockers exist.",
    inputSchema: z.object({
      filename: DocumentFilenameSchema,
      title: z.string(),
      document_type: DocumentTypeSchema,
      content: z.string(),
      project_name: z.string().optional(),
      language: z.string().optional(),
      client_facing: z.boolean().optional(),
      required_sections: RequiredSectionsSchema,
      diagram_mode: DiagramModeSchema,
      overwrite: z.boolean().optional().default(false),
    }),
  }, async ({
    filename,
    title,
    document_type,
    content,
    project_name,
    language,
    client_facing,
    required_sections,
    diagram_mode,
    overwrite,
  }) => {
    const { abs, name } = await deliverablePath(filename);
    await ensureDir(nodePath.dirname(abs));
    if (!overwrite && (await readFileSafe(abs)) !== null) {
      return errorResult("Document already exists: docs/deliverables/" + name + "\nSet overwrite=true to replace it.");
    }

    const reviewOptions = reviewOptionsFor(document_type, {
      language,
      clientFacing: client_facing,
      includeWikiUpdatePlan: false,
      diagramMode: diagram_mode,
    });
    let review = reviewDocumentStructure(
      stripFrontmatter(content),
      templateFor(document_type, project_name, required_sections),
      reviewOptions
    );
    review = mergeReviewFindings(review, await validateReferencedAssets(content));
    await atomicWriteText(abs, content);
    const sizeKB = (Buffer.byteLength(content, "utf-8") / 1024).toFixed(1);
    return {
      content: [{ type: "text" as const, text: [
        "Document saved: docs/deliverables/" + name,
        "Title: " + title + " [" + document_type + "]",
        "Size: " + sizeKB + " KB",
        "Contract state: " + (review.readyForDelivery
          ? "review-ready"
          : "draft with " + review.blockerCount + " blocker(s)"),
        "Next step: knowledge_document action=review.",
        "Path: docs/deliverables/" + name,
      ].join("\n") }],
      structuredContent: {
        path: "docs/deliverables/" + name,
        documentType: document_type,
        readyForDelivery: review.readyForDelivery,
        blockerCount: review.blockerCount,
        findings: review.findings,
      },
    };
  });

  server.registerTool(toolName("reviewDocument", era), {
    description: "Review a Markdown deliverable against its structure, content, language, audience, diagrams and local assets.",
    inputSchema: z.object({
      filename: DocumentFilenameSchema,
      document_type: DocumentTypeSchema,
      project_name: z.string().optional(),
      language: z.string().optional(),
      client_facing: z.boolean().optional(),
      required_sections: RequiredSectionsSchema,
      diagram_mode: DiagramModeSchema,
      include_wiki_update_plan: z.boolean().optional().default(true),
    }),
  }, async ({
    filename,
    document_type,
    project_name,
    language,
    client_facing,
    required_sections,
    diagram_mode,
    include_wiki_update_plan,
  }) => {
    const { abs, name } = await deliverablePath(filename);
    const content = await readFileSafe(abs);
    if (content === null) return errorResult("Document not found: docs/deliverables/" + name);

    const reviewOptions = reviewOptionsFor(document_type, {
      language,
      clientFacing: client_facing,
      includeWikiUpdatePlan: include_wiki_update_plan,
      diagramMode: diagram_mode,
    });
    let review = reviewDocumentStructure(
      stripFrontmatter(content),
      templateFor(document_type, project_name, required_sections),
      reviewOptions
    );
    review = mergeReviewFindings(review, await validateReferencedAssets(content));
    const reviewedContentSha256 = contentSha256(content);
    return {
      content: [{
        type: "text" as const,
        text: formatReviewResult(review, name, reviewOptions) +
          "\n\n> Content SHA-256 (exact inspected Markdown): " + reviewedContentSha256,
      }],
      structuredContent: {
        documentType: document_type,
        readyForDelivery: review.readyForDelivery,
        contentSha256: reviewedContentSha256,
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
