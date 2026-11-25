import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WebBoard } from "../service/web/web-board";
import {
  readRustPilot,
  rustPilotServiceOptions,
} from "../service/web/rust-pilot";

test("the pilot settings select one canonical repository from an owner-only file", (context) => {
  const scratch = mkdtempSync(join(tmpdir(), "rust-pilot-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const settings = join(scratch, "rust-engine-pilot.json");
  const configured = {
    repository: "example/greeter",
    endpoint: "http://127.0.0.1:43219",
    boardKeyFile: join(scratch, "board.key"),
    inboxKeyFile: join(scratch, "inbox.key"),
    inboxEngine: "test-engine",
  };
  assert.equal(readRustPilot(scratch), null);
  writeFileSync(settings, JSON.stringify(configured), { mode: 0o644 });
  chmodSync(settings, 0o644);
  assert.throws(() => readRustPilot(scratch), /owner-only/);
  chmodSync(settings, 0o600);
  const { repository, ...connection } = configured;
  assert.deepEqual(readRustPilot(scratch), { ...connection, repository });
  writeFileSync(settings, JSON.stringify({ ...connection, drain: true }));
  assert.deepEqual(readRustPilot(scratch), { ...connection, drain: true });
  const other = join(scratch, "other.json");
  renameSync(settings, other);
  symlinkSync(other, settings);
  assert.throws(() => readRustPilot(scratch), /owner-only/);
});

test("invalid pilot settings disable the pilot without stopping startup", (context) => {
  const scratch = mkdtempSync(join(tmpdir(), "rust-pilot-invalid-"));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const log = context.mock.method(console, "error", () => {});
  assert.deepEqual(rustPilotServiceOptions(scratch), {});
  writeFileSync(join(scratch, "rust-engine-pilot.json"), "{", { mode: 0o600 });
  assert.deepEqual(rustPilotServiceOptions(scratch), { rustPilot: null });
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [["Use a valid owner-only rust-engine-pilot.json for the Rust pilot."]],
  );
});

test("the transition board refuses the retired Inbox bridge route", async (context) => {
  const board = new WebBoard({
    host: {
      call: () => assert.fail("the retired route must not enter general board RPC"),
      board: () => null,
      unavailable: () => null,
      subscribe: () => () => {},
    },
    port: 0,
  });
  context.after(() => board.close());
  const port = await board.listen();
  const response = await fetch(`http://127.0.0.1:${port}/api/internal/rust-inbox`, {
    method: "POST",
    headers: { authorization: `Bearer ${"a".repeat(64)}` },
    body: "{}",
  });
  assert.equal(response.status, 404);
});
