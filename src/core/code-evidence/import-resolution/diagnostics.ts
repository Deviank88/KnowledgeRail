import { TopResults } from "../../top-results.js";
import type { CodeImportDiagnostics, CodeImportIssue, CodeImportResolutionCounts, UnresolvedCodeImport } from "../types.js";

export const MAX_IMPORT_DIAGNOSTICS = 12;
export const MAX_IMPORT_CANDIDATES = 4;
const MAX_TEXT = 256;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Generation-local accounting, once per (source, specifier), not per fragment
 * or request. Only bounded examples survive construction of the incoming map. */
export class ImportResolutionCollector {
  private examples = new TopResults<UnresolvedCodeImport>(MAX_IMPORT_DIAGNOSTICS, (a, b) =>
    Number(a.status !== "ambiguous") - Number(b.status !== "ambiguous") ||
    compare(a.sourcePath, b.sourcePath) || compare(a.specifier, b.specifier) || compare(a.matchedName, b.matchedName) ||
    compare(a.reason, b.reason) || a.candidateCount - b.candidateCount || compare(a.candidates.join("\0"), b.candidates.join("\0")));
  private issueCount = 0;
  private sourcePath = "";
  private specifier = "";
  private language = "";
  private status: "resolved" | "ambiguous" | "unresolved" = "resolved";
  readonly byLanguage: Record<string, CodeImportResolutionCounts> = Object.create(null);

  constructor(private readonly paths: ReadonlySet<string>) {}

  begin(sourcePath: string, specifier: string, language: string): void {
    this.sourcePath = sourcePath; this.specifier = specifier; this.language = language; this.status = "resolved";
  }

  readonly report = (issue: CodeImportIssue): void => {
    this.issueCount++;
    if (this.status !== "ambiguous") this.status = issue.status;
    let textTruncated = false;
    const bounded = (text: string) => {
      if (text.length <= MAX_TEXT) return text;
      textTruncated = true;
      return text.slice(0, MAX_TEXT - 1) + "…";
    };
    const candidates = new TopResults<string>(MAX_IMPORT_CANDIDATES, compare);
    let candidateCount = 0;
    const unique = Array.isArray(issue.candidates) ? new Set(issue.candidates) : issue.candidates;
    for (const path of unique ?? []) {
      if (!this.paths.has(path)) continue;
      candidateCount++;
      candidates.add(path);
    }
    const example: UnresolvedCodeImport = {
      sourcePath: bounded(this.sourcePath), specifier: bounded(this.specifier), matchedName: bounded(issue.matchedName),
      status: issue.status, reason: issue.reason ?? (issue.status === "ambiguous" ? "multiple_matches" : "not_indexed_or_unsupported"),
      candidates: candidates.sorted().map(bounded), candidateCount,
    };
    if (textTruncated) example.textTruncated = true;
    this.examples.add(example);
  };

  finish(targetCount: number): void {
    if (!targetCount && this.status === "resolved") this.report({ status: "unresolved", matchedName: this.specifier });
    const counts = this.byLanguage[this.language] ??= { resolved: 0, ambiguous: 0, unresolved: 0, partial: 0 };
    counts[this.status]++;
    if (targetCount && this.status !== "resolved") counts.partial++;
  }

  result(): CodeImportDiagnostics {
    const unresolvedImports = this.examples.sorted();
    return { unresolvedImports, unresolvedImportsScope: "indexed_snapshot",
      unresolvedImportsTruncated: this.issueCount > unresolvedImports.length ||
        unresolvedImports.some((issue) => issue.candidateCount > issue.candidates.length || issue.textTruncated) };
  }
}
