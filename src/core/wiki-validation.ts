import * as fs from "node:fs/promises";
import { rawDir, rawFilePath } from "./paths.js";
import {
  frontmatterArray,
  frontmatterString,
  parseFrontmatter,
  type Frontmatter,
} from "./utils.js";
import { normalizeEmailDomain, STAKEHOLDER_AFFILIATIONS } from "./stakeholder.js";

export const WIKI_PAGE_TYPES = [
  "entity",
  "stakeholder",
  "concept",
  "summary",
  "comparison",
  "overview",
  "analysis",
  "meeting_note",
  "client_source",
  "candidate_request",
  "request",
  "requirement",
  "implementation",
  "test_result",
  "decision",
  "release",
  "risk",
  "data_model",
  "automation",
  "integration",
  "api",
] as const;

export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number];

export type ValidationSeverity = "ERROR" | "WARN" | "INFO";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
}

export interface WikiPageValidation {
  frontmatter: Frontmatter;
  issues: ValidationIssue[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function issue(
  severity: ValidationSeverity,
  code: string,
  message: string
): ValidationIssue {
  return { severity, code, message };
}

function normalizeSourcePath(source: string): string {
  return source.replace(/^docs[\\/]/, "");
}

export async function validateWikiPageContent(
  content: string,
  opts: { checkSourceExists?: boolean } = {}
): Promise<WikiPageValidation> {
  const issues: ValidationIssue[] = [];
  if (!content.match(/^---\r?\n[\s\S]*?\r?\n---/)) {
    return {
      frontmatter: {},
      issues: [
        issue("ERROR", "FRONTMATTER_MISSING", "Missing YAML frontmatter block."),
      ],
    };
  }

  const frontmatter = parseFrontmatter(content);
  const required = ["title", "type", "tags", "created", "updated", "sources"];
  for (const field of required) {
    if (frontmatter[field] === undefined) {
      issues.push(
        issue("ERROR", "FRONTMATTER_FIELD_MISSING", `Missing required field: ${field}.`)
      );
    }
  }

  const title = frontmatterString(frontmatter, "title");
  if (title !== undefined && title.trim() === "") {
    issues.push(issue("ERROR", "TITLE_EMPTY", "Field title must not be empty."));
  }

  const type = frontmatterString(frontmatter, "type");
  if (type !== undefined && !WIKI_PAGE_TYPES.includes(type as WikiPageType)) {
    issues.push(
      issue(
        "ERROR",
        "TYPE_INVALID",
        `Field type must be one of: ${WIKI_PAGE_TYPES.join(", ")}.`
      )
    );
  }

  const tags = frontmatterArray(frontmatter, "tags");
  if (tags !== undefined && tags.length === 0) {
    issues.push(issue("ERROR", "TAGS_EMPTY", "Field tags must contain at least one tag."));
  }

  for (const dateField of ["created", "updated"]) {
    const value = frontmatterString(frontmatter, dateField);
    if (value !== undefined && !ISO_DATE_RE.test(value)) {
      issues.push(
        issue("ERROR", "DATE_INVALID", `Field ${dateField} must use YYYY-MM-DD format.`)
      );
    }
  }

  const sources = frontmatterArray(frontmatter, "sources");
  if (sources !== undefined) {
    for (const source of sources) {
      const sourceRelPath = normalizeSourcePath(source);
      try {
        const abs = rawFilePath(sourceRelPath);
        if (opts.checkSourceExists) {
          await fs.access(abs);
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        issues.push(
          issue(
            "ERROR",
            "SOURCE_INVALID",
            `Invalid source '${source}'. Sources must stay inside ${rawDir()} and exist. ${reason}`
          )
        );
      }
    }
  }

  if (type === "summary" && sources !== undefined && sources.length === 0) {
    issues.push(
      issue("WARN", "SUMMARY_WITHOUT_SOURCE", "Summary pages should reference at least one source.")
    );
  }

  if (type === "stakeholder") {
    const role = frontmatterString(frontmatter, "role");
    if (frontmatter.role !== undefined && role === undefined) {
      issues.push(issue("ERROR", "STAKEHOLDER_ROLE_INVALID", "Field role must be a string."));
    }
    const organization = frontmatterString(frontmatter, "organization");
    if (frontmatter.organization !== undefined && organization === undefined) {
      issues.push(issue("ERROR", "STAKEHOLDER_ORGANIZATION_INVALID", "Field organization must be a string."));
    }
    const emailDomain = frontmatterString(frontmatter, "email_domain");
    if (frontmatter.email_domain !== undefined && (
      !emailDomain || normalizeEmailDomain(emailDomain) !== emailDomain
    )) {
      issues.push(issue(
        "ERROR",
        "STAKEHOLDER_EMAIL_DOMAIN_INVALID",
        "Field email_domain must contain one normalized domain, never a complete email address."
      ));
    }
    const affiliation = frontmatterString(frontmatter, "affiliation");
    if (frontmatter.affiliation !== undefined && (
      !affiliation || !(STAKEHOLDER_AFFILIATIONS as readonly string[]).includes(affiliation)
    )) {
      issues.push(issue(
        "ERROR",
        "STAKEHOLDER_AFFILIATION_INVALID",
        `Field affiliation must be one of: ${STAKEHOLDER_AFFILIATIONS.join(", ")}.`
      ));
    }
    if (
      (affiliation === "client" || affiliation === "internal") &&
      !emailDomain &&
      (sources?.length ?? 0) === 0
    ) {
      issues.push(issue(
        "ERROR",
        "STAKEHOLDER_AFFILIATION_UNSUPPORTED",
        `Affiliation ${affiliation} requires either an evidence-backed email_domain or a source ` +
          "that explicitly declares the affiliation; otherwise use affiliation: unknown."
      ));
    }
  }

  return { frontmatter, issues };
}

export function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues
    .map((item) => `${item.severity} ${item.code}: ${item.message}`)
    .join("\n");
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "ERROR");
}
