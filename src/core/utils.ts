import * as fs from "node:fs/promises";

export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export function timestamp(): string {
  return new Date().toISOString();
}

export async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
}

export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const result = Object.create(null) as Frontmatter;
  if (!match) return result;
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new Error(`Unsafe frontmatter key is not allowed: ${key}`);
      }
      const rawVal = line.slice(colonIdx + 1).trim();
      const arrayMatch = rawVal.match(/^\[(.*)\]$/);
      if (arrayMatch) {
        result[key] = arrayMatch[1]
          .split(",")
          .map((item) => item.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else {
        result[key] = rawVal.replace(/^["']|["']$/g, "");
      }
    }
  }
  return result;
}

export function frontmatterString(
  fm: Frontmatter,
  key: string
): string | undefined {
  const val = fm[key];
  return typeof val === "string" ? val : undefined;
}

export function frontmatterArray(
  fm: Frontmatter,
  key: string
): string[] | undefined {
  const val = fm[key];
  if (Array.isArray(val)) return val;
  if (typeof val === "string") return val ? [val] : [];
  return undefined;
}
