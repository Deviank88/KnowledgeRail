import * as fs from "node:fs/promises";
import * as path from "node:path";
import { evaluateToolSurface } from "./tool-surface-eval.js";

interface ToolSurfaceBaseline {
  baselineModernCatalogBytes: number;
  maximumModernCatalogBytes: number;
  expectedToolCount: number;
  expectedAreaCount: number;
  minimumOperationCount: number;
  minimumWorkflowToolCoverage: number;
  maximumInvalidTransitions: number;
  maximumGuidanceHeuristicTokens: number;
  maximumOperationChoices: number;
  minimumInitialChoiceReductionPercent: number;
  minimumGuidedChoiceReductionPercent: number;
  minimumGoldenTraceCount: number;
  minimumGoldenTraceAccuracy: number;
  minimumBranchingOutcomeCheckpoints: number;
  minimumCompactContextReductionPercent: number;
  requiredToolNames: string[];
}

async function main(): Promise<void> {
  const baseline = JSON.parse(await fs.readFile(
    path.join(process.cwd(), "benchmarks", "fixtures", "tool-surface-baseline-v4.json"),
    "utf8"
  )) as ToolSurfaceBaseline;
  const report = await evaluateToolSurface(baseline.baselineModernCatalogBytes);
  const failures: string[] = [];

  if (report.modernCatalogBytes > baseline.maximumModernCatalogBytes) {
    failures.push(`catalog ${report.modernCatalogBytes} > ${baseline.maximumModernCatalogBytes} bytes`);
  }
  if (report.toolCount !== baseline.expectedToolCount) {
    failures.push(`tool count ${report.toolCount} != ${baseline.expectedToolCount}`);
  }
  if (report.menuAreaCount !== baseline.expectedAreaCount) {
    failures.push(`menu area count ${report.menuAreaCount} != ${baseline.expectedAreaCount}`);
  }
  if (report.operationCount < baseline.minimumOperationCount) {
    failures.push(`operation count ${report.operationCount} < ${baseline.minimumOperationCount}`);
  }
  if (report.workflowToolCoverage < baseline.minimumWorkflowToolCoverage) {
    failures.push(`workflow tool coverage ${report.workflowToolCoverage} < ${baseline.minimumWorkflowToolCoverage}`);
  }
  if (report.invalidTransitions > baseline.maximumInvalidTransitions) {
    failures.push(`invalid transitions ${report.invalidTransitions} > ${baseline.maximumInvalidTransitions}`);
  }
  if (report.maximumGuidanceHeuristicTokens > baseline.maximumGuidanceHeuristicTokens) {
    failures.push(
      `guidance tokens ${report.maximumGuidanceHeuristicTokens} > ${baseline.maximumGuidanceHeuristicTokens}`
    );
  }
  if (report.maximumOperationChoices > baseline.maximumOperationChoices) {
    failures.push(`maximum operation choices ${report.maximumOperationChoices} > ${baseline.maximumOperationChoices}`);
  }
  if (report.initialChoiceReductionPercent < baseline.minimumInitialChoiceReductionPercent) {
    failures.push(
      `initial choice reduction ${report.initialChoiceReductionPercent} < ${baseline.minimumInitialChoiceReductionPercent}`
    );
  }
  if (report.guidedChoiceReductionPercent < baseline.minimumGuidedChoiceReductionPercent) {
    failures.push(
      `guided choice reduction ${report.guidedChoiceReductionPercent} < ${baseline.minimumGuidedChoiceReductionPercent}`
    );
  }
  if (report.goldenTraceCount < baseline.minimumGoldenTraceCount) {
    failures.push(`golden trace count ${report.goldenTraceCount} < ${baseline.minimumGoldenTraceCount}`);
  }
  if (report.goldenTraceAccuracy < baseline.minimumGoldenTraceAccuracy) {
    failures.push(`golden trace accuracy ${report.goldenTraceAccuracy} < ${baseline.minimumGoldenTraceAccuracy}`);
  }
  if (report.branchingOutcomeCheckpointCount < baseline.minimumBranchingOutcomeCheckpoints) {
    failures.push(
      `branching outcome checkpoints ${report.branchingOutcomeCheckpointCount} < ` +
      baseline.minimumBranchingOutcomeCheckpoints
    );
  }
  if (report.compactContextReductionPercent < baseline.minimumCompactContextReductionPercent) {
    failures.push(
      `compact context reduction ${report.compactContextReductionPercent} < ` +
      baseline.minimumCompactContextReductionPercent
    );
  }
  if (!report.compactContextEvidenceParity) failures.push("compact context changed selected evidence pointers");
  if (!report.compactContextGapParity) failures.push("compact context changed knowledge gaps");
  if (report.maximumNextActionCount !== 1) failures.push("guided steps must return exactly one next action");
  if (!report.officialInstructionsAdvertised) failures.push("server instructions must direct agents to knowledge_menu");
  for (const required of baseline.requiredToolNames) {
    if (!report.toolNames.includes(required)) failures.push(`required tool missing: ${required}`);
  }
  if (!report.toolNames.includes("knowledge_menu")) failures.push("knowledge_menu missing");
  if (report.toolNames.includes("wiki_menu")) failures.push("legacy wiki_menu leaked into modern catalog");
  if (!report.menuReadOnly) failures.push("knowledge_menu must be read-only");
  if (report.contextOutputSchemaAdvertised) {
    failures.push("knowledge_context must not duplicate its variable full/compact payload in the static catalog");
  }

  if (failures.length > 0) {
    throw new Error(`MCP tool-surface gate failed:\n- ${failures.join("\n- ")}\n\n${JSON.stringify(report, null, 2)}`);
  }
  process.stdout.write(`${JSON.stringify({ gate: "pass", ...report }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
