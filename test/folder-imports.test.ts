import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  edgeRule,
  folderViolations,
  importEdges,
} from "../scripts/check-folder-imports.mjs";
import {
  checkHostEnvironment,
  hostEnvironmentNames,
} from "../scripts/check-host-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("folder imports match the known violations; remove resolved edges, never add exceptions", () => {
  const known = JSON.parse(
    readFileSync(
      new URL("./fixtures/folder-import-violations.json", import.meta.url),
      "utf8",
    ),
  );
  const actual = folderViolations(root);
  assert.deepEqual(
    actual,
    known,
    "New violations must be fixed; resolved entries must be removed from the known list.",
  );
  console.log(
    `Folder import debt: ${actual.length} known edges (test/fixtures/folder-import-violations.json)`,
  );
});

test("folder rules cover processes, public host indexes and host SDK confinement", () => {
  for (const [from, to, specifier, expected] of [
    [
      "hosts/example/plugin/forwarder.ts",
      "service/example.ts",
      "../../../service/example",
      "plugin-forwarder",
    ],
    [
      "core/review/report.ts",
      "service/main.ts",
      "../../service/main",
      "core-neutral",
    ],
    ["shared/rpc.ts", "core/store/index.ts", "../core/store", "shared-neutral"],
    [
      "hosts/example/plugin/forwarder.ts",
      "core/store/index.ts",
      "../../../core/store",
      "plugin-forwarder",
    ],
    [
      "hosts/example/adapter/client.ts",
      "core/store/index.ts",
      "../../../core/store",
      "host-interface",
    ],
    [
      "hosts/example/adapter/client.ts",
      "core/example.ts",
      "../../../core/example",
      "host-interface",
    ],
    [
      "service/runtime/index.ts",
      "hosts/example/adapter/client.ts",
      "../../hosts/example/adapter/client",
      "host-public-index",
    ],
    [
      "service/runtime/index.ts",
      "hosts/example/index.ts",
      "../../hosts/example",
      null,
    ],
    [
      "service/example.ts",
      "hosts/example/index.mjs",
      "../../hosts/example/index.mjs",
      null,
    ],
    [
      "client/board/card.tsx",
      "hosts/example/index.ts",
      "../../hosts/example",
      "client-neutral",
    ],
    [
      "core/example.ts",
      "@getpaseo/client",
      "@getpaseo/client",
      "host-sdk-location",
    ],
    [
      "hosts/other/index.ts",
      "@getpaseo/client",
      "@getpaseo/client",
      "host-sdk-location",
    ],
    ["hosts/example/index.ts", "@getpaseo/client", "@getpaseo/client", null],
    ["core/review/report.ts", "shared/rpc.ts", "../../shared/rpc", null],
    ["client/board/card.tsx", "client/shell/index.ts", "../shell", null],
  ] as const)
    assert.equal(edgeRule(from, to, specifier), expected, `${from} -> ${to}`);
});

test("parser includes type edges, reexports, dynamic imports and CommonJS without comment/string false positives", () => {
  assert.deepEqual(
    importEdges(
      "fixture.ts",
      `
    // import 'ignored';
    const text = "import 'also-ignored'";
    import type { A } from './types';
    export { value } from './value';
    import './side-effect';
    const a = import('./dynamic');
    const b = require('./common');
    type C = import('./type-expression').C;
  `,
    ),
    [
      "./types",
      "./value",
      "./side-effect",
      "./dynamic",
      "./common",
      "./type-expression",
    ],
  );
});

test("declaration modules enforce type boundaries and resolve declaration targets", () => {
  const fixture = mkdtempSync(join(tmpdir(), "folder-declarations-"));
  const files = {
    "shared/legacy.d.ts": "import type { Core } from '../core/types';",
    "shared/module.d.mts":
      "export type { Host } from '../hosts/example/types.mjs';",
    "shared/common.d.cts": "import Core = require('../core/common.cjs');",
    "core/types.d.ts": "export interface Core {}",
    "core/common.d.cts": "export interface Core {}",
    "core/sdk.d.mts": "export type Client = import('@getpaseo/client').Client;",
    "hosts/example/types.d.mts": "export interface Host {}",
    "shared/allowed.d.mts": "export type { Neutral } from './neutral.mjs';",
    "shared/neutral.d.mts": "export interface Neutral {}",
  };
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), source);
  }
  assert.deepEqual(folderViolations(fixture), [
    "host-sdk-location: core/sdk.d.mts -> @getpaseo/client [@getpaseo/client]",
    "shared-neutral: shared/common.d.cts -> ../core/common.cjs [core/common.d.cts]",
    "shared-neutral: shared/legacy.d.ts -> ../core/types [core/types.d.ts]",
    "shared-neutral: shared/module.d.mts -> ../hosts/example/types.mjs [hosts/example/types.d.mts]",
  ]);
});

test("production host environment follows the published rules", () => {
  assert.deepEqual(checkHostEnvironment(root), []);
});

test("host environment gate rejects planted core literals and confines each host vocabulary", () => {
  const fixture = mkdtempSync(join(tmpdir(), "host-environment-"));
  mkdirSync(join(fixture, "core"));
  writeFileSync(
    join(fixture, "core", "planted.ts"),
    "export const planted = 'T3_PLANTED';",
  );
  assert.deepEqual(checkHostEnvironment(fixture), [
    "core/planted.ts: host environment T3_PLANTED belongs in its host integration (1 occurrences)",
  ]);
  assert.deepEqual(
    hostEnvironmentNames(
      "hosts/example/environment.mjs",
      "const id = process.env.T3_AGENT_ID;",
    ),
    [],
  );
  assert.deepEqual(
    hostEnvironmentNames(
      "hosts/t3code/environment.mjs",
      "const id = process.env.T3_THREAD_ID;",
    ),
    [],
  );
  assert.deepEqual(
    hostEnvironmentNames(
      "hosts/example/environment.mjs",
      "const id = process.env.T3_THREAD_ID;",
    ),
    ["T3_THREAD_ID"],
  );
  assert.deepEqual(
    hostEnvironmentNames(
      "core/constants.ts",
      "const MAX_HOST_CALL_LIMIT = 4; const value = MAX_HOST_CALL_LIMIT;",
    ),
    [],
  );
  assert.deepEqual(
    hostEnvironmentNames("core/escaped.ts", "const key = 'T3_\\u0041GENT_ID';"),
    ["T3_AGENT_ID"],
  );
  assert.deepEqual(
    hostEnvironmentNames(
      "core/env.ts",
      '// T3_AGENT_ID must stay in its host\nconst x = { T3_HOME: "x" };',
    ),
    ["T3_AGENT_ID", "T3_HOME"],
  );
});
