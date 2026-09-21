import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import type { ProjectManifestSpec } from "../types.js";
import { cmakeCommands } from "../manifest-cmake.js";

export interface CompileConfig { entries: Array<{ file: string; directories: string[] }>; notices: string[] }

/** Decode literal argv only. Never invoke a shell or expand environment values. */
export function commandArguments(command: string): string[] {
  const tokens: string[] = [];
  let token = "", quote = "", active = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === "\\" && quote !== "'") {
      if (++index >= command.length) throw new Error("Unterminated command escape.");
      token += command[index]; active = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === '"' || char === "'") { quote = char; active = true; }
    else if (/\s/u.test(char)) {
      if (active) tokens.push(token);
      token = ""; active = false;
    } else { token += char; active = true; }
  }
  if (quote) throw new Error("Unterminated command quote.");
  if (active) tokens.push(token);
  return tokens;
}

function repositoryPath(root: string, base: string, value: string): string | undefined {
  if (!value || /[\0$`]/u.test(value)) return;
  const result = relative(root, resolve(base, value));
  if (result === ".." || result.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(result)) return;
  return result.split(process.platform === "win32" ? "\\" : "/").join("/") || ".";
}

export const COMPILE_COMMANDS_MANIFEST: ProjectManifestSpec = {
  fileName: "compile_commands.json",
  parse(content, context): CompileConfig {
    const raw: unknown = JSON.parse(content);
    if (!Array.isArray(raw) || !context) throw new Error("Invalid compilation database.");
    const entries: CompileConfig["entries"] = [], notices = new Set<string>();
    const base = dirname(resolve(context.repositoryRoot, context.manifestPath));
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || typeof entry.file !== "string" || typeof entry.directory !== "string") { notices.add("invalid_compile_entry"); continue; }
      const directory = resolve(base, entry.directory);
      const file = repositoryPath(context.repositoryRoot, directory, entry.file);
      if (!file) { notices.add("external_compile_entry"); continue; }
      try {
        const args: unknown = entry.arguments ?? (typeof entry.command === "string" ? commandArguments(entry.command) : undefined);
        if (!Array.isArray(args) || !args.length || args.some((value) => typeof value !== "string")) throw new Error("Invalid argv.");
        const groups: string[][] = [[], [], [], []];
        for (let index = 1; index < args.length; index++) {
          const arg = args[index] as string;
          if (arg.startsWith("@") || arg === "-I-" || arg === "-iprefix" || arg.startsWith("-iwithprefix")) throw new Error("Dynamic include paths.");
          const match = /^(-iquote|-isystem|-idirafter|-I)(.*)$/u.exec(arg);
          if (!match) continue;
          const value = match[2] || args[++index];
          if (typeof value !== "string" || !value || value.startsWith("=") || /[$`]/u.test(value)) throw new Error("Unsupported include path.");
          const path = repositoryPath(context.repositoryRoot, directory, value);
          if (path === undefined) { notices.add("external_include_directory"); continue; }
          groups[match[1] === "-iquote" ? 0 : match[1] === "-I" ? 1 : match[1] === "-isystem" ? 2 : 3]!.push(path);
        }
        entries.push({ file, directories: [...new Set(groups.flat())] });
      } catch { entries.push({ file, directories: [] }); notices.add("unsupported_compile_entry"); }
    }
    return { entries, notices: [...notices] };
  },
  notices: (value) => (value as CompileConfig).notices,
};

export interface CmakeConfig {
  directories: string[];
  targets: Array<{ files: string[]; directories: string[]; blocked?: boolean }>;
  notices: string[];
  subdirectories: string[];
  blockedGlobal?: boolean;
}

/** Literal commands only. Unsupported declarations fail independently unless an
 * unknown include root can shadow a known one in the same scope. */
export const CMAKE_MANIFEST: ProjectManifestSpec = {
  fileName: "CMakeLists.txt", referenceDepth: 8,
  parse(content): CmakeConfig {
    const directories: string[] = [], subdirectories: string[] = [];
    const targets = new Map<string, { files: string[]; directories: string[]; blocked?: boolean }>();
    const variables = new Map<string, string>();
    const notices = new Set<string>();
    let depth = 0, blockedGlobal = false;
    const literal = (value: string): string | undefined => {
      const expanded = value.replace(/\$\{([A-Za-z_]\w*)\}/gu, (token, name: string) => variables.get(name) ?? token);
      const relative = expanded.replace(/^\$\{CMAKE_CURRENT_(?:SOURCE|LIST)_DIR\}\/?/u, "");
      const checked = relative.replace(/^\$\{(?:PROJECT_SOURCE_DIR|CMAKE_SOURCE_DIR)\}\/?/u, "");
      if (/[\0$<>]/u.test(checked) || posix.isAbsolute(checked) || checked.includes("\\")) return;
      return relative || ".";
    };
    for (const { name, args: rawArgs } of cmakeCommands(content)) {
      if (["if", "foreach", "while", "function", "macro", "block"].includes(name)) { depth++; continue; }
      if (["endif", "endforeach", "endwhile", "endfunction", "endmacro", "endblock"].includes(name)) { depth = Math.max(0, depth - 1); continue; }
      if (name === "set") {
        const key = rawArgs[0];
        if (key) variables.delete(key);
        if (!depth && key && /^[A-Za-z_]\w*$/u.test(key) && rawArgs.length === 2 && !/\$\{/u.test(rawArgs[1]!)) {
          const value = literal(rawArgs[1]!); if (value !== undefined) variables.set(key, value);
        }
        continue;
      }
      if (!["include_directories", "target_include_directories", "add_library", "add_executable", "target_sources", "add_subdirectory"].includes(name)) continue;
      const args = rawArgs.flatMap((value) => value.split(";"));
      if (name === "add_subdirectory") {
        const directory = !depth && args[0] ? literal(args[0]) : undefined;
        if (directory !== undefined && !directory.includes("$")) subdirectories.push(directory);
        else notices.add("unsupported_cmake_subdirectory");
        continue;
      }
      const targetName = name === "include_directories" ? undefined : args.shift();
      if (targetName && !/^[A-Za-z_][\w.-]*$/u.test(targetName)) { notices.add("dynamic_cmake_target"); continue; }
      const target = targetName ? targets.get(targetName) ?? { files: [], directories: [] } : undefined;
      if (targetName && target) targets.set(targetName, target);
      let scope = "PRIVATE", unsupported = depth > 0;
      const values: string[] = [];
      for (const arg of args) {
        if (["PUBLIC", "PRIVATE", "INTERFACE"].includes(arg)) { scope = arg; continue; }
        if (["BEFORE", "AFTER", "SYSTEM", "STATIC", "SHARED", "MODULE", "OBJECT", "EXCLUDE_FROM_ALL", "WIN32", "MACOSX_BUNDLE"].includes(arg)) continue;
        if (scope === "INTERFACE") continue;
        const path = literal(arg);
        if (path === undefined) unsupported = true; else values.push(path);
      }
      if (unsupported) {
        notices.add(depth ? "conditional_cmake_declaration" : "dynamic_cmake_path");
        if (name === "include_directories") blockedGlobal = true;
        if (target) target.blocked = true;
        continue;
      }
      if (name === "include_directories") args.includes("BEFORE") ? directories.unshift(...values) : directories.push(...values);
      else if (target) {
        const output = name === "target_include_directories" ? target.directories : target.files;
        args.includes("BEFORE") ? output.unshift(...values) : output.push(...values);
      }
    }
    if (blockedGlobal || [...targets.values()].some((target) => target.blocked)) notices.add("unknown_cmake_root_may_shadow");
    return { directories, targets: [...targets.values()], notices: [...notices], subdirectories, ...(blockedGlobal ? { blockedGlobal } : {}) };
  },
  references(value, path) {
    return (value as CmakeConfig).subdirectories.map((directory) => {
      const target = posix.normalize(posix.join(posix.dirname(path), directory, "CMakeLists.txt"));
      if (target === ".." || target.startsWith("../")) throw new Error("CMake subdirectory leaves repository.");
      return target;
    });
  },
  notices: (value) => (value as CmakeConfig).notices,
};
