import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateDocumentContracts } from "../benchmarks/document-contract-eval.js";

test("every document contract accepts a complete fixture and rejects an incomplete one", () => {
  const report = evaluateDocumentContracts();
  assert.equal(report.metrics.ContractRegistryCoverage, 1);
  assert.equal(report.metrics.TemplateCoverage, 1);
  assert.equal(report.metrics.PersonaCoverage, 1);
  assert.equal(report.metrics.ValidDocumentAcceptanceRate, 1);
  assert.equal(report.metrics.InvalidDocumentRejectionRate, 1);
  assert.equal(report.metrics.ExportReadinessAccuracy, 1);
});
