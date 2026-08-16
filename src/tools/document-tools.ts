import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { documentPersona, documentTemplate } from "../config/templates.js";
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
  type DocumentAssetResolver,
  type DiagramMode,
} from "../core/document-workflow.js";
import { atomicWriteText } from "../core/fs-service.js";
import {
  docsCategoryDirReal,
  docsCategoryFilePathReal,
  resolveRealWithin,
  wikiDir,
} from "../core/paths.js";
import { ensureDir, readFileSafe } from "../core/utils.js";
import { errorResult } from "./helpers.js";
import { toolName, type ProtocolEra } from "../mcp/tool-names.js";

const DocumentTypeSchema = z.string().trim().min(1).max(128).regex(/^[^\r\n]+$/)
  .describe("Any document profile name. Built-in names are presets; arbitrary non-empty values are valid.");
const RequiredSectionsSchema = z.array(
  z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/)
).max(30).optional()
  .describe("Optional caller-defined H2 outline. When supplied it overrides the preset template.");
const DiagramModeSchema = z.enum(DIAGRAM_MODES).optional()
  .describe("Optional diagram preference: none, Mermaid source in Markdown, or a caller-owned relative SVG/PNG asset; omission leaves representation unenforced.");
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
    : documentTemplate(documentType);
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
    assetResolver: createDocumentAssetResolver(),
  };
}

function createDocumentAssetResolver(): DocumentAssetResolver {
  let assetsRoot: Promise<string> | undefined;
  return async ({ relativePath, readLimit }) => {
    assetsRoot ??= docsCategoryDirReal("assets");
    let abs: string;
    try {
      abs = await resolveRealWithin(await assetsRoot, relativePath);
    } catch (error: unknown) {
      return { status: "escape", detail: error instanceof Error ? error.message : String(error) };
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "missing" }
        : { status: "invalid", detail: error instanceof Error ? error.message : String(error) };
    }
    if (!stat.isFile()) return { status: "invalid", detail: "Asset target is not a regular file." };
    if (readLimit <= 0 || stat.size > 5 * 1024 * 1024) {
      return { status: "resolved", byteLength: stat.size };
    }

    const handle = await fs.open(abs, "r");
    try {
      const bytes = Buffer.alloc(Math.min(readLimit, stat.size));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return { status: "resolved", byteLength: stat.size, bytes: bytes.subarray(0, bytesRead) };
    } finally {
      await handle.close();
    }
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
      default: null,
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
      effective: diagram_mode ?? null,
    };
    return {
      content: [{
        type: "text" as const,
        text: plan + "\n\n## Diagram choice\n\n" +
          (opportunities.length > 0
            ? "A diagram may help in: " + opportunities.join(", ") + ". Ask the user only if useful; omitting diagram_mode applies no enforcement."
            : "No section currently creates a strong diagram opportunity; the EN/IT heading heuristic is advisory only and omitting diagram_mode applies no enforcement.") +
          "\nSelected mode: " + (diagram_mode ?? "not selected") + ". Propagate an explicit choice to section, write, and review calls to enforce it." +
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
        editorPersona: documentPersona(document_type),
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
    const review = await reviewDocumentStructure(
      content,
      templateFor(document_type, project_name, required_sections),
      reviewOptions
    );
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
        effectiveDiagramMode: review.effectiveDiagramMode,
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
    const review = await reviewDocumentStructure(
      content,
      templateFor(document_type, project_name, required_sections),
      reviewOptions
    );
    const reviewedContentSha256 = contentSha256(content);
    return {
      content: [{
        type: "text" as const,
        text: formatReviewResult(review, name, reviewOptions) +
          "\n\n> Content SHA-256 (exact inspected Markdown): " + reviewedContentSha256,
      }],
      structuredContent: {
        documentType: document_type,
        effectiveDiagramMode: review.effectiveDiagramMode,
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
