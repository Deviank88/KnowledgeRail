import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { runDoctorCli, type DoctorCliIo } from "../src/runtime/doctor-cli.js";

function capturedIo(): DoctorCliIo & { stdoutText: string; stderrText: string } {
  const capture = {
    stdoutText: "",
    stderrText: "",
    stdout: { write(value: string) { capture.stdoutText += value; } },
    stderr: { write(value: string) { capture.stderrText += value; } },
  };
  return capture;
}

test("doctor reports the canonical root and resolution source", async () => {
  const io = capturedIo();
  const supplied = path.resolve("fixture", "alias");
  const canonical = path.resolve("fixture", "canonical");
  const exitCode = await runDoctorCli({ root: supplied }, io, {
    resolve: async (options) => {
      assert.ok(options);
      assert.equal(options.explicitRoot, supplied);
      assert.equal(options.automaticDiscovery, true);
      return { root: supplied, source: "explicit" };
    },
    canonicalize: async (value) => {
      assert.equal(value, supplied);
      return canonical;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(io.stderrText, "");
  assert.equal(io.stdoutText, [
    "status: ready",
    `workspace_root: ${canonical}`,
    "workspace_source: explicit",
    "",
  ].join("\n"));
});

test("doctor fails with one-line actionable guidance when discovery is unsafe", async () => {
  const io = capturedIo();
  const exitCode = await runDoctorCli({}, io, {
    resolve: async () => {
      throw new Error("Cannot infer a project from the user home directory.\nprivate detail");
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(io.stdoutText, "");
  assert.equal(io.stderrText, [
    "status: blocked",
    "reason: Cannot infer a project from the user home directory. private detail",
    "next: run this command inside the project, or pass --root with its absolute path.",
    "",
  ].join("\n"));
});
