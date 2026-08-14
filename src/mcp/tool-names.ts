export type ProtocolEra = "legacy" | "modern";

export const TOOL_NAMES = {
  menu: { modern: "knowledge_menu", legacy: "wiki_menu" },
  context: { modern: "knowledge_context", legacy: "wiki_context" },
  files: { modern: "knowledge_files", legacy: "wiki_files" },
  normalizeSource: { modern: "knowledge_normalize_source", legacy: "wiki_normalize_source" },
  prepareRequestIngestion: {
    modern: "knowledge_prepare_request_ingestion",
    legacy: "wiki_prepare_request_ingestion",
  },
  prepareSourceIngestion: {
    modern: "knowledge_prepare_source_ingestion",
    legacy: "wiki_prepare_source_ingestion",
  },
  evidenceIr: { modern: "knowledge_evidence_ir", legacy: "wiki_evidence_ir" },
  codeEvidence: { modern: "knowledge_code_evidence", legacy: "wiki_code_evidence" },
  documentPlan: { modern: "knowledge_plan_document", legacy: "wiki_plan_document" },
  sectionContext: { modern: "knowledge_section_context", legacy: "wiki_get_section_context" },
  writeDocument: { modern: "knowledge_write_document", legacy: "wiki_write_document" },
  reviewDocument: { modern: "knowledge_review_document", legacy: "wiki_review_document" },
  exportDocx: { modern: "knowledge_export_docx", legacy: "wiki_export_docx" },
  init: { modern: "knowledge_init", legacy: "wiki_init" },
  writePage: { modern: "wiki_write_page", legacy: "wiki_write_page" },
  editPage: { modern: "wiki_edit_page", legacy: "wiki_edit_page" },
  readPage: { modern: "wiki_read_page", legacy: "wiki_read_page" },
  deletePage: { modern: "wiki_delete_page", legacy: "wiki_delete_page" },
  movePage: { modern: "wiki_move_page", legacy: "wiki_move_page" },
  appendLog: { modern: "wiki_append_log", legacy: "wiki_append_log" },
  search: { modern: "wiki_search", legacy: "wiki_search" },
  graphQuery: { modern: "wiki_graph_query", legacy: "wiki_graph_query" },
  lint: { modern: "wiki_lint", legacy: "wiki_lint" },
  migrate: { modern: "wiki_migrate", legacy: "wiki_migrate" },
} as const;

export type ToolKey = keyof typeof TOOL_NAMES;
export type ModernToolName = (typeof TOOL_NAMES)[ToolKey]["modern"];

export function toolName(key: ToolKey, era: ProtocolEra = "modern"): string {
  return TOOL_NAMES[key][era];
}

export function toolNameForEra(name: ModernToolName, era: ProtocolEra): string {
  const entry = Object.values(TOOL_NAMES).find((candidate) => candidate.modern === name);
  return entry ? entry[era] : name;
}

export function toolReferencesForEra(text: string, era: ProtocolEra): string {
  if (era === "modern") return text;
  return Object.values(TOOL_NAMES).reduce(
    (result, names) => result.replaceAll(names.modern, names.legacy),
    text
  );
}
