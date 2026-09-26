import * as nodePath from "node:path";
import { atomicWriteText } from "./fs-service.js";
import { estimateProseLanguage } from "./language-detection.js";
import { invalidateManifestEntries } from "./manifest-service.js";
import { listWikiPagePaths } from "./page-record.js";
import { readFileSafe } from "./utils.js";

/**
 * The knowledge language is a stable workspace property: canonical wiki pages are
 * written in it and retrieval queries are expressed in it, while conversations and
 * deliverables follow the user. It lives in the frontmatter of the canonical
 * wiki/SCHEMA.md, so it is versioned and backed up with the knowledge, and it is
 * locked once canonical knowledge exists.
 */
const LANGUAGE_KEY = "knowledge_language";
const LOCKED_KEY = "knowledge_language_locked_at";
const MAX_SURVEY_PAGES = 2_000;

export interface KnowledgeLanguage {
  /** Canonical BCP 47 tag, or null when the workspace has not declared one. */
  tag: string | null;
  /** When the language became immutable for ordinary operations. */
  lockedAt: string | null;
  /** A malformed stored value, reported instead of silently ignored. */
  invalidValue?: string;
}

export interface KnowledgeLanguageSurvey {
  pageCount: number;
  surveyedPages: number;
  /** Confident estimates by primary subtag; `unknown` covers short, mixed or unsupported prose. */
  estimates: Record<string, number>;
  /** Pages whose confident estimate differs from the requested language (bounded sample). */
  mismatchedPages: Array<{ path: string; estimate: string }>;
}

export type KnowledgeLanguageDeclarationState = "declared" | "would_declare" | "unchanged" | "locked";

export interface KnowledgeLanguageDeclaration {
  state: KnowledgeLanguageDeclarationState;
  requested: string;
  previous: KnowledgeLanguage;
  current: KnowledgeLanguage;
  survey: KnowledgeLanguageSurvey;
}

export class KnowledgeLanguageError extends Error {}

export function canonicalLanguageTag(value: string): string {
  const trimmed = value.trim();
  let canonical: string;
  try {
    canonical = trimmed.length > 0 && trimmed.length <= 35 ? Intl.getCanonicalLocales(trimmed)[0] ?? "" : "";
  } catch {
    canonical = "";
  }
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(canonical) || ["und", "mul", "zxx", "mis"].includes(primaryLanguage(canonical))) {
    throw new KnowledgeLanguageError(`Invalid knowledge language "${value}": use one BCP 47 language tag such as en, it or pt-BR.`);
  }
  return canonical;
}

export function primaryLanguage(tag: string): string {
  return tag.split("-")[0]!.toLowerCase();
}

/** The contract compares languages, not regional or script variants. */
export function sameLanguage(left: string, right: string): boolean {
  return primaryLanguage(left) === primaryLanguage(right);
}

function schemaPath(wikiRoot: string): string {
  return nodePath.join(wikiRoot, "SCHEMA.md");
}

function splitSchema(text: string): { fields: string[]; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match
    ? { fields: match[1]!.split(/\r?\n/), body: text.slice(match[0].length) }
    : { fields: [], body: text };
}

function fieldValue(fields: readonly string[], key: string): string | undefined {
  const line = fields.find((item) => item.slice(0, item.indexOf(":")).trim() === key);
  return line === undefined ? undefined : line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
}

export function parseKnowledgeLanguage(schemaText: string | null): KnowledgeLanguage {
  const { fields } = splitSchema(schemaText ?? "");
  const raw = fieldValue(fields, LANGUAGE_KEY);
  const lockedAt = fieldValue(fields, LOCKED_KEY) || null;
  if (!raw) return { tag: null, lockedAt };
  try {
    return { tag: canonicalLanguageTag(raw), lockedAt };
  } catch {
    return { tag: null, lockedAt, invalidValue: raw };
  }
}

/** Rewrites only the knowledge-language fields; other frontmatter and the body are preserved. */
export function withKnowledgeLanguage(schemaText: string, language: Pick<KnowledgeLanguage, "tag" | "lockedAt">): string {
  const { fields, body } = splitSchema(schemaText);
  const kept = fields.filter((item) => ![LANGUAGE_KEY, LOCKED_KEY].includes(item.slice(0, item.indexOf(":")).trim()));
  const added = [
    ...(language.tag ? [`${LANGUAGE_KEY}: ${language.tag}`] : []),
    ...(language.tag && language.lockedAt ? [`${LOCKED_KEY}: ${language.lockedAt}`] : []),
  ];
  const all = [...added, ...kept.filter((item) => item.trim().length > 0)];
  return all.length > 0 ? `---\n${all.join("\n")}\n---\n\n${body.replace(/^\r?\n/, "")}` : body;
}

export async function readKnowledgeLanguage(wikiRoot: string): Promise<KnowledgeLanguage> {
  return parseKnowledgeLanguage(await readFileSafe(schemaPath(wikiRoot)));
}

/** Resolve a page's declared language without letting callers override the workspace contract. */
export async function resolveKnowledgePageLanguage(
  wikiRoot: string,
  declaredLanguage?: string,
  requireDeclaration = false
): Promise<string | null> {
  const knowledge = await readKnowledgeLanguage(wikiRoot);
  if (knowledge.invalidValue) {
    throw new KnowledgeLanguageError(`Invalid stored knowledge language "${knowledge.invalidValue}"; repair the workspace declaration before writing.`);
  }
  const declared = declaredLanguage === undefined ? null : canonicalLanguageTag(declaredLanguage);
  if (knowledge.tag && requireDeclaration && !declared) {
    throw new KnowledgeLanguageError(`Translate the page content into "${knowledge.tag}" and pass content_language="${knowledge.tag}" before writing. No page was changed.`);
  }
  if (knowledge.tag && declared && !sameLanguage(knowledge.tag, declared)) {
    throw new KnowledgeLanguageError(`Page language "${declared}" does not match the workspace knowledge language "${knowledge.tag}". Translate the content into "${knowledge.tag}" before writing; the workspace language cannot be overridden.`);
  }
  return knowledge.tag ?? declared;
}

async function writeKnowledgeLanguage(wikiRoot: string, language: Pick<KnowledgeLanguage, "tag" | "lockedAt">): Promise<void> {
  const current = await readFileSafe(schemaPath(wikiRoot));
  if (current === null) throw new KnowledgeLanguageError("wiki/SCHEMA.md is missing: initialize the workspace first.");
  await atomicWriteText(schemaPath(wikiRoot), withKnowledgeLanguage(current, language));
  await invalidateManifestEntries(wikiRoot, ["SCHEMA.md"]);
}

interface PageEstimates {
  pageCount: number;
  pages: Array<{ path: string; estimate: string | null }>;
}

async function estimatePages(wikiRoot: string): Promise<PageEstimates> {
  const paths = await listWikiPagePaths(wikiRoot);
  const pages = [];
  for (const path of paths.slice(0, MAX_SURVEY_PAGES)) {
    const text = await readFileSafe(nodePath.join(wikiRoot, path));
    pages.push({ path, estimate: text === null ? null : estimateProseLanguage(text).language });
  }
  return { pageCount: paths.length, pages };
}

/** Summarizes page estimates; mismatches are measured against the language the workspace would keep. */
function summarizeSurvey(estimated: PageEstimates, language: string | null): KnowledgeLanguageSurvey {
  const estimates: Record<string, number> = {};
  const mismatchedPages: KnowledgeLanguageSurvey["mismatchedPages"] = [];
  for (const { path, estimate } of estimated.pages) {
    estimates[estimate ?? "unknown"] = (estimates[estimate ?? "unknown"] ?? 0) + 1;
    if (language && estimate && !sameLanguage(estimate, language) && mismatchedPages.length < 20) {
      mismatchedPages.push({ path, estimate });
    }
  }
  return { pageCount: estimated.pageCount, surveyedPages: estimated.pages.length, estimates, mismatchedPages };
}

export async function surveyKnowledgeLanguage(wikiRoot: string, language?: string): Promise<KnowledgeLanguageSurvey> {
  return summarizeSurvey(await estimatePages(wikiRoot), language ?? null);
}

/**
 * Declares the workspace knowledge language. A first declaration is always
 * allowed; changing it is allowed only while no canonical page exists and the
 * language was never locked. Declaring over existing pages locks immediately and
 * reports pages that appear to be in another language: declaring does not convert them.
 * Callers serialize this with page mutations through the wiki mutation lock.
 */
export async function declareKnowledgeLanguage(
  wikiRoot: string,
  value: string,
  options: { apply: boolean; now?: () => string }
): Promise<KnowledgeLanguageDeclaration> {
  const requested = canonicalLanguageTag(value);
  const previous = await readKnowledgeLanguage(wikiRoot);
  const estimated = await estimatePages(wikiRoot);
  const survey = summarizeSurvey(estimated, requested);
  const hasPages = estimated.pageCount > 0;
  const lockedAt = previous.lockedAt ?? (hasPages ? (options.now ?? (() => new Date().toISOString()))() : null);
  if (previous.tag === requested && (previous.lockedAt || !hasPages)) {
    return { state: "unchanged", requested, previous, current: previous, survey };
  }
  if (previous.tag && previous.tag !== requested && (previous.lockedAt || hasPages)) {
    // A refused change keeps the previous language, so report pages against that one.
    return { state: "locked", requested, previous, current: previous, survey: summarizeSurvey(estimated, previous.tag) };
  }
  const current = { tag: requested, lockedAt };
  if (!options.apply) return { state: "would_declare", requested, previous, current, survey };
  await writeKnowledgeLanguage(wikiRoot, current);
  return { state: "declared", requested, previous, current, survey };
}

/** Called after canonical page mutations: the first page makes the declared language immutable. */
export async function lockKnowledgeLanguage(wikiRoot: string, now = () => new Date().toISOString()): Promise<boolean> {
  const language = await readKnowledgeLanguage(wikiRoot);
  if (!language.tag || language.lockedAt) return false;
  await writeKnowledgeLanguage(wikiRoot, { tag: language.tag, lockedAt: now() });
  return true;
}
