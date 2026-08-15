import * as os from "node:os";
import * as nodePath from "node:path";

export interface StatePathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function resolveStateDirectory(options: StatePathOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env["KNOWLEDGE_RAIL_STATE_DIR"]?.trim();
  if (override) return nodePath.resolve(override);

  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const appData = env["LOCALAPPDATA"]?.trim() || env["APPDATA"]?.trim();
    return nodePath.resolve(appData || nodePath.join(homeDir, "AppData", "Local"), "KnowledgeRail");
  }
  if (platform === "darwin") {
    return nodePath.join(homeDir, "Library", "Application Support", "KnowledgeRail");
  }
  const xdgState = env["XDG_STATE_HOME"]?.trim();
  return nodePath.resolve(xdgState || nodePath.join(homeDir, ".local", "state"), "knowledge-rail");
}
