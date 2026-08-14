export type SourceSegmentStatus =
  | "integrated"
  | "duplicate"
  | "irrelevant"
  | "unresolved"
  | "contradicted"
  | "legacy_unverified";

/**
 * Coverage records how a source segment was accounted for. Represented states
 * are derived from the durable Evidence IR; irrelevant/unresolved states may
 * still be recorded directly by the whole-source compiler.
 */
export interface SourceSegmentResolution {
  status: SourceSegmentStatus;
  evidenceRefs?: readonly string[];
  pageRefs?: readonly string[];
  reason?: string;
}

function nonEmpty(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function normalizeSegmentResolution(
  resolution: SourceSegmentResolution
): Required<Pick<SourceSegmentResolution, "status">> & {
  evidenceRefs: string[];
  pageRefs: string[];
  reason?: string;
} {
  const evidenceRefs = nonEmpty(resolution.evidenceRefs);
  const pageRefs = nonEmpty(resolution.pageRefs).map((value) => value.replace(/\\/g, "/"));
  const reason = resolution.reason?.trim() || undefined;

  if (resolution.status === "integrated" && (evidenceRefs.length === 0 || pageRefs.length === 0)) {
    throw new Error("integrated requires at least one evidence ref and one page ref.");
  }
  if (resolution.status === "duplicate" && evidenceRefs.length === 0 && pageRefs.length === 0) {
    throw new Error("duplicate requires an evidence or page target.");
  }
  if (resolution.status === "irrelevant" && !reason) {
    throw new Error("irrelevant requires a reason.");
  }
  if (
    (resolution.status === "unresolved" ||
      resolution.status === "contradicted" ||
      resolution.status === "legacy_unverified") &&
    !reason
  ) {
    throw new Error(`${resolution.status} requires a reason.`);
  }

  return {
    status: resolution.status,
    evidenceRefs,
    pageRefs,
    ...(reason ? { reason } : {}),
  };
}
