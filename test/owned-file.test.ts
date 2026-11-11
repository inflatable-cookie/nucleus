import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOwnedJson } from "../core/machine/owned-file.mjs";
import { pidAlive } from "../core/machine/pid";
import { writeServiceInfo } from "../service/transport/identity";

test("service identity publication keeps unrelated fixed temporary files and replaces public targets privately", () => {
  const root = mkdtempSync(join(tmpdir(), "owned-file-"));
  const path = join(root, "queue-service.json");
  writeFileSync(`${path}.tmp`, "another writer", { mode: 0o644 });
  writeFileSync(path, "old");
  chmodSync(path, 0o644);
  const value = { protocolVersion: 1, buildId: "a".repeat(40), socketPath: join(root, "service.sock"), credential: "b".repeat(64), pid: process.pid, startedAt: new Date().toISOString() };
  writeServiceInfo(root, value);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), value);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(`${path}.tmp`, "utf8"), "another writer");
  assert.deepEqual(readdirSync(root).sort(), ["queue-service.json", "queue-service.json.tmp"]);
});

test("exclusive publication preserves the first record and cleans failed publication files", () => {
  const root = mkdtempSync(join(tmpdir(), "owned-exclusive-"));
  const path = join(root, "cancel.json");
  writeOwnedJson(path, { first: true }, { exclusive: true, syncDirectory: "required" });
  assert.throws(() => writeOwnedJson(path, { first: false }, { exclusive: true }), { code: "EEXIST" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { first: true });
  mkdirSync(join(root, "directory"));
  assert.throws(() => writeOwnedJson(join(root, "directory"), {}));
  assert.deepEqual(readdirSync(root).sort(), ["cancel.json", "directory"]);
});

test("pid liveness keeps permission uncertainty alive and recognizes absent pids", t => {
  assert.equal(pidAlive(process.pid), true);
  const kill = t.mock.method(process, "kill", () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
  assert.equal(pidAlive(42), true);
  kill.mock.mockImplementation(() => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); });
  assert.equal(pidAlive(42), false);
});
