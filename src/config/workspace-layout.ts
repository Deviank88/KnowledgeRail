export const DOC_SOURCE_CATEGORIES = [
  "client",
  "transcripts",
  "reports",
  "changelogs",
  "normalized",
] as const;

export const DOC_OUTPUT_CATEGORIES = ["deliverables", "assets"] as const;

/** Controlled user-facing categories accepted by knowledge_files. */
export const FILE_CATEGORIES = [
  ...DOC_SOURCE_CATEGORIES,
  ...DOC_OUTPUT_CATEGORIES,
] as const;

/** Durable machine state under docs/. It is not a user source category. */
export const DOC_OPERATIONAL_DIRECTORIES = ["evidence-ir"] as const;

/** Single source of truth for typed canonical-memory paths. */
export const WIKI_PAGE_DIRECTORY_BY_TYPE = {
  entity: "entities",
  concept: "concepts",
  summary: "summaries",
  comparison: "comparisons",
  overview: "overviews",
  analysis: "analysis",
  meeting_note: "meeting-notes",
  client_source: "client-sources",
  candidate_request: "candidate-requests",
  request: "requests",
  requirement: "requirements",
  implementation: "implementations",
  test_result: "tests",
  decision: "decisions",
  release: "releases",
  risk: "risks",
  data_model: "data-model",
  automation: "automations",
  integration: "integrations",
  api: "api",
} as const;

/** Wiki page directories are created lazily when the first page is written. */
export const WIKI_PAGE_DIRECTORIES = [
  ...new Set(Object.values(WIKI_PAGE_DIRECTORY_BY_TYPE)),
] as const;

export type FileCategory = (typeof FILE_CATEGORIES)[number];
