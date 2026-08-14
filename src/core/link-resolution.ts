/**
 * Shared parsing and resolution logic for [[wikilinks]] and relative markdown
 * links. Single source of truth for wiki-tools, graph-index, and validation.
 */

export const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;
export const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)#\s]+(?:#[^)\s]*)?)\)/g;

export function isExternalLinkTarget(target: string): boolean {
  return (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("#")
  );
}

export function splitAnchor(target: string): { path: string; anchor: string } {
  const hashIdx = target.indexOf("#");
  return hashIdx >= 0
    ? { path: target.slice(0, hashIdx), anchor: target.slice(hashIdx) }
    : { path: target, anchor: "" };
}

/** Extract [[wikilink]] names, with any `|alias` stripped. */
export function wikiLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(WIKI_LINK_RE)) {
    const target = match[1]?.split("|")[0]?.trim();
    if (target) targets.push(target);
  }
  return targets;
}

/** Extract local markdown link targets (anchors stripped, external URLs skipped). */
export function markdownLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_RE)) {
    const target = match[2];
    if (target && !isExternalLinkTarget(target)) {
      targets.push(splitAnchor(target).path);
    }
  }
  return targets;
}

/** Filenames that may satisfy a [[wikilink]] name (spaces map to `_` or `-`). */
export function wikiLinkFileCandidates(name: string): string[] {
  return [name, name.replace(/ /g, "_"), name.replace(/ /g, "-")].map(
    (value) => `${value}.md`
  );
}

/** Name variants under which a page file can be referenced as [[name]]. */
export function wikiLinkNameVariants(fileBasename: string): string[] {
  return [
    fileBasename,
    fileBasename.replace(/_/g, " "),
    fileBasename.replace(/-/g, " "),
  ];
}

/**
 * All wiki-relative files matching a [[wikilink]] name. Canonical frontmatter
 * titles take precedence; filename variants remain a compatibility fallback.
 */
export function resolveWikiLinkName(
  name: string,
  files: Iterable<string>,
  titlesByPath: ReadonlyMap<string, string> = new Map()
): string[] {
  const normalizedName = name.normalize("NFKC").trim().toLocaleLowerCase();
  const candidates = wikiLinkFileCandidates(name).map((candidate) =>
    candidate.normalize("NFKC").toLocaleLowerCase()
  );
  const matches: string[] = [];
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    const title = titlesByPath.get(normalized) ?? titlesByPath.get(file);
    if (
      title?.normalize("NFKC").trim().toLocaleLowerCase() === normalizedName ||
      candidates.some(
        (candidate) =>
          normalized.toLocaleLowerCase() === candidate ||
          normalized.toLocaleLowerCase().endsWith(`/${candidate}`)
      )
    ) {
      matches.push(file);
    }
  }
  return matches;
}
