import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { CliUsageError, parseCli } from "../src/cli.js";

test("CLI defaults to path-free stdio", () => {
  assert.deepEqual(parseCli([]), {
    kind: "serve",
    options: {
      transport: "stdio",
      host: "127.0.0.1",
      port: 3333,
      httpPath: "/mcp",
      allowedHosts: [],
      allowedOrigins: [],
    },
  });
});

test("CLI parses the multi-workspace HTTP surface and deduplicates allowlists", () => {
  assert.deepEqual(parseCli([
    "--transport", "http",
    "--host", "127.0.0.1",
    "--port", "4444",
    "--http-path", "/knowledge/mcp",
    "--allowed-host", "LOCALHOST",
    "--allowed-host", "localhost",
    "--allowed-origin", "http://localhost:4444",
  ]), {
    kind: "serve",
    options: {
      transport: "http",
      host: "127.0.0.1",
      port: 4444,
      httpPath: "/knowledge/mcp",
      allowedHosts: ["localhost"],
      allowedOrigins: ["http://localhost:4444"],
    },
  });
});

test("CLI keeps desktop selection separate from automatic IDE binding", () => {
  assert.deepEqual(parseCli(["desktop"]), { kind: "desktop" });
  assert.deepEqual(parseCli(["workspace", "list"]), { kind: "workspace-list" });
  assert.deepEqual(parseCli(["workspace", "register"]), { kind: "workspace-register" });
  assert.deepEqual(parseCli(["workspace", "unregister", "ws_123"]), {
    kind: "workspace-unregister",
    workspaceId: "ws_123",
  });
});

test("CLI accepts an explicit absolute stdio override", () => {
  const root = path.resolve("fixture project");
  const command = parseCli(["--root", root]);
  assert.equal(command.kind, "serve");
  if (command.kind === "serve") assert.equal(command.options.root, root);
});

test("CLI parses hook-safe drift defaults and repeated path scopes", () => {
  assert.deepEqual(parseCli(["drift"]), {
    kind: "drift",
    options: {
      paths: [],
      format: "text",
      check: false,
      writeLedger: true,
      timeoutMs: 3_000,
    },
  });
  const root = path.resolve("fixture project");
  assert.deepEqual(parseCli([
    "drift",
    "--root", root,
    "--path", "src/service.ts",
    "--path", path.join(root, "src", "worker.ts"),
    "--format", "json",
    "--check",
    "--no-ledger",
    "--timeout-ms", "4500",
  ]), {
    kind: "drift",
    options: {
      root,
      paths: ["src/service.ts", path.join(root, "src", "worker.ts")],
      format: "json",
      check: true,
      writeLedger: false,
      timeoutMs: 4_500,
    },
  });
  assert.deepEqual(parseCli(["drift", "--help"]), { kind: "drift-help" });
});

test("CLI rejects ambiguous and unsafe combinations before starting a runtime", () => {
  const invalid = [
    ["--port", "3334"],
    ["--transport", "http", "--root", path.resolve("fixture")],
    ["--transport", "udp"],
    ["--transport", "http", "--port", "0"],
    ["--transport", "http", "--http-path", "/a/../mcp"],
    ["--transport", "http", "--http-path", "/mcp?x=1"],
    ["--transport", "http", "--allowed-origin", "https://example.com/path"],
    ["--transport", "http", "--transport", "stdio"],
    ["workspace", "register", "--unknown"],
    ["drift", "--root", "relative"],
    ["drift", "--format", "xml"],
    ["drift", "--timeout-ms", "0"],
    ["drift", "--timeout-ms", "60001"],
    ["drift", "--check", "--check"],
    ["drift", "--unknown"],
    ["--unknown"],
  ];
  for (const args of invalid) {
    assert.throws(() => parseCli(args), CliUsageError, args.join(" "));
  }
});
