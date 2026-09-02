import type { DoctorCliOptions } from "../cli.js";
import { resolveWorkspace } from "../mcp/workspace.js";
import { canonicalizeProjectRoot } from "../mcp/workspace-discovery.js";

interface WritableText {
  write(value: string): unknown;
}

export interface DoctorCliIo {
  stdout: WritableText;
  stderr: WritableText;
}

export interface DoctorCliDependencies {
  resolve?: typeof resolveWorkspace;
  canonicalize?: typeof canonicalizeProjectRoot;
}

const DEFAULT_IO: DoctorCliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

function oneLine(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export async function runDoctorCli(
  options: DoctorCliOptions,
  io: DoctorCliIo = DEFAULT_IO,
  dependencies: DoctorCliDependencies = {}
): Promise<number> {
  const resolve = dependencies.resolve ?? resolveWorkspace;
  const canonicalize = dependencies.canonicalize ?? canonicalizeProjectRoot;
  try {
    const resolution = await resolve({
      explicitRoot: options.root,
      automaticDiscovery: true,
    });
    const canonicalRoot = await canonicalize(resolution.root);
    io.stdout.write([
      "status: ready",
      `workspace_root: ${canonicalRoot}`,
      `workspace_source: ${resolution.source}`,
      "",
    ].join("\n"));
    return 0;
  } catch (error: unknown) {
    io.stderr.write(`status: blocked\nreason: ${oneLine(error)}\n`);
    io.stderr.write("next: run this command inside the project, or pass --root with its absolute path.\n");
    return 2;
  }
}
