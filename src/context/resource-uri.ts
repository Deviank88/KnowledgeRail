import { isWikiPassageId } from "./passage-id.js";

const SCHEME = "knowledge-rail:";
const PAGE_HOST = "page";

export interface WikiResourceRef {
  path: string;
  passageId?: string;
}

function normalizeRelativeWikiPath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))
  ) {
    throw new Error(`Invalid wiki resource path: ${input}`);
  }
  return segments.join("/");
}

function encodePath(path: string): string {
  return normalizeRelativeWikiPath(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function wikiPageUri(path: string): string {
  return `${SCHEME}//${PAGE_HOST}/${encodePath(path)}`;
}

export function wikiPassageUri(path: string, passageId: string): string {
  if (!isWikiPassageId(passageId)) {
    throw new Error(`Invalid passage id: ${passageId}`);
  }
  const url = new URL(wikiPageUri(path));
  url.searchParams.set("passage", passageId);
  return url.toString();
}

export function parseWikiResourceUri(uri: string): WikiResourceRef {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`Invalid KnowledgeRail resource URI: ${uri}`);
  }

  if (url.protocol !== SCHEME || url.hostname !== PAGE_HOST) {
    throw new Error(`Unsupported KnowledgeRail resource URI: ${uri}`);
  }
  if (url.hash) throw new Error("Wiki resource URIs must not contain fragments.");

  const rawSegments = url.pathname.replace(/^\/+/, "").split("/");
  let decoded: string[];
  try {
    decoded = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error(`Invalid percent encoding in wiki resource URI: ${uri}`);
  }
  if (decoded.some((segment) => segment.includes("/") || segment.includes("\\"))) {
    throw new Error("Encoded path separators are not allowed in wiki resource URIs.");
  }
  const path = normalizeRelativeWikiPath(decoded.join("/"));
  const passageId = url.searchParams.get("passage") ?? undefined;

  for (const key of url.searchParams.keys()) {
    if (key !== "passage" && key !== "workspace_binding") {
      throw new Error(`Unsupported wiki resource URI parameter: ${key}`);
    }
  }
  if (passageId !== undefined && !isWikiPassageId(passageId)) {
    throw new Error(`Invalid passage id in wiki resource URI: ${passageId}`);
  }

  return passageId === undefined ? { path } : { path, passageId };
}
