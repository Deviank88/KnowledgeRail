import { runDriftCli } from "./drift-cli.js";

export type HookClient = "claude" | "codex" | "cursor";
export type HookEvent = "session" | "post-edit" | "stop";

interface WritableText { write(value: string): unknown }

async function readStdin(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of stream) raw += String(chunk);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function editedPath(payload: Record<string, unknown>): string | undefined {
  if (typeof payload["file_path"] === "string") return payload["file_path"];
  const toolInput = payload["tool_input"];
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    const value = (toolInput as Record<string, unknown>)["file_path"];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function outputFor(client: HookClient, event: HookEvent, message: string): string {
  if (!message) return client === "cursor" ? "{}\n" : "";
  if (client === "cursor") {
    return event === "stop"
      ? "{}\n"
      : `${JSON.stringify({ additional_context: message })}\n`;
  }
  if (event === "stop") return `${JSON.stringify({ systemMessage: message })}\n`;
  const hookEventName = event === "session" ? "SessionStart" : event === "post-edit" ? "PostToolUse" : "Stop";
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: message },
  })}\n`;
}

export async function runHookCli(
  client: HookClient,
  event: HookEvent,
  io: { stdin: NodeJS.ReadableStream; stdout: WritableText; stderr: WritableText } = {
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  },
  runDrift: typeof runDriftCli = runDriftCli
): Promise<number> {
  try {
    const payload = await readStdin(io.stdin);
    const path = event === "post-edit" ? editedPath(payload) : undefined;
    let drift = "";
    let diagnostic = "";
    await runDrift({
      paths: path ? [path] : [],
      format: "text",
      check: false,
      writeLedger: false,
      timeoutMs: event === "post-edit" ? 1_000 : 3_000,
    }, {
      stdout: { write: (value) => { drift += value; } },
      stderr: { write: (value) => { diagnostic += value; } },
    });
    const awareness = event === "session"
      ? "This project uses a KnowledgeRail wiki. Start concrete task work with knowledge_context mode=task and follow its nextAction."
      : "";
    const message = [awareness, drift.trim()].filter(Boolean).join("\n");
    io.stdout.write(outputFor(client, event, message));
    if (diagnostic) io.stderr.write(diagnostic);
    return 0;
  } catch (error) {
    io.stderr.write(`KnowledgeRail hook failed open: ${error instanceof Error ? error.message : String(error)}\n`);
    if (client === "cursor") io.stdout.write("{}\n");
    return 0;
  }
}
