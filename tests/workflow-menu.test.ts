import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GUIDED_WORKFLOWS,
  MENU_AREAS,
  MENU_OPERATIONS,
  resolveWorkflowTransition,
  validateWorkflowOutcomeObservation,
  workflowFor,
  type WorkflowOutcome,
} from "../src/mcp/workflows.js";

test("every menu operation resolves to a valid deterministic workflow graph", () => {
  for (const area of MENU_AREAS) {
    assert.ok(MENU_OPERATIONS[area].length > 0, `${area} must expose operations`);
    for (const operation of MENU_OPERATIONS[area]) {
      const workflow = workflowFor(area, operation.id);
      assert.equal(workflow.key, operation.workflowKey);
      assert.ok(workflow.steps.length > 0);
      assert.equal(new Set(workflow.steps.map((step) => step.id)).size, workflow.steps.length);

      const reachable = new Set<string>();
      const pending = [workflow.steps[0]!.id];
      let terminalCount = 0;
      while (pending.length > 0) {
        const stepId = pending.shift()!;
        if (reachable.has(stepId)) continue;
        reachable.add(stepId);
        const transition = resolveWorkflowTransition(workflow, stepId, undefined);
        if (transition.allowedOutcomes.length > 0) {
          for (const outcome of transition.allowedOutcomes) {
            const branch = resolveWorkflowTransition(workflow, stepId, outcome);
            if (branch.complete) terminalCount++;
            if (branch.next) pending.push(branch.next.id);
          }
        } else if (transition.complete) {
          terminalCount++;
        } else if (transition.next) {
          pending.push(transition.next.id);
        }
      }
      assert.equal(reachable.size, workflow.steps.length, `${workflow.key} has unreachable steps`);
      assert.ok(terminalCount > 0, `${workflow.key} has no reachable terminal state`);

      for (const step of workflow.steps) {
        const transition = resolveWorkflowTransition(workflow, step.id, undefined);
        for (const outcome of transition.allowedOutcomes) {
          const branch = resolveWorkflowTransition(workflow, step.id, outcome);
          assert.equal(branch.complete || branch.next !== undefined, true);
        }
      }
      assert.throws(
        () => resolveWorkflowTransition(workflow, "not-a-step", undefined),
        /Unknown step/
      );
    }
  }
  assert.equal(Object.keys(GUIDED_WORKFLOWS).length, 25);
});

test("source ingestion golden trace loops until coverage and only then finalizes", () => {
  const workflow = workflowFor("ingest", "normalized_source");
  const next = (
    completedStepId?: string,
    outcome?: WorkflowOutcome
  ) => resolveWorkflowTransition(workflow, completedStepId, outcome);

  assert.equal(next().next?.id, "plan_source");
  assert.equal(next("plan_source").next?.id, "next_segment");
  assert.deepEqual(next("next_segment").allowedOutcomes, ["more_items", "no_more_items"]);
  assert.equal(next("next_segment", "more_items").next?.id, "record_claims");
  assert.equal(next("record_claims").next?.id, "link_claims");
  assert.equal(next("link_claims").next?.id, "plan_synthesis");
  assert.equal(next("plan_synthesis").next?.id, "synthesize");
  assert.equal(next("synthesize").next?.id, "next_segment");
  assert.equal(next("next_segment", "no_more_items").next?.id, "check_coverage");
  assert.equal(next("check_coverage", "coverage_insufficient").next?.id, "next_segment");
  assert.equal(next("check_coverage", "coverage_sufficient").next?.id, "finalize_source");
  assert.equal(next("finalize_source").complete, true);
  assert.throws(
    () => next("next_segment", "coverage_sufficient"),
    /Outcome .* is invalid/
  );
});

test("read and document traces force explicit sufficiency decisions", () => {
  const read = workflowFor("read", "modify");
  assert.equal(resolveWorkflowTransition(read, undefined, undefined).next?.id, "compile_context");
  assert.equal(resolveWorkflowTransition(read, "compile_context", undefined).next?.id, "read_selected_resources");
  assert.equal(
    resolveWorkflowTransition(read, "read_selected_resources", "coverage_insufficient").next?.id,
    "widen_context"
  );
  assert.equal(resolveWorkflowTransition(read, "widen_context", undefined).next?.id, "read_selected_resources");
  const widening = read.steps.find((step) => step.id === "widen_context");
  assert.match(widening?.instruction ?? "", /raddoppia il budget precedente/);
  assert.equal(widening?.suggestedArguments?.heuristic_token_budget, 4000);
  assert.equal(
    resolveWorkflowTransition(read, "read_selected_resources", "coverage_sufficient").complete,
    true
  );
  assert.equal(
    resolveWorkflowTransition(read, "read_selected_resources", "gaps_declared").complete,
    true
  );

  assert.throws(
    () => validateWorkflowOutcomeObservation(
      read,
      "read_selected_resources",
      "coverage_sufficient",
      { coverageSufficient: false, evidenceGaps: ["truncated_frontier"] }
    ),
    /coverage_sufficient is invalid/
  );
  assert.doesNotThrow(() => validateWorkflowOutcomeObservation(
    read,
    "read_selected_resources",
    "coverage_insufficient",
    { coverageSufficient: false, evidenceGaps: ["truncated_frontier"] }
  ));
  assert.doesNotThrow(() => validateWorkflowOutcomeObservation(
    read,
    "read_selected_resources",
    "gaps_declared",
    { coverageSufficient: false, evidenceGaps: ["required_type:test_result"] }
  ));
  assert.throws(
    () => validateWorkflowOutcomeObservation(
      read,
      "read_selected_resources",
      "coverage_sufficient",
      { coverageSufficient: true }
    ),
    /requires coverage_sufficient and evidence_gaps/
  );

  const document = workflowFor("document", "create");
  assert.equal(
    resolveWorkflowTransition(document, "read_section_resources", "more_items").next?.id,
    "compile_section_context"
  );
  assert.equal(
    resolveWorkflowTransition(document, "read_section_resources", "no_more_items").next?.id,
    "write_document"
  );
  assert.equal(
    resolveWorkflowTransition(document, "review_document", "no_findings").complete,
    true
  );
});

test("migration guidance cannot skip plan and backup before apply", () => {
  const migration = workflowFor("admin", "migrate");
  assert.equal(resolveWorkflowTransition(migration, undefined, undefined).next?.id, "plan_migration");
  assert.deepEqual(
    resolveWorkflowTransition(migration, "plan_migration", undefined).allowedOutcomes,
    ["success", "blocked"]
  );
  assert.equal(
    resolveWorkflowTransition(migration, "plan_migration", "success").next?.id,
    "apply_migration"
  );
  assert.equal(resolveWorkflowTransition(migration, "plan_migration", "blocked").complete, true);
  assert.equal(
    resolveWorkflowTransition(migration, "apply_migration", undefined).next?.id,
    "verify_admin_operation"
  );
  assert.equal(resolveWorkflowTransition(migration, "verify_admin_operation", undefined).complete, true);
  const applyStep = migration.steps.find((step) => step.id === "apply_migration");
  assert.deepEqual(applyStep?.suggestedArguments, {
    action: "apply",
    target_version: "4",
    dry_run: false,
    backup: true,
  });
});
