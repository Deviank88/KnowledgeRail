export const CODE_EVIDENCE_INDEX_VERSION = 2 as const;
export const TYPESCRIPT_ADAPTER_VERSION = "typescript-javascript-deterministic-v2";
export const JAVA_ADAPTER_VERSION = "java-deterministic-v1";
export const APEX_ADAPTER_VERSION = "apex-deterministic-v1";
export const CSHARP_ADAPTER_VERSION = "csharp-deterministic-v1";
export const GO_ADAPTER_VERSION = "go-deterministic-v1";
export const RUST_ADAPTER_VERSION = "rust-deterministic-v1";
export const PHP_ADAPTER_VERSION = "php-deterministic-v1";
export const C_ADAPTER_VERSION = "c-deterministic-v2";
export const CPP_ADAPTER_VERSION = "cpp-deterministic-v2";
export const PYTHON_ADAPTER_VERSION = "python-deterministic-v1";
export const KOTLIN_ADAPTER_VERSION = "kotlin-deterministic-v1";
export const SFMETA_ADAPTER_VERSION = "sfmeta-deterministic-v1";
export const RUBY_ADAPTER_VERSION = "ruby-deterministic-v1";

export type CodeFragmentKind =
  | "module"
  | "class"
  | "function"
  | "method"
  | "route"
  | "test"
  | "comment";

export interface CodeSource {
  repositoryRoot: string;
  path: string;
  content: string;
}

export interface CodeRange {
  startLine: number;
  endLine: number;
}

export interface CodeAnchor {
  path: string;
  startLine: number;
  endLine: number;
  rangeHash: string;
  parserVersion: string;
  capturedAt: string;
}

export interface CodeRoute {
  method: string;
  path: string;
  handler?: string;
}

export interface KnowledgeFragment {
  id: string;
  path: string;
  symbol: string;
  qualifiedName: string;
  kind: CodeFragmentKind;
  definition: string;
  range: CodeRange;
  imports: string[];
  references: string[];
  calls: string[];
  routes: CodeRoute[];
  configKeys: string[];
  databaseRefs: string[];
  isTest: boolean;
  docComment?: string;
}

export interface KnowledgeAdapter {
  readonly parserVersion: string;
  supports(source: Pick<CodeSource, "path">): boolean;
  extract(source: CodeSource): Promise<KnowledgeFragment[]>;
}

export interface CodeEvidenceFileRecord {
  path: string;
  contentHash: string;
  fingerprint: string;
  parserVersion: string;
  fragmentIds: string[];
}

export interface CodeEvidenceAdapterRosterEntry {
  extensionClaims: string[];
  parserVersion: string;
}

export interface CodeEvidenceSnapshot {
  version: typeof CODE_EVIDENCE_INDEX_VERSION;
  adapters: CodeEvidenceAdapterRosterEntry[];
  generatedAt: string;
  files: CodeEvidenceFileRecord[];
  fragments: KnowledgeFragment[];
}

export interface CodeSearchOptions {
  maxResults?: number;
  kinds?: CodeFragmentKind[];
  paths?: string[];
}

export interface CodeEvidenceHit {
  fragment: KnowledgeFragment;
  score: number;
  matchedTerms: string[];
  resourceUri: string;
}

export interface CodeReference {
  source: KnowledgeFragment;
  target: KnowledgeFragment;
  relation: "call" | "reference" | "import";
  resourceUri: string;
}

export interface CodeEvidenceUpdateReport {
  scannedFiles: number;
  reusedFiles: number;
  reparsedFiles: number;
  removedFiles: number;
  fragmentCount: number;
}

export interface CodeEvidenceIndex {
  updateFile(path: string): Promise<CodeEvidenceUpdateReport>;
  removeFile(path: string): Promise<CodeEvidenceUpdateReport>;
  search(query: string, options?: CodeSearchOptions): Promise<CodeEvidenceHit[]>;
  symbol(name: string, options?: CodeSearchOptions): Promise<CodeEvidenceHit[]>;
  references(symbolId: string, options?: CodeSearchOptions): Promise<CodeReference[]>;
}

export interface CodeResourceRead {
  uri: string;
  path: string;
  fragmentId: string;
  symbol: string;
  qualifiedName: string;
  kind: CodeFragmentKind;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
  totalCharacters: number;
}

export interface CodeGrepFallbackEvent {
  version: 2;
  timestamp: string;
  query: string;
  reason: string;
  resultCount: number;
  extensionHistogram: Record<string, number>;
}
