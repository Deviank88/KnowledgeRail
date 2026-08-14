import { createHash } from "node:crypto";
import type { WikiPassage } from "../core/page-record.js";

const PASSAGE_ID_PATTERN = /^p-[0-9a-f]{16}$/;

export function wikiPassageId(passage: Pick<WikiPassage, "heading" | "text">): string {
  const digest = createHash("sha256")
    .update(passage.heading.normalize("NFC"), "utf8")
    .update("\0", "utf8")
    .update(passage.text.normalize("NFC"), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `p-${digest}`;
}

export function isWikiPassageId(value: string): boolean {
  return PASSAGE_ID_PATTERN.test(value);
}
