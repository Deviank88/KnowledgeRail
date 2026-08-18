import * as fs from "node:fs/promises";
import * as path from "node:path";
import { safeResolveWithin } from "../paths.js";

interface ConfinedRepositoryReadParams {
  repositoryRoot: string;
  repositoryRootReal?: string;
  relativePath: string;
  label?: string;
}

export function readConfinedRepositoryFile(
  params: ConfinedRepositoryReadParams & { missing: "throw" }
): Promise<string>;
export function readConfinedRepositoryFile(
  params: ConfinedRepositoryReadParams & { missing: "null" }
): Promise<string | null>;
export async function readConfinedRepositoryFile(
  params: ConfinedRepositoryReadParams & { missing: "null" | "throw" }
): Promise<string | null> {
  const rootReal = params.repositoryRootReal ?? await fs.realpath(params.repositoryRoot);
  const lexicalTarget = safeResolveWithin(params.repositoryRoot, params.relativePath);
  try {
    const targetReal = await fs.realpath(lexicalTarget);
    const relativeReal = path.relative(rootReal, targetReal);
    const label = params.label ?? "Code anchor";
    if (relativeReal === "" || relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) {
      throw new Error(`${label} resolves outside the repository root: ${params.relativePath}`);
    }
    const stat = await fs.stat(targetReal);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${params.relativePath}`);
    return await fs.readFile(targetReal, "utf8");
  } catch (error: unknown) {
    if (
      params.missing === "null" && error instanceof Error &&
      "code" in error && error.code === "ENOENT"
    ) return null;
    throw error;
  }
}
