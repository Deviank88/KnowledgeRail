import type { McpServer, ResourceLink } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PersistentCodeEvidenceIndex } from "../core/code-evidence/index.js";
import { readCodeResource } from "../core/code-evidence/resource-reader.js";
import {
  readCodeGrepFallbackEvents,
  recordCodeGrepFallback,
} from "../core/code-evidence/telemetry.js";
import type { CodeEvidenceHit, CodeReference } from "../core/code-evidence/types.js";
import { recordKnowledgeRecoveryUsage } from "../core/knowledge-recovery.js";
import { getWikiRoot, wikiDir } from "../core/paths.js";
import { errorResult } from "./helpers.js";
import { toolName } from "../mcp/tool-names.js";

const ActionSchema = z.enum([
  "rebuild",
  "update",
  "remove",
  "search",
  "symbol",
  "references",
  "read",
  "status",
  "record_fallback",
]);

function linkForHit(hit: CodeEvidenceHit): ResourceLink {
  return {
    type: "resource_link",
    uri: hit.resourceUri,
    name: `${hit.fragment.qualifiedName} (${hit.fragment.path}:${hit.fragment.range.startLine})`,
    description: `${hit.fragment.kind}; score ${hit.score.toFixed(2)}; ${hit.fragment.definition}`,
    mimeType: "text/plain",
  };
}

function linkForReference(reference: CodeReference): ResourceLink {
  return {
    type: "resource_link",
    uri: reference.resourceUri,
    name: `${reference.source.qualifiedName} (${reference.source.path}:${reference.source.range.startLine})`,
    description: `${reference.relation} of ${reference.target.qualifiedName}`,
    mimeType: "text/plain",
  };
}

function hitText(hit: CodeEvidenceHit): string {
  return [
    `${hit.fragment.kind} ${hit.fragment.qualifiedName}`,
    `${hit.fragment.path}:${hit.fragment.range.startLine}-${hit.fragment.range.endLine}`,
    `score=${hit.score.toFixed(2)}`,
    hit.fragment.definition,
    `resource=${hit.resourceUri}`,
    hit.fragment.calls.length > 0 ? `calls=${hit.fragment.calls.join(", ")}` : "",
    hit.fragment.routes.length > 0
      ? `routes=${hit.fragment.routes.map((route) => `${route.method} ${route.path} -> ${route.handler ?? "inline"}`).join(", ")}`
      : "",
  ].filter(Boolean).join(" | ");
}

export function registerCodeEvidenceTools(
  server: McpServer,
  era: "legacy" | "modern" = "modern"
): void {
  const modern = era === "modern";
  server.registerTool(
    toolName("codeEvidence", era),
    {
      title: "Index and retrieve code evidence",
      description: "Internal deterministic code-evidence operation.",
      inputSchema: z.object({
        action: ActionSchema,
        path: z.string().min(1).optional(),
        query: z.string().min(1).max(4_096).optional(),
        symbol: z.string().min(1).max(512).optional(),
        symbol_id: z.string().min(1).max(256).optional(),
        resource_uri: z.string().startsWith("code://repo/").optional(),
        path_prefixes: z.array(z.string().min(1)).max(20).optional(),
        kinds: z.array(z.enum(["module", "class", "function", "method", "route", "test", "comment"])).max(7).optional(),
        max_results: z.number().int().min(1).max(100).default(12),
        max_chars: z.number().int().min(1).max(50_000).default(6_000),
        fallback_reason: z.string().min(1).max(1_024).optional(),
        fallback_result_count: z.number().int().nonnegative().optional(),
        recovered_evidence: z.array(z.object({
          evidence_ref: z.string().min(1).max(4_096),
          source_uri: z.string().min(1).max(4_096),
          expected_wiki_pages: z.array(z.string().min(1)).max(50).optional(),
          reason: z.string().min(1).max(1_024).optional(),
        })).max(100).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({
      action,
      path,
      query,
      symbol,
      symbol_id,
      resource_uri,
      path_prefixes,
      kinds,
      max_results,
      max_chars,
      fallback_reason,
      fallback_result_count,
      recovered_evidence,
    }) => {
      try {
        const repositoryRoot = getWikiRoot();
        const wikiRoot = wikiDir();
        const index = new PersistentCodeEvidenceIndex({ repositoryRoot, wikiRoot });
        const options = { maxResults: max_results ?? 12, paths: path_prefixes, kinds };

        if (action === "rebuild") {
          const update = await index.rebuild();
          return {
            content: [{ type: "text" as const, text:
              `Code evidence rebuilt: ${update.fragmentCount} fragments from ${update.scannedFiles} files; ` +
              `${update.reparsedFiles} reparsed, ${update.reusedFiles} reused, ${update.removedFiles} removed.` }],
            structuredContent: { action, update },
          };
        }
        if (action === "update") {
          if (!path) throw new Error("action=update requires path.");
          const update = await index.updateFile(path);
          return {
            content: [{ type: "text" as const, text:
              `Code evidence updated for ${path}: ${update.reparsedFiles} reparsed, ${update.reusedFiles} reused.` }],
            structuredContent: { action, path, update },
          };
        }
        if (action === "remove") {
          if (!path) throw new Error("action=remove requires path.");
          const update = await index.removeFile(path);
          return {
            content: [{ type: "text" as const, text: `Removed ${update.removedFiles} indexed file record(s) for ${path}.` }],
            structuredContent: { action, path, update },
          };
        }
        if (action === "search" || action === "symbol") {
          if (action === "search" && !query) throw new Error("action=search requires query.");
          if (action === "symbol" && !symbol) throw new Error("action=symbol requires symbol.");
          const hits = action === "search"
            ? await index.search(query!, options)
            : await index.symbol(symbol!, options);
          const summary = hits.length === 0
            ? "No indexed code evidence matched. A coverage controller may authorize a diagnostic fallback; record it if used."
            : hits.map(hitText).join("\n");
          return {
            content: modern
              ? [{ type: "text" as const, text: summary }, ...hits.map(linkForHit)]
              : [{ type: "text" as const, text: summary }],
            structuredContent: {
              action,
              hits: hits.map((hit) => ({
                score: hit.score,
                matchedTerms: hit.matchedTerms,
                resourceUri: hit.resourceUri,
                fragment: hit.fragment,
              })),
            },
          };
        }
        if (action === "references") {
          if (!symbol_id) throw new Error("action=references requires symbol_id.");
          const references = await index.references(symbol_id, options);
          const summary = references.length === 0
            ? "No indexed incoming references matched."
            : references.map((reference) =>
                `${reference.relation} | ${reference.source.qualifiedName} | ` +
                `${reference.source.path}:${reference.source.range.startLine} | resource=${reference.resourceUri}`
              ).join("\n");
          return {
            content: modern
              ? [{ type: "text" as const, text: summary }, ...references.map(linkForReference)]
              : [{ type: "text" as const, text: summary }],
            structuredContent: { action, symbolId: symbol_id, references },
          };
        }
        if (action === "read") {
          if (!resource_uri) throw new Error("action=read requires resource_uri.");
          const read = await readCodeResource({
            repositoryRoot,
            wikiRoot,
            resourceUri: resource_uri,
            maxCharacters: max_chars ?? 6_000,
          });
          const truncation = read.truncated
            ? `\n\n[Truncated: ${[...read.text].length}/${read.totalCharacters} characters returned]`
            : "";
          return {
            content: [{ type: "text" as const, text:
              `${read.path}:${read.startLine}-${read.endLine} — ${read.qualifiedName}\n\n${read.text}${truncation}` }],
            structuredContent: { action, read: { ...read, text: undefined } },
          };
        }
        if (action === "record_fallback") {
          if (!query || !fallback_reason || fallback_result_count === undefined) {
            throw new Error("action=record_fallback requires query, fallback_reason, and fallback_result_count.");
          }
          const event = await recordCodeGrepFallback({
            wikiRoot,
            query,
            reason: fallback_reason,
            resultCount: fallback_result_count,
          });
          const recovery = recovered_evidence?.length
            ? await recordKnowledgeRecoveryUsage({
              wikiRoot,
              totalEvidenceUsed: recovered_evidence.length,
              events: recovered_evidence.map((evidence) => ({
                evidenceRef: evidence.evidence_ref,
                sourceUri: evidence.source_uri,
                discoveredBy: "grep_fallback",
                expectedWikiPages: evidence.expected_wiki_pages,
                reason: evidence.reason ?? fallback_reason,
              })),
            })
            : undefined;
          return {
            content: [{ type: "text" as const, text:
              `Recorded grep fallback at ${event.timestamp}.` +
              (recovery
                ? ` Knowledge debt: ${recovery.events.length} event(s), ${recovery.metrics.knowledgeRecoveryPending} pending.`
                : " No recovered evidence was declared as used.") }],
            structuredContent: { action, event, recovery },
          };
        }

        const [snapshot, fallbackEvents] = await Promise.all([
          index.snapshot(),
          readCodeGrepFallbackEvents(wikiRoot),
        ]);
        const status = {
          version: snapshot.version,
          parserVersion: snapshot.parserVersion,
          generatedAt: snapshot.generatedAt,
          indexedFiles: snapshot.files.length,
          indexedFragments: snapshot.fragments.length,
          recordedGrepFallbacks: fallbackEvents.length,
        };
        return {
          content: [{ type: "text" as const, text:
            `Code evidence status: ${status.indexedFiles} files, ${status.indexedFragments} fragments, ` +
            `${status.recordedGrepFallbacks} recorded grep fallback(s).` }],
          structuredContent: { action, status },
        };
      } catch (error: unknown) {
        return errorResult(error);
      }
    }
  );
}
