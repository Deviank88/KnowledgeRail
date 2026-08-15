export const DOCX_TEXT_FONT = {
  ascii: "Arial",
  hAnsi: "Arial",
  eastAsia: "Arial",
  cs: "Arial",
} as const;

export const DOCX_CODE_FONT = {
  ascii: "Courier New",
  hAnsi: "Courier New",
  eastAsia: "Courier New",
  cs: "Courier New",
} as const;

export const DOCX_LANGUAGE = {
  value: "it-IT",
} as const;

const TYPOGRAPHIC_APOSTROPHE = "’";

function matchInitialCase(input: string, replacement: string): string {
  return /^[A-ZÀ-Ö]/.test(input)
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

export function normalizeDocxText(text: string, opts: { typography?: boolean } = {}): string {
  const normalized = text.normalize("NFC");
  if (opts.typography === false) return normalized;

  return normalized
    .replace(/(^|[\s(["])(qual)['’]è(?=$|[\s),.;:!?])/gi, (_match, prefix: string, word: string) => `${prefix}${matchInitialCase(word, "qual")} è`)
    .replace(/(^|[\s(["])(un) pò(?=$|[\s),.;:!?])/gi, (_match, prefix: string, word: string) => `${prefix}${matchInitialCase(word, "un")} po${TYPOGRAPHIC_APOSTROPHE}`)
    .replace(/(^|[\s(["])(perchè)(?=$|[\s),.;:!?])/gi, (_match, prefix: string, word: string) => `${prefix}${matchInitialCase(word, "perché")}`)
    .replace(/(^|[\s(["])(poichè)(?=$|[\s),.;:!?])/gi, (_match, prefix: string, word: string) => `${prefix}${matchInitialCase(word, "poiché")}`)
    .replace(/(^|[\s(["])(affinchè)(?=$|[\s),.;:!?])/gi, (_match, prefix: string, word: string) => `${prefix}${matchInitialCase(word, "affinché")}`)
    .replace(/(^|[\s(["])(nonchè)(?=$|[\s),.;:!?])/gi, (_match, prefix: string, word: string) => `${prefix}${matchInitialCase(word, "nonché")}`)
    .replace(/(^|[\s(["])(sè) stesso(?=$|[\s),.;:!?])/gi, (_match, prefix: string, word: string) => `${prefix}${matchInitialCase(word, "se")} stesso`)
    .replace(/([A-Za-zÀ-ÖØ-öø-ÿ])'([A-Za-zÀ-ÖØ-öø-ÿ])/g, `$1${TYPOGRAPHIC_APOSTROPHE}$2`)
    .replace(/\bpo'(?=$|[\s),.;:!?])/gi, `po${TYPOGRAPHIC_APOSTROPHE}`)
    .replace(/\s--\s/g, " – ")
    .replace(/\s->\s/g, " → ")
    .replace(/\s<-\s/g, " ← ");
}
