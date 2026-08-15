import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { readWikiResource } from "../context/resource-reader.js";
import { readCodeResource } from "../core/code-evidence/resource-reader.js";
import { getWikiRoot } from "../core/paths.js";
import { logFile, schemaFile, wikiDir } from "../core/paths.js";
import { readFileSafe } from "../core/utils.js";

const DEFAULT_RESOURCE_MAX_CHARS = 6_000;

export function registerWikiResources(
  server: McpServer,
  options: { includeWorkspaceBinding?: boolean } = {}
): void {
  const schemaReader = async () => ({
    contents: [{ uri: "wiki://schema", text: await readFileSafe(schemaFile()) ?? "SCHEMA.md non trovato." }],
  });
  const logReader = async () => ({
    contents: [{ uri: "wiki://log", text: await readFileSafe(logFile()) ?? "log.md non trovato." }],
  });
  if (options.includeWorkspaceBinding) {
    server.registerResource(
      "wiki-schema",
      new ResourceTemplate("wiki://schema{?workspace_binding}", { list: undefined }),
      { title: "Wiki schema", description: "Convenzioni e workflow della wiki", mimeType: "text/markdown" },
      schemaReader
    );
    server.registerResource(
      "wiki-log",
      new ResourceTemplate("wiki://log{?workspace_binding}", { list: undefined }),
      { title: "Wiki log", description: "Registro operativo della wiki", mimeType: "text/markdown" },
      logReader
    );
  } else {
    server.registerResource(
      "wiki-schema",
      "wiki://schema",
      { title: "Wiki schema", description: "Convenzioni e workflow della wiki", mimeType: "text/markdown" },
      schemaReader
    );
    server.registerResource(
      "wiki-log",
      "wiki://log",
      { title: "Wiki log", description: "Registro operativo della wiki", mimeType: "text/markdown" },
      logReader
    );
  }
  server.registerResource(
    "wiki-evidence",
    new ResourceTemplate(
      options.includeWorkspaceBinding
        ? "knowledge-rail://page/{+path}{?passage,workspace_binding}"
        : "knowledge-rail://page/{+path}{?passage}",
      { list: undefined }
    ),
    {
      title: "Wiki evidence",
      description: "Read one wiki page or content-addressed passage referenced by task context.",
      mimeType: "text/markdown",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    async (uri) => {
      const read = await readWikiResource({
        wikiRoot: wikiDir(),
        resourceUri: uri.href,
        maxCharacters: DEFAULT_RESOURCE_MAX_CHARS,
      });
      const returnedCharacters = [...read.text].length;
      const label = read.heading ? `${read.title} — ${read.heading}` : read.title;
      const truncation = read.truncated
        ? `\n\n[Truncated: ${returnedCharacters}/${read.totalCharacters} characters returned]`
        : "";
      return {
        contents: [{
          uri: read.uri,
          mimeType: "text/markdown",
          text: `# ${label}\n\n${read.text}${truncation}`,
        }],
      };
    }
  );
  server.registerResource(
    "code-evidence",
    new ResourceTemplate(
      options.includeWorkspaceBinding
        ? "code://repo/{+path}{?workspace_binding}#{symbol}"
        : "code://repo/{+path}#{symbol}",
      { list: undefined }
    ),
    {
      title: "Code evidence",
      description: "Read only the indexed symbol body or targeted line range referenced by code evidence.",
      mimeType: "text/plain",
      cacheHint: { ttlMs: 0, cacheScope: "private" },
    },
    async (uri) => {
      const read = await readCodeResource({
        repositoryRoot: getWikiRoot(),
        wikiRoot: wikiDir(),
        resourceUri: uri.href,
        maxCharacters: DEFAULT_RESOURCE_MAX_CHARS,
      });
      const returnedCharacters = [...read.text].length;
      const truncation = read.truncated
        ? `\n\n[Truncated: ${returnedCharacters}/${read.totalCharacters} characters returned]`
        : "";
      return {
        contents: [{
          uri: read.uri,
          mimeType: "text/plain",
          text: `${read.path}:${read.startLine}-${read.endLine} — ${read.qualifiedName}\n\n${read.text}${truncation}`,
        }],
      };
    }
  );
}
