import {
  docsCategoryDir,
  docsDir,
  indexFile,
  logFile,
  schemaFile,
  wikiDir,
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
  const existingSchema = await readFileSafe(schemaFile());
  await ensureDir(wikiDir());
  await ensureDir(docsDir());
  for (const dir of FILE_CATEGORIES) {
    await ensureDir(docsCategoryDir(dir));
  }
  for (const dir of DOC_OPERATIONAL_DIRECTORIES) {
    await ensureDir(docsCategoryDir(dir));
  }
  if (!(await readFileSafe(indexFile()))) {
    await atomicWriteText(indexFile(), DEFAULT_INDEX_MD);
  }
  if (!(await readFileSafe(logFile()))) {
    await atomicWriteText(logFile(), "# Wiki Log\n\n");
  }
  if (force || !existingSchema) {
    await atomicWriteText(schemaFile(), DEFAULT_SCHEMA_MD);
  }
  if (!existingSchema) await initializeWikiState(wikiDir());
}
