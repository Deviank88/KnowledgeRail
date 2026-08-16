import * as fs from "node:fs/promises";
import * as path from "node:path";
import { evaluateDocumentContracts } from "./document-contract-eval.js";

interface DocumentContractBaseline {
  version: number;
  expectedDocumentTypes: string[];
  minimumContractRegistryCoverage: number;
  minimumTemplateCoverage: number;
  minimumPersonaCoverage: number;
  minimumValidDocumentAcceptanceRate: number;
  minimumInvalidDocumentRejectionRate: number;
  minimumDeliveryReadinessAccuracy: number;
  requireAssetSecurityCase: boolean;
}

async function main(): Promise<void> {
  const baseline = JSON.parse(await fs.readFile(
    path.join(process.cwd(), "benchmarks", "fixtures", "document-contract-baseline-v4.json"),
    "utf8"
  )) as DocumentContractBaseline;
  const report = await evaluateDocumentContracts();
  const metrics = report.metrics;
  const failures: string[] = [];
  const check = (label: string, passed: boolean, actual: unknown) => {
    process.stdout.write(`GATE ${label}=${String(actual)} ${passed ? "PASS" : "FAIL"}\n`);
    if (!passed) failures.push(`${label} failed (actual: ${String(actual)})`);
  };

  check("documentTypes", JSON.stringify(report.documentTypes) === JSON.stringify(baseline.expectedDocumentTypes), report.documentTypes.join(","));
  check("ContractRegistryCoverage", metrics.ContractRegistryCoverage >= baseline.minimumContractRegistryCoverage, metrics.ContractRegistryCoverage);
  check("TemplateCoverage", metrics.TemplateCoverage >= baseline.minimumTemplateCoverage, metrics.TemplateCoverage);
  check("PersonaCoverage", metrics.PersonaCoverage >= baseline.minimumPersonaCoverage, metrics.PersonaCoverage);
  check("ValidDocumentAcceptanceRate", metrics.ValidDocumentAcceptanceRate >= baseline.minimumValidDocumentAcceptanceRate, metrics.ValidDocumentAcceptanceRate);
  check("InvalidDocumentRejectionRate", metrics.InvalidDocumentRejectionRate >= baseline.minimumInvalidDocumentRejectionRate, metrics.InvalidDocumentRejectionRate);
  check("DeliveryReadinessAccuracy", metrics.DeliveryReadinessAccuracy >= baseline.minimumDeliveryReadinessAccuracy, metrics.DeliveryReadinessAccuracy);
  check("assetSecurityRejected", !baseline.requireAssetSecurityCase || report.assetSecurityRejected, report.assetSecurityRejected);
  check(
    "securityCasesRejected",
    report.securityCases.every((result) => result.rejected),
    `${report.securityCases.filter((result) => result.rejected).length}/${report.securityCases.length}`
  );

  if (failures.length > 0) throw new Error(`Document contract gate failed:\n- ${failures.join("\n- ")}`);
  process.stdout.write(`\nDocument contract gate passed (baseline v${baseline.version}).\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
