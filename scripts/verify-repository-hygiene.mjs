import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL(".", root),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})\n${Buffer.concat(stderr)}`));
    });
  });
}

const trackedOutput = await run("git", ["ls-files", "-z", "--", "docs/milestones", "milestones"]);
const trackedMilestones = trackedOutput.toString("utf8").split("\0").filter(Boolean);
if (trackedMilestones.length > 0) {
  throw new Error(`Milestone files must remain local and untracked: ${trackedMilestones.join(", ")}`);
}

const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const packagedMilestones = (packageJson.files ?? []).filter((entry) => /(^|\/)milestones?(\/|$)/i.test(entry));
if (packagedMilestones.length > 0) {
  throw new Error(`Milestone files must not be packaged: ${packagedMilestones.join(", ")}`);
}

const ignoreLines = new Set((await readFile(new URL(".gitignore", root), "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim()));
for (const required of ["/milestones/", "/docs/milestones/"]) {
  if (!ignoreLines.has(required)) throw new Error(`.gitignore must contain ${required}`);
}

process.stdout.write("Repository hygiene verified: milestone files are local-only.\n");
