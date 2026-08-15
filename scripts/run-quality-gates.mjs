import { spawn } from "node:child_process";

const gates = [
  "eval:retrieval:gate",
  "eval:hybrid:gate",
  "eval:widening:gate",
  "eval:source-coverage:gate",
  "eval:evidence-ir:gate",
  "eval:code-evidence:gate",
  "eval:recovery:gate",
  "eval:task-context:gate",
  "eval:semantic:gate",
  "eval:migration:gate",
  "eval:editorial:gate",
  "eval:documents:gate",
  "eval:tool-surface:gate",
];

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function runGate(gate) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, ["run", gate], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${gate} failed (${code ?? signal}).`));
    });
  });
}

for (const gate of gates) await runGate(gate);
process.stdout.write(`All ${gates.length} quality gates passed.\n`);
