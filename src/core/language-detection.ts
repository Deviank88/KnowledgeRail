import { stripFrontmatter } from "./utils.js";

/**
 * Deterministic prose-language estimate from function-word frequencies. It is a
 * guard for obvious mismatches, not a classifier: languages outside this small
 * profile set, short texts and mixed prose are reported as unknown.
 */
const PROFILES: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set(["the", "and", "of", "to", "is", "are", "was", "were", "that", "this", "with", "for", "from", "by", "on",
    "not", "be", "it", "its", "which", "when", "can", "will", "should", "have", "has", "into", "only", "or", "an",
    "as", "at", "if", "each", "than", "these", "those", "does", "but", "also", "must", "may", "without", "after"]),
  it: new Set(["il", "lo", "gli", "di", "del", "della", "dei", "delle", "che", "non", "per", "sono", "è", "nel",
    "nella", "alla", "anche", "come", "questo", "questa", "quando", "più", "dal", "dalla", "sul", "sulla", "degli",
    "alle", "ai", "essere", "viene", "vengono", "deve", "può", "oppure", "ogni", "tra", "senza", "dopo", "prima"]),
  es: new Set(["el", "los", "las", "que", "para", "por", "es", "son", "está", "como", "pero", "más", "este", "esta",
    "cuando", "puede", "sin", "sobre", "también", "entre", "cada", "sus", "al", "lo", "ser", "hay", "desde"]),
  fr: new Set(["le", "les", "des", "du", "que", "pour", "avec", "est", "sont", "dans", "pas", "ne", "qui", "sur",
    "par", "cette", "ce", "plus", "peut", "aux", "être", "comme", "mais", "sans", "chaque", "entre", "aussi", "où"]),
  de: new Set(["der", "die", "das", "und", "ist", "sind", "nicht", "mit", "für", "von", "den", "dem", "des", "ein",
    "eine", "einen", "auf", "im", "zu", "wird", "werden", "auch", "oder", "wenn", "kann", "bei", "aus", "nach", "sich"]),
  // Words shared with English or Italian ("as", "do", "no", "da") are left out: on a
  // real mixed wiki they made long English pages look ambiguous.
  pt: new Set(["os", "dos", "das", "que", "para", "com", "uma", "um", "não", "é", "são", "em",
    "na", "nos", "nas", "por", "como", "mais", "pode", "sem", "sobre", "também", "quando", "cada", "ao"]),
};

export const DETECTABLE_LANGUAGES = Object.keys(PROFILES);
const MINIMUM_HITS = 8;
const MINIMUM_MARGIN = 1.5;

export interface ProseLanguageEstimate {
  /** Primary language subtag, or null when the estimate is not confident. */
  language: string | null;
  hits: number;
  runnerUp: string | null;
}

function proseOnly(markdown: string): string {
  return stripFrontmatter(markdown)
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\]\([^)\s]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2");
}

export function estimateProseLanguage(markdown: string): ProseLanguageEstimate {
  const counts = new Map<string, number>();
  for (const match of proseOnly(markdown).normalize("NFC").toLowerCase().matchAll(/\p{L}+/gu)) {
    for (const [language, words] of Object.entries(PROFILES)) {
      if (words.has(match[0])) counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const [best, second] = ranked;
  if (!best || best[1] < MINIMUM_HITS || best[1] < (second?.[1] ?? 0) * MINIMUM_MARGIN) {
    return { language: null, hits: best?.[1] ?? 0, runnerUp: best?.[0] ?? null };
  }
  return { language: best[0], hits: best[1], runnerUp: second?.[0] ?? null };
}
