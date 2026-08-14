import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluateToolSurface } from "./tool-surface-eval.js";

interface Baseline {
  expectedToolCount: number;
  maximumModernCatalogBytes: number;
  maximumHeuristicCatalogTokens: number;
  minimumToolCountReductionPercent: number;
  minimumCatalogByteReductionPercent: number;
  minimumRoutingGoldenCount: number;
  minimumCatalogAffordanceAccuracy: number;
  minimumInvalidCallCount: number;
  minimumInvalidCallRejectionRate: number;
  minimumWorkflowTraceCount: number;
  minimumWorkflowCompletionRate: number;
  requiredToolNames: string[];
  forbiddenToolNames: string[];
}

async function main(): Promise<void> {
  const baselineUrl = new URL("./fixtures/tool-surface-baseline-v4.json", import.meta.url);
  const baseline = JSON.parse(await fs.readFile(fileURLToPath(baselineUrl), "utf8")) as Baseline;
  const report = await evaluateToolSurface();
  const failures: string[] = [];

  if (report.toolCount !== baseline.expectedToolCount) failures.push(`tool count ${report.toolCount} != ${baseline.expectedToolCount}`);
  if (report.modernCatalogBytes > baseline.maximumModernCatalogBytes) {
    failures.push(`catalog bytes ${report.modernCatalogBytes} > ${baseline.maximumModernCatalogBytes}`);
  }
  if (report.heuristicCatalogTokens > baseline.maximumHeuristicCatalogTokens) {
    failures.push(`catalog tokens ${report.heuristicCatalogTokens} > ${baseline.maximumHeuristicCatalogTokens}`);
  }
  if (report.toolCountReductionPercent < baseline.minimumToolCountReductionPercent) {
    failures.push(`tool reduction ${report.toolCountReductionPercent} < ${baseline.minimumToolCountReductionPercent}`);
  }
  if (report.catalogByteReductionPercent < baseline.minimumCatalogByteReductionPercent) {
    failures.push(`catalog reduction ${report.catalogByteReductionPercent} < ${baseline.minimumCatalogByteReductionPercent}`);
  }
  if (report.routingGoldenCount < baseline.minimumRoutingGoldenCount) {
    failures.push(`routing goldens ${report.routingGoldenCount} < ${baseline.minimumRoutingGoldenCount}`);
  }
  if (report.catalogAffordanceAccuracy < baseline.minimumCatalogAffordanceAccuracy) {
    failures.push(`catalog affordance accuracy ${report.catalogAffordanceAccuracy} < ${baseline.minimumCatalogAffordanceAccuracy}`);
  }
  if (report.invalidCallCount < baseline.minimumInvalidCallCount) {
    failures.push(`invalid call cases ${report.invalidCallCount} < ${baseline.minimumInvalidCallCount}`);
  }
  if (report.invalidCallRejectionRate < baseline.minimumInvalidCallRejectionRate) {
    failures.push(`invalid call rejection ${report.invalidCallRejectionRate} < ${baseline.minimumInvalidCallRejectionRate}`);
  }
  if (report.workflowTraceCount < baseline.minimumWorkflowTraceCount) {
    failures.push(`workflow traces ${report.workflowTraceCount} < ${baseline.minimumWorkflowTraceCount}`);
  }
  if (report.workflowCompletionRate < baseline.minimumWorkflowCompletionRate) {
    failures.push(`workflow completion ${report.workflowCompletionRate} < ${baseline.minimumWorkflowCompletionRate}`);
  }
  if (!report.menuRemoved) failures.push("knowledge_menu remains in the public catalog");
  if (!report.legacyAliasesRemoved) failures.push("a wiki_* alias remains in the public catalog");
  if (!report.officialInstructionsAdvertised) failures.push("server instructions do not advertise direct domain tools and nextAction");
  if (!report.compactContextEvidenceParity) failures.push("compact context changed selected evidence");
  if (!report.compactContextGapParity) failures.push("compact context changed reported gaps");
  if (!report.defaultContextIsCompact) failures.push("knowledge_context does not default to compact output");
  for (const required of baseline.requiredToolNames) {
    if (!report.toolNames.includes(required)) failures.push(`required tool missing: ${required}`);
  }
  for (const forbidden of baseline.forbiddenToolNames) {
    if (report.toolNames.includes(forbidden)) failures.push(`forbidden tool advertised: ${forbidden}`);
  }

  if (failures.length > 0) {
    throw new Error(`Agent-native tool-surface gate failed:\n- ${failures.join("\n- ")}\n\n${JSON.stringify(report, null, 2)}`);
  }
  process.stdout.write(`${JSON.stringify({ gate: "pass", ...report }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
