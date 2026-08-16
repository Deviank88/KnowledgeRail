import { evaluateToolSurface, loadToolSurfaceBaseline } from "./tool-surface-eval.js";

async function main(): Promise<void> {
  const baseline = await loadToolSurfaceBaseline();
  const report = await evaluateToolSurface(baseline);
  const failures: string[] = [];

  if (baseline.benchmarkSchemaVersion !== 3) {
    failures.push(`unsupported benchmark schema version ${baseline.benchmarkSchemaVersion}`);
  }
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
  if (report.toolsListResultByteReductionPercent < baseline.minimumToolsListResultByteReductionPercent) {
    failures.push(
      `tools/list result reduction ${report.toolsListResultByteReductionPercent} < ` +
      `${baseline.minimumToolsListResultByteReductionPercent}`
    );
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
  if (report.routingRoundTripsSaved < baseline.minimumRoutingRoundTripsSaved) {
    failures.push(`routing round trips saved ${report.routingRoundTripsSaved} < ${baseline.minimumRoutingRoundTripsSaved}`);
  }
  if (report.routingRoundTripReductionPercent < baseline.minimumRoutingRoundTripReductionPercent) {
    failures.push(
      `routing round-trip reduction ${report.routingRoundTripReductionPercent} < ` +
      `${baseline.minimumRoutingRoundTripReductionPercent}`
    );
  }
  if (!report.menuRemoved) failures.push("knowledge_menu remains in the public catalog");
  if (!report.legacyAliasesRemoved) failures.push("a wiki_* alias remains in the public catalog");
  if (!report.officialInstructionsAdvertised) failures.push("server instructions do not advertise direct domain tools and nextAction");
  if (!report.compactContextEvidenceParity) failures.push("compact context changed selected evidence");
  if (!report.compactContextGapParity) failures.push("compact context changed reported gaps");
  if (!report.defaultContextIsCompact) failures.push("knowledge_context does not default to compact output");
  if (report.catalogLanguageViolations.length > 0) {
    failures.push(`Italian terms remain in the public catalog: ${report.catalogLanguageViolations.join(", ")}`);
  }
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
