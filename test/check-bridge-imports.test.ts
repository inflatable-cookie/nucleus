import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBridgeImports } from "../scripts/check-bridge-imports.mjs";

/**
 * The bridge import gate (Contract 007): type-only imports erase at build
 * time, so they pass the gate even when they name a forbidden module, while
 * value imports of the same module are still refused.
 */

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bridge-imports-"));
  // Keep the root forwarding entry's process owner reachable in every fixture.
  files = { ...files, "hosts/paseo/plugin/index.ts": "export const plugin = true;\n",
    "index.server.ts": `import "./hosts/paseo/plugin";\n${files["index.server.ts"]}` };
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, name.slice(0, name.lastIndexOf("/"))), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  return root;
}

function reachableService(extra: string): Record<string, string> {
  return {
    "index.server.ts": `import { ok } from "./server/service/ok";\nconsole.log(ok);\n${extra}`,
    "server/service/ok.ts": "export const ok = 1;\n",
  };
}

test("a type-only import of a forbidden module passes the gate", () => {
  const root = fixture(reachableService(`import type { Database } from "node:sqlite";\nconsole.log("bridge");\n`));
  try {
    assert.doesNotThrow(() => checkBridgeImports(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an inline type specifier over a forbidden module passes when the whole import is types", () => {
  const root = fixture({
    ...reachableService(""),
    "index.server.ts": `import { ok } from "./server/service/ok";\nimport { type LifecycleSignalKind } from "./shared/lifecycle-signal";\nconsole.log(ok);\n`,
    "shared/lifecycle-signal.ts": "export type LifecycleSignalKind = string;\n",
  });
  try {
    assert.doesNotThrow(() => checkBridgeImports(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an export type re-export of a forbidden module passes the gate", () => {
  const root = fixture(reachableService(`export type { Database } from "node:sqlite";\n`));
  try {
    assert.doesNotThrow(() => checkBridgeImports(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a type-only import is not followed into the forbidden module", () => {
  const root = fixture({
    "index.server.ts": `import { ok } from "./server/service/ok";\nimport type { Store } from "./server/store";\nconsole.log(ok);\n`,
    "server/service/ok.ts": "export const ok = 1;\n",
    "server/store.ts": `import { Database } from "node:sqlite";\nexport type Store = { db: Database };\n`,
  });
  try {
    assert.doesNotThrow(() => checkBridgeImports(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a value import of a forbidden module is refused", () => {
  const root = fixture(reachableService(`import { Database } from "node:sqlite";\nconsole.log(Database);\n`));
  try {
    assert.throws(() => checkBridgeImports(root), /imports forbidden module/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a value import reached through a relative file is refused", () => {
  const root = fixture({
    "index.server.ts": `import { openStore } from "./server/service/ok";\nconsole.log(openStore);\n`,
    "server/service/ok.ts": `import { openStore } from "../store";\nexport { openStore };\n`,
    "server/store.ts": `import { Database } from "node:sqlite";\nexport function openStore() { return new Database(":memory:"); }\n`,
  });
  try {
    assert.throws(() => checkBridgeImports(root), /server\/service\/ok\.ts imports forbidden module \.\.\/store/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mixed type-and-value named import is still a value import", () => {
  const root = fixture({
    "index.server.ts": `import { ok } from "./server/service/ok";\nconsole.log(ok);\n`,
    "server/service/ok.ts": `import { type Store, openStore } from "../store";\nconsole.log(openStore);\nexport const ok = 1;\n`,
    "server/store.ts": `import { Database } from "node:sqlite";\nexport type Store = { db: Database };\nexport function openStore() { return new Database(":memory:"); }\n`,
  });
  try {
    assert.throws(() => checkBridgeImports(root), /imports forbidden module/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const specifier of ["../store", "../git.ts", "../runtime/index", "../hooks"]) {
  test(`relative runtime import ${specifier} is refused even without SQLite`, () => {
    const root = fixture({ ...reachableService(""),
      "server/service/ok.ts": `export { value } from "${specifier}";`,
    });
    assert.throws(() => checkBridgeImports(root), /imports forbidden module/);
  });
}


test("the relocated store is forbidden even without a SQLite import", () => {
  const root = fixture({
    ...reachableService('import { value } from "./core/store/plain";'),
    "core/store/plain.ts": "export const value = 1;",
  });
  try {
    assert.throws(() => checkBridgeImports(root), /imports forbidden module/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
