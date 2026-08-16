import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const testsDir = path.resolve("tests");
const entries = await readdir(testsDir, { withFileTypes: true });
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => path.join("tests", entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error("No test files found in tests/*.test.ts");
  process.exit(1);
}

const concurrency = Math.min(
  testFiles.length,
  positiveInteger(process.env.TEST_CONCURRENCY, 4)
);
const perFileTimeoutMs = positiveInteger(
  process.env.TEST_FILE_TIMEOUT_MS,
  90000
);
const continueOnFailure = /^(1|true|yes)$/i.test(process.env.CONTINUE_ON_FAILURE ?? "");

console.log(
  `Running ${testFiles.length} test files with concurrency=${concurrency} ` +
  `and per-file timeout=${perFileTimeoutMs} ms`
);

let abortRequested = false;

function printResult(result) {
  const passed = result.code === 0 && !result.signal && !result.timedOut && !result.error;
  const status = passed ? "PASS" : "FAIL";
  console.log(`\n=== ${status} ${result.file} (${result.durationMs.toFixed(0)} ms) ===`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.timedOut) {
    console.error(`${result.file} exceeded ${perFileTimeoutMs} ms.`);
  }
  if (result.signal) {
    console.error(`${result.file} terminated by signal ${result.signal}.`);
  }
  if (result.error) {
    console.error(result.error);
  }
  return passed;
}

function runTestFile(file) {
  return new Promise((resolve) => {
    const start = performance.now();
    console.log(`START ${file}`);

    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", file],
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: process.env,
      }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        file,
        durationMs: performance.now() - start,
        stdout,
        stderr,
        ...result,
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`TIMEOUT ${file} after ${perFileTimeoutMs} ms; terminating child process.`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5000).unref();
    }, perFileTimeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      finish({ code: 1, signal: null, timedOut, error });
    });

    child.once("exit", (code, signal) => {
      finish({ code: code ?? 1, signal, timedOut, error: null });
    });
  });
}

const results = new Array(testFiles.length);
let nextIndex = 0;

async function worker() {
  while (!abortRequested) {
    const index = nextIndex++;
    if (index >= testFiles.length) return;

    const result = await runTestFile(testFiles[index]);
    results[index] = result;
    if (!printResult(result) && !continueOnFailure) {
      abortRequested = true;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const failures = results.filter(Boolean).filter((result) =>
  result.code !== 0 || result.signal || result.timedOut || result.error
);
const skipped = testFiles.filter((_, index) => !results[index]);

if (skipped.length > 0) {
  console.error(`\nSkipped ${skipped.length} test file(s) after fail-fast (set CONTINUE_ON_FAILURE=1 to run all files):`);
  for (const file of skipped) console.error(`- ${file}`);
}

if (failures.length > 0) {
  console.error(`\nTest suite failed: ${failures.length} file(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${testFiles.length} test files passed.`);
