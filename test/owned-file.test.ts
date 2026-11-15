import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwnedFile, readOwnedJson, writeOwnedJson } from "../core/machine/owned-file.mjs";
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

test("an owner-only read keeps the record, a proven absence and a refusal apart", () => {
  const root = mkdtempSync(join(tmpdir(), "owned-read-"));
  const path = join(root, "record.json");
  assert.deepEqual(readOwnedFile(path), { kind: "missing" }, "nothing published yet is an absence");
  writeOwnedJson(path, { kept: true }, { syncDirectory: "required" });
  assert.deepEqual(readOwnedJson(path, value => value), { kind: "present", value: { kept: true } });
  // Bytes that do not decode are a refusal with its reason, never an absence.
  writeFileSync(path, "{\"broken\":");
  assert.equal(readOwnedFile(path).kind, "present", "the read itself succeeded: the text is there to decode");
  const corrupt = readOwnedJson(path, value => value);
  assert.equal(corrupt.kind, "unreadable");
  if (corrupt.kind === "unreadable") assert.match(corrupt.reason, /could not be decoded/);
  // A target another writer left readable is not an owner-only record, and a
  // symlink is refused rather than followed.
  writeOwnedJson(path, { kept: true });
  chmodSync(path, 0o644);
  const readable = readOwnedFile(path);
  assert.equal(readable.kind, "unreadable");
  if (readable.kind === "unreadable") assert.match(readable.reason, /mode 0644 instead of 0600/);
  chmodSync(path, 0o600);
  const link = join(root, "link.json");
  symlinkSync(path, link);
  assert.equal(readOwnedFile(link).kind, "unreadable", "a symlinked record is never followed");
  assert.equal(readOwnedJson(join(root, "absent.json"), value => value).kind, "missing");
});

test("pid liveness keeps permission uncertainty alive and recognizes absent pids", t => {
  assert.equal(pidAlive(process.pid), true);
  const kill = t.mock.method(process, "kill", () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
  assert.equal(pidAlive(42), true);
  kill.mock.mockImplementation(() => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); });
  assert.equal(pidAlive(42), false);
});
