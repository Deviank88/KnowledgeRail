import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import { setWikiRoot } from "../../src/core/paths.js";
import { registerWikiTools } from "../../src/tools/wiki-tools.js";

const [root, oldString, newString] = process.argv.slice(2);
if (!root || !oldString || !newString) throw new Error("edit worker arguments are required");

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

setWikiRoot(root);
const tools = new Map<string, Handler>();
const server = {
  registerTool(name: string, _config: unknown, handler: Handler) {
    tools.set(name, handler);
  },
};
registerWikiTools(server as unknown as McpServer, "modern", {
  // With no cross-process transaction lock all workers read the same original
  // page during this window and their writes overwrite one another.
  afterEditRead: () => delay(100),
});

const result = await tools.get("wiki_edit_page")!({
  path: "concepts/Concurrent.md",
  old_string: oldString,
  new_string: newString,
  replace_all: false,
});
if (result.isError) throw new Error(result.content[0]?.text ?? "edit failed");
