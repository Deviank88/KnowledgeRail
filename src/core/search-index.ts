import { clearRetrievalIndexes, searchRetrievalIndex } from "./retrieval-index.js";

export interface SearchResult {
  path: string;
  score: number;
  title: string;
  excerpt: string;
}

export async function searchWikiIndex(params: {
  wikiRoot: string;
  query: string;
  maxResults?: number;
  caseSensitive?: boolean;
}): Promise<SearchResult[]> {
  if (!params.query.trim()) return [];
  const hits = await searchRetrievalIndex({
    wikiRoot: params.wikiRoot,
    query: params.query,
    maxResults: params.maxResults,
    forceRefresh: true,
  });
  return hits.map((hit) => ({ path: hit.path, score: hit.score, title: hit.title, excerpt: hit.excerpt }));
}

export function clearSearchIndexes(): void {
  clearRetrievalIndexes();
}
