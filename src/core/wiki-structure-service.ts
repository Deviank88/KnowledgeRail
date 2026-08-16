import {
  getWikiRoot,
  resolveRealWithin,
} from "./paths.js";
import { DEFAULT_INDEX_MD, DEFAULT_SCHEMA_MD } from "../config/templates.js";
import {
  DOC_OPERATIONAL_DIRECTORIES,
  FILE_CATEGORIES,
} from "../config/workspace-layout.js";
import { atomicWriteText } from "./fs-service.js";
import { ensureDir, readFileSafe } from "./utils.js";
import { initializeWikiState } from "./migration-service.js";

export async function ensureWikiStructure(force = false): Promise<void> {
  const projectRoot = getWikiRoot();
  const safeWikiDir = await resolveRealWithin(projectRoot, "wiki");
  const safeDocsDir = await resolveRealWithin(projectRoot, "docs");
  const safeIndex = await resolveRealWithin(safeWikiDir, "index.md");
  const safeLog = await resolveRealWithin(safeWikiDir, "log.md");
  const safeSchema = await resolveRealWithin(safeWikiDir, "SCHEMA.md");
  const existingSchema = await readFileSafe(safeSchema);
  await ensureDir(safeWikiDir);
  await ensureDir(safeDocsDir);
  for (const dir of FILE_CATEGORIES) {
    await ensureDir(await resolveRealWithin(safeDocsDir, dir));
  }
  for (const dir of DOC_OPERATIONAL_DIRECTORIES) {
    await ensureDir(await resolveRealWithin(safeDocsDir, dir));
  }
  if (!(await readFileSafe(safeIndex))) {
    await atomicWriteText(safeIndex, DEFAULT_INDEX_MD);
  }
  if (!(await readFileSafe(safeLog))) {
    await atomicWriteText(safeLog, "# Wiki Log\n\n");
  }
  if (force || !existingSchema) {
    await atomicWriteText(safeSchema, DEFAULT_SCHEMA_MD);
  }
  if (!existingSchema) await initializeWikiState(safeWikiDir);
}
