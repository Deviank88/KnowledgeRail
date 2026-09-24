import type { AnnEngine } from "./types.js";
import { ExactAnnEngine } from "./exact-engine.js";
import { HnswAnnEngine } from "./hnsw-engine.js";
import { LshAnnEngine } from "./lsh-engine.js";

export function configuredAnnEngine(dimensions: number): AnnEngine {
  const kind = process.env["KNOWLEDGE_RAIL_SEMANTIC_ENGINE"] ?? "lsh";
  if (kind === "exact") return new ExactAnnEngine({ dimensions });
  if (kind === "hnsw") return new HnswAnnEngine({ dimensions });
  if (kind === "lsh") return new LshAnnEngine({ dimensions });
  throw new Error("KNOWLEDGE_RAIL_SEMANTIC_ENGINE must be lsh, exact or hnsw.");
}
