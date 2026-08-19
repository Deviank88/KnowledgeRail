import { createHash } from "node:crypto";

export function canonicalFixtureText(content: string): string {
  return content.replace(/\r\n?/gu, "\n");
}

export function canonicalFixtureSha256(content: string): string {
  return createHash("sha256").update(canonicalFixtureText(content)).digest("hex");
}
