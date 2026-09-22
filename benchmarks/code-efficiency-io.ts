import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

export interface IoObservation { operations: Record<string, number>; readBytes: number; writtenBytes: number }
let active: IoObservation | undefined;
let installed = false;
const count = (name: string) => { if (active) active.operations[name] = (active.operations[name] ?? 0) + 1; };
const bytes = (value: unknown) => typeof value === "string" ? Buffer.byteLength(value) : ArrayBuffer.isView(value) ? value.byteLength : 0;

/** Benchmark-only observation of fs/promises and returned file handles. Counts
 * API calls (including failed attempts), not kernel syscalls or physical IO.
 * Callback APIs used by glob discovery are intentionally outside this scope. */
export function installIoObservation(): void {
  if (installed) return;
  installed = true;
  const api = promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of ["readFile", "writeFile", "appendFile", "stat", "lstat", "realpath", "access", "open", "opendir", "readdir", "mkdir", "rename", "unlink", "rm"]) {
    const original = api[name]!;
    api[name] = async (...args) => {
      count(name);
      const result = await original(...args);
      if (active && name === "readFile") active.readBytes += bytes(result);
      if (active && ["writeFile", "appendFile"].includes(name)) active.writtenBytes += bytes(args[1]);
      if (name !== "open") return result;
      return new Proxy(result as object, {
        get(target, property) {
          const method = Reflect.get(target, property, target) as unknown;
          if (typeof method !== "function") return method;
          if (!["read", "readFile", "write", "writeFile", "stat", "sync", "close"].includes(String(property))) return method.bind(target);
          return async (...values: unknown[]) => {
            count(`handle.${String(property)}`);
            const value = await method.apply(target, values);
            if (active) {
              if (property === "read") active.readBytes += value.bytesRead;
              if (property === "readFile") active.readBytes += bytes(value);
              if (property === "write") active.writtenBytes += value.bytesWritten;
              if (property === "writeFile") active.writtenBytes += bytes(values[0]);
            }
            return value;
          };
        },
      });
    };
  }
  syncBuiltinESMExports();
}

export function startIoObservation(): void { active = { operations: {}, readBytes: 0, writtenBytes: 0 }; }
export function finishIoObservation(): IoObservation {
  const result = active!;
  active = undefined;
  return result;
}
